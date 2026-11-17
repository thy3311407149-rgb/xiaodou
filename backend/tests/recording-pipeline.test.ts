import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../app/app.js'
import { ApplicationError } from '../app/core/errors/application-error.js'
import { KnowledgeItemRepository } from '../app/repositories/knowledge-item-repository.js'
import { OperationLogRepository } from '../app/repositories/operation-log-repository.js'
import { RecordingRepository } from '../app/repositories/recording-repository.js'
import { SummaryRepository } from '../app/repositories/summary-repository.js'
import { TaskRepository } from '../app/repositories/task-repository.js'
import type { AsrProvider, AsrSession, AsrStreamEvent, AsrTranscriptSegment } from '../app/services/asr/asr-provider.js'
import { KnowledgeItemService } from '../app/services/knowledge-item-service.js'
import type { LlmClient } from '../app/services/llm/llm-client.js'
import { OperationLogger } from '../app/services/operation-logger.js'
import { RECORDING_INTERRUPTED_MESSAGE, RecordingService } from '../app/services/recording-service.js'
import { SummaryService } from '../app/services/summary-service.js'
import { RecordingTaskHandler } from '../app/services/task/recording-task-handler.js'
import { TaskExecutor } from '../app/services/task-executor.js'
import { closeRepositoryTestDatabase, openRepositoryTestDatabase } from './repository-test-helper.js'

let databaseDirectory = ''
let recordingDirectory = ''

afterEach(async () => {
  if (databaseDirectory) {
    await closeRepositoryTestDatabase(databaseDirectory)
    databaseDirectory = ''
  }
  if (recordingDirectory) {
    await rm(recordingDirectory, { recursive: true, force: true })
    recordingDirectory = ''
  }
})

describe('recording pipeline', () => {
  it('creates, starts, rejects an empty finish, and stores ordered chunks independently of ASR', async () => {
    const context = await openContext({ configured: false })
    const created = await request(context.app).post('/api/recordings').send({ title: '例会' })
    expect(created.status).toBe(201)
    const recordingId = created.body.data.recording.id as string
    expect(created.body.data.recording.status).toBe('CREATED')
    expect(created.body.data.knowledgeItemId).toEqual(expect.any(String))
    expect(context.database.prepare('SELECT COUNT(*) AS count FROM files').get()).toEqual({ count: 0 })

    const started = await request(context.app).post(`/api/recordings/${recordingId}/start`)
    expect(started.status).toBe(200)
    expect(started.body.data.recording.status).toBe('RECORDING')

    const emptyFinish = await request(context.app).post(`/api/recordings/${recordingId}/finish`)
    expect(emptyFinish.status).toBe(400)
    expect(context.recordings.findById(recordingId)?.status).toBe('RECORDING')

    const first = Buffer.from('audio-part-one')
    const second = Buffer.from('audio-part-two')
    const outOfOrder = await request(context.app)
      .post(`/api/recordings/${recordingId}/chunks`)
      .field('sequence', '1')
      .attach('audio', first, { filename: '1.pcm', contentType: 'audio/pcm' })
    expect(outOfOrder.status).toBe(400)

    const savedFirst = await uploadChunk(context.app, recordingId, 0, first)
    const savedSecond = await uploadChunk(context.app, recordingId, 1, second)
    expect(savedFirst.body.data.chunk).toMatchObject({ sequence: 0, asrStatus: 'SKIPPED', byteSize: first.length })
    expect(savedSecond.body.data.chunk.sequence).toBe(1)
    expect(savedFirst.body.data.segments).toEqual([])

    const chunks = context.recordings.listChunks(recordingId)
    expect(chunks.map((chunk) => chunk.sequence)).toEqual([0, 1])
    expect(chunks.map((chunk) => chunk.sha256)).toEqual([sha256(first), sha256(second)])
    await expect(readFile(chunks[0]?.storagePath ?? '')).resolves.toEqual(first)
    await expect(readFile(chunks[1]?.storagePath ?? '')).resolves.toEqual(second)
    const downloaded = await request(context.app).get(`/api/recordings/${recordingId}/chunks/1`)
    expect(downloaded.status).toBe(200)
    expect(Buffer.from(downloaded.body)).toEqual(second)

    const finished = await request(context.app).post(`/api/recordings/${recordingId}/finish`)
    expect(finished.status).toBe(200)
    expect(finished.body.data.recording.status).toBe('ENDED')
    expect(finished.body.data.task).toMatchObject({ taskType: 'PROCESS_RECORDING', status: 'QUEUED', fileId: null })

    await context.executor.processAvailableTasks()
    expect(context.tasks.findById(finished.body.data.task.id)).toMatchObject({
      status: 'FAILED',
      errorCode: 'ASR_UNAVAILABLE',
      retryCount: 0,
    })
    expect(context.recordings.listSegments(recordingId)).toEqual([])
    expect(context.database.prepare('SELECT COUNT(*) AS count FROM summaries').get()).toEqual({ count: 0 })
    await expect(readFile(chunks[0]?.storagePath ?? '')).resolves.toEqual(first)
    expect(context.recordings.findById(recordingId)?.status).toBe('ENDED')
  })

  it('keeps audio when ASR fails and can recover it into a transcript, summary, and knowledge item', async () => {
    const context = await openContext({ configured: true, failPush: true })
    const recordingId = await createStartedRecording(context.app)
    const audio = Buffer.from('kept-audio')
    const failed = await uploadChunk(context.app, recordingId, 0, audio)
    expect(failed.status).toBe(201)
    expect(failed.body.data.chunk.asrStatus).toBe('FAILED')
    const stored = context.recordings.listChunks(recordingId)
    expect(stored).toHaveLength(1)
    await expect(readFile(stored[0]?.storagePath ?? '')).resolves.toEqual(audio)

    const continued = await uploadChunk(context.app, recordingId, 1, Buffer.from('second-audio'))
    expect(continued.status).toBe(201)
    expect(context.recordings.listChunks(recordingId).map((chunk) => chunk.sequence)).toEqual([0, 1])

    const finished = await request(context.app).post(`/api/recordings/${recordingId}/finish`)
    await context.executor.processAvailableTasks()
    expect(context.tasks.findById(finished.body.data.task.id)).toMatchObject({ status: 'FAILED', errorCode: 'ASR_FAILED' })
    await expect(readFile(stored[0]?.storagePath ?? '')).resolves.toEqual(audio)
    expect(context.recordings.listSegments(recordingId)).toEqual([])

    if (!(context.provider instanceof ScriptedAsrProvider)) throw new Error('expected scripted provider')
    context.provider.failPush = false
    const recovered = await request(context.app).post(`/api/recordings/${recordingId}/process`)
    expect(recovered.status).toBe(201)
    await context.executor.processAvailableTasks()

    const task = context.tasks.findById(recovered.body.data.task.id)
    expect(task).toMatchObject({ status: 'SUCCEEDED', currentStep: 'COMPLETED', progress: 100, retryCount: 0 })
    const segments = context.recordings.listSegments(recordingId)
    expect(segments.map((segment) => [segment.content, segment.startTimeMs, segment.endTimeMs, segment.speakerId])).toEqual([
      ['第一句原文', 0, 800, 'spk-1'],
      ['第二句原文', 1000, 1800, null],
    ])
    const summary = context.summaries.findByTaskId(task?.id ?? '')
    expect(summary).toMatchObject({ fileId: null, recordingId, content: '这是一段摘要。' })
    const item = new KnowledgeItemRepository(context.database).findBySource('RECORDING', recordingId)
    expect(item?.status).toBe('ACTIVE')
    expect(context.database.prepare('SELECT summary_id FROM knowledge_item_summaries WHERE knowledge_item_id = ?').get(item?.id)).toEqual({ summary_id: summary?.id })
    expect(context.recordings.listKnowledgePoints(recordingId)).toEqual([
      expect.objectContaining({
        knowledgeItemId: item?.id,
        content: '会议结论',
        startTimeMs: 0,
        endTimeMs: 800,
        speakerId: 'spk-1',
        sourceSegmentId: segments[0]?.id,
      }),
    ])
    expect(context.database.prepare('SELECT COUNT(*) AS count FROM files').get()).toEqual({ count: 0 })
  })

  it('marks an in-progress recording interrupted after restart and keeps the uploaded audio', async () => {
    const context = await openContext({ configured: false })
    const recordingId = await createStartedRecording(context.app)
    const audio = Buffer.from('interrupted-audio!')
    await uploadChunk(context.app, recordingId, 0, audio)
    const path = context.recordings.listChunks(recordingId)[0]?.storagePath ?? ''

    const restarted = new RecordingService({
      recordingRepository: context.recordings,
      taskRepository: context.tasks,
      knowledgeItems: context.knowledgeItems,
      operationLogger: context.operationLogger,
      asrProvider: context.provider,
      recordingDir: recordingDirectory,
    })
    expect(restarted.markInterrupted()).toBe(1)
    expect(context.recordings.findById(recordingId)).toMatchObject({
      status: 'INTERRUPTED',
      errorMessage: RECORDING_INTERRUPTED_MESSAGE,
    })
    await expect(readFile(path)).resolves.toEqual(audio)
    expect(context.tasks.findLatestByRecordingId(recordingId)).toBeNull()
    expect(restarted.markInterrupted()).toBe(0)

    const finished = await request(context.app).post(`/api/recordings/${recordingId}/finish`)
    expect(finished.body.data.recording.status).toBe('ENDED')
    expect(finished.body.data.task.status).toBe('QUEUED')
  })

  it('keeps WebM audio without sending it to ASR as PCM or Opus', async () => {
    let opened = 0
    const context = await openContext({
      configured: true,
      provider: {
        name: 'webm-guard',
        isConfigured: () => true,
        async openSession() {
          opened += 1
          return { async pushAudio() { return [] }, async finish() { return [] } }
        },
      },
    })
    const recordingId = await createStartedRecording(context.app)
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04])
    const saved = await request(context.app)
      .post(`/api/recordings/${recordingId}/chunks`)
      .field('sequence', '0')
      .attach('audio', webm, { filename: '0.webm', contentType: 'audio/webm;codecs=opus' })
    expect(saved.status).toBe(201)
    expect(saved.body.data.chunk.asrStatus).toBe('FAILED')
    expect(opened).toBe(0)
    expect(context.recordings.findById(recordingId)?.errorMessage).toContain('WebM')
    await expect(readFile(context.recordings.listChunks(recordingId)[0]?.storagePath ?? '')).resolves.toEqual(webm)
  })

  it('pauses without accepting more audio, then resumes the sequence', async () => {
    const context = await openContext({ configured: false })
    const recordingId = await createStartedRecording(context.app)
    await uploadChunk(context.app, recordingId, 0, Buffer.from('1234'))
    const paused = await request(context.app).post(`/api/recordings/${recordingId}/pause`)
    expect(paused.body.data.recording.status).toBe('PAUSED')
    const rejected = await uploadChunk(context.app, recordingId, 1, Buffer.from('5678'))
    expect(rejected.status).toBe(400)
    expect(context.recordings.listChunks(recordingId)).toHaveLength(1)
    const resumed = await request(context.app).post(`/api/recordings/${recordingId}/resume`)
    expect(resumed.body.data.recording.status).toBe('RECORDING')
    const next = await uploadChunk(context.app, recordingId, 1, Buffer.from('5678'))
    expect(next.status).toBe(201)
    expect(context.recordings.listChunks(recordingId).map((chunk) => chunk.sequence)).toEqual([0, 1])
  })

  it('stores one final transcript after a partial and finishes ASR before creating the task', async () => {
    const events: AsrStreamEvent[] = []
    let finishCalls = 0
    const context = await openContext({
      configured: true,
      provider: {
        name: 'partial-final',
        isConfigured: () => true,
        async openSession(): Promise<AsrSession> {
          let listener: ((event: AsrStreamEvent) => void) | null = null
          return {
            setListener(next) { listener = next },
            async pushAudio() {
              listener?.({ type: 'partial', segment: { text: '你', startTimeMs: 0, endTimeMs: 200, speakerId: null } })
              listener?.({ type: 'partial', segment: { text: '你好', startTimeMs: 0, endTimeMs: 400, speakerId: null } })
              return [{ text: '你好', startTimeMs: 0, endTimeMs: 800, speakerId: null }]
            },
            async finish() {
              finishCalls += 1
              return []
            },
          }
        },
      },
    })
    const recordingId = await createStartedRecording(context.app)
    context.service.bindNotice(recordingId, (event) => {
      if (event.type === 'transcript.partial' || event.type === 'transcript.final') events.push(event.type === 'transcript.partial'
        ? { type: 'partial', segment: { text: event.text, startTimeMs: event.beginTime, endTimeMs: event.endTime, speakerId: event.speakerId } }
        : { type: 'final', segment: { text: event.text, startTimeMs: event.beginTime, endTimeMs: event.endTime, speakerId: event.speakerId } })
    })
    const audio = Buffer.from('1234')
    const saved = await uploadChunk(context.app, recordingId, 0, audio)
    expect(saved.body.data.chunk.asrStatus).toBe('SUCCEEDED')
    await expect(readFile(context.recordings.listChunks(recordingId)[0]?.storagePath ?? '')).resolves.toEqual(audio)
    expect(events.filter((event) => event.type === 'partial').map((event) => event.segment.text)).toEqual(['你', '你好'])
    expect(context.recordings.listSegments(recordingId)).toHaveLength(1)
    const finished = await request(context.app).post(`/api/recordings/${recordingId}/finish`)
    expect(finishCalls).toBe(1)
    expect(finished.body.data.task.status).toBe('QUEUED')
    expect(context.recordings.listSegments(recordingId)[0]?.content).toBe('你好')
  })

  it('pushes one stable partial id and stores a final that arrives after the audio frame returns', async () => {
    const sink: { listener: ((event: AsrStreamEvent) => void) | null } = { listener: null }
    const context = await openContext({
      configured: true,
      provider: {
        name: 'late-final',
        isConfigured: () => true,
        async openSession(): Promise<AsrSession> {
          return {
            setListener(next) { sink.listener = next },
            async pushAudio() { return [] },
            async finish() { return [] },
          }
        },
      },
    })
    const events: string[] = []
    const recordingId = await createStartedRecording(context.app)
    context.service.bindNotice(recordingId, (event) => {
      if (event.type === 'transcript.partial' || event.type === 'transcript.final') {
        events.push(`${event.type}:${event.segmentId}:${event.text}`)
      }
    })
    await context.service.openPcmStream(recordingId, 16000)
    await context.service.appendChunk(recordingId, {
      sequence: 0,
      audio: Buffer.from('1234'),
      mimeType: 'audio/pcm',
      sampleRate: 16000,
    })
    const emit = sink.listener
    if (!emit) throw new Error('实时识别监听没有注册')
    emit({ type: 'partial', segment: { text: '你', startTimeMs: 0, endTimeMs: 0, speakerId: null } })
    emit({ type: 'partial', segment: { text: '你好', startTimeMs: 0, endTimeMs: 200, speakerId: null } })
    emit({ type: 'final', segment: { text: '你好', startTimeMs: 0, endTimeMs: 800, speakerId: null } })
    emit({ type: 'final', segment: { text: '你好', startTimeMs: 0, endTimeMs: 800, speakerId: null } })
    expect(events).toEqual([
      'transcript.partial:partial:0:你',
      'transcript.partial:partial:0:你好',
      'transcript.final:partial:0:你好',
    ])
    expect(context.recordings.listSegments(recordingId)).toHaveLength(1)
  })

  it('removes audio files and cascades recording rows without breaking foreign keys', async () => {
    const context = await openContext({ configured: true })
    const recordingId = await createStartedRecording(context.app)
    await uploadChunk(context.app, recordingId, 0, Buffer.from('delete-me!'))
    const path = context.recordings.listChunks(recordingId)[0]?.storagePath ?? ''
    await request(context.app).post(`/api/recordings/${recordingId}/finish`)
    await context.executor.processAvailableTasks()
    expect(context.recordings.listSegments(recordingId).length).toBeGreaterThan(0)

    const removed = await request(context.app).delete(`/api/recordings/${recordingId}`)
    expect(removed.status).toBe(200)
    await expect(readFile(path)).rejects.toThrow()
    expect(context.recordings.findById(recordingId)).toBeNull()
    expect(context.database.prepare('SELECT COUNT(*) AS count FROM recording_audio_chunks').get()).toEqual({ count: 0 })
    expect(context.database.prepare('SELECT COUNT(*) AS count FROM transcript_segments').get()).toEqual({ count: 0 })
    expect(context.database.prepare('SELECT COUNT(*) AS count FROM knowledge_points').get()).toEqual({ count: 0 })
    expect(context.database.prepare('SELECT COUNT(*) AS count FROM summaries').get()).toEqual({ count: 0 })
    expect(context.database.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 })
    expect(context.database.prepare(`SELECT status FROM knowledge_items WHERE source_type = 'RECORDING'`).get()).toEqual({ status: 'DELETED' })
    expect(() => context.database.prepare(`
      INSERT INTO recording_audio_chunks (id, recording_id, sequence, storage_path, byte_size, sha256, mime_type)
      VALUES ('chunk_orphan', ?, 0, 'missing.bin', 3, '${'a'.repeat(64)}', 'audio/pcm')
    `).run(recordingId)).toThrow(/FOREIGN KEY/)
  })
})

type TestContext = {
  app: ReturnType<typeof createApp>
  database: Awaited<ReturnType<typeof openRepositoryTestDatabase>>['database']
  recordings: RecordingRepository
  tasks: TaskRepository
  summaries: SummaryRepository
  knowledgeItems: KnowledgeItemService
  operationLogger: OperationLogger
  provider: AsrProvider
  executor: TaskExecutor
  service: RecordingService
}

async function openContext(options: { configured: boolean; failPush?: boolean; provider?: AsrProvider }): Promise<TestContext> {
  const opened = await openRepositoryTestDatabase()
  databaseDirectory = opened.directory
  recordingDirectory = await mkdtemp(join(tmpdir(), 'xiaodou-recordings-'))
  const recordings = new RecordingRepository(opened.database)
  const tasks = new TaskRepository(opened.database)
  const summaries = new SummaryRepository(opened.database)
  const knowledgeItems = new KnowledgeItemService({ database: opened.database })
  const operationLogger = new OperationLogger(new OperationLogRepository(opened.database))
  const provider = options.provider ?? new ScriptedAsrProvider(options.configured, options.failPush ?? false)
  const recordingService = new RecordingService({
    recordingRepository: recordings,
    taskRepository: tasks,
    knowledgeItems,
    operationLogger,
    asrProvider: provider,
    recordingDir: recordingDirectory,
    sampleRate: 16000,
  })
  const summaryService = new SummaryService({
    llmClient: scriptedLlm,
    summaryRepository: summaries,
    operationLogger,
  })
  const executor = new TaskExecutor({
    taskRepository: tasks,
    summaryRepository: summaries,
    summaryService,
    operationLogger,
    handlers: [
      new RecordingTaskHandler({
        taskRepository: tasks,
        recordingRepository: recordings,
        summaryRepository: summaries,
        summaryService,
        knowledgeItems,
        asrProvider: provider,
        sampleRate: 16000,
      }),
    ],
    pollIntervalMs: 20,
  })
  return {
    app: createApp({ recordingService }),
    database: opened.database,
    recordings,
    tasks,
    summaries,
    knowledgeItems,
    operationLogger,
    provider,
    executor,
    service: recordingService,
  }
}

async function createStartedRecording(app: ReturnType<typeof createApp>): Promise<string> {
  const created = await request(app).post('/api/recordings').send({ title: '录音' })
  const recordingId = created.body.data.recording.id as string
  await request(app).post(`/api/recordings/${recordingId}/start`)
  return recordingId
}

function uploadChunk(app: ReturnType<typeof createApp>, recordingId: string, sequence: number, audio: Buffer) {
  return request(app)
    .post(`/api/recordings/${recordingId}/chunks`)
    .field('sequence', String(sequence))
    .attach('audio', audio, { filename: `${sequence}.pcm`, contentType: 'audio/pcm' })
}

function sha256(audio: Buffer): string {
  return createHash('sha256').update(audio).digest('hex')
}

const scriptedLlm: LlmClient = {
  async complete() {
    return {
      content: JSON.stringify({
        title: '录音摘要',
        summary: '这是一段摘要。',
        keyPoints: [{ content: '会议结论', sourceChunkIndexes: [0] }],
        citations: [],
      }),
      modelName: 'test-model',
      inputTokens: 12,
      outputTokens: 8,
    }
  },
}

class ScriptedAsrProvider implements AsrProvider {
  readonly name = 'scripted'
  failPush: boolean

  constructor(private readonly configured: boolean, failPush: boolean) {
    this.failPush = failPush
  }

  isConfigured(): boolean {
    return this.configured
  }

  async openSession(): Promise<AsrSession> {
    if (!this.configured) throw new ApplicationError('ASR_UNAVAILABLE')
    let index = 0
    const failPush = () => this.failPush
    return {
      async pushAudio(): Promise<AsrTranscriptSegment[]> {
        if (failPush()) throw new ApplicationError('ASR_FAILED', { message: '语音识别失败' })
        const startTimeMs = index * 1000
        const text = index === 0 ? '第一句原文' : '第二句原文'
        index += 1
        return [{ text, startTimeMs, endTimeMs: startTimeMs + 800, speakerId: startTimeMs === 0 ? 'spk-1' : null }]
      },
      async finish(): Promise<AsrTranscriptSegment[]> {
        return []
      },
    }
  }
}
