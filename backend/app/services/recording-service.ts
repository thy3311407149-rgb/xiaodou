import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { config } from '../core/config.js'
import { ApplicationError } from '../core/errors/application-error.js'
import { logger } from '../core/logger.js'
import type { Summary } from '../models/summary.js'
import type { Task } from '../models/task.js'
import type { KnowledgePoint, Recording, RecordingAudioChunk, TranscriptSegment } from '../models/recording.js'
import { RecordingRepository } from '../repositories/recording-repository.js'
import { TaskRepository } from '../repositories/task-repository.js'
import { inspectAudio, resamplePcm16le, resolveSampleRate } from './asr/audio-format.js'
import { audioFormatFromMime, type AsrAudioFormat, type AsrProvider, type AsrSession, type AsrTranscriptSegment } from './asr/asr-provider.js'
import { createAsrProvider } from './asr/create-asr-provider.js'
import { KnowledgeItemService } from './knowledge-item-service.js'
import { OperationLogger } from './operation-logger.js'

export const RECORDING_INTERRUPTED_MESSAGE = '录音在进程重启时中断'

export type RecordingNotice =
  | { type: 'session.ready'; recordingId: string; format: AsrAudioFormat; sampleRate: number; channels: 1; encoding: 'pcm_s16le' }
  | { type: 'transcript.partial'; segmentId: string; text: string; beginTime: number; endTime: number; speakerId: string | null; isFinal: false; sequence: number }
  | { type: 'transcript.final'; segmentId: string; id: string; text: string; beginTime: number; endTime: number; speakerId: string | null; isFinal: true; sequence: number }
  | { type: 'asr.status'; status: 'ready' | 'paused' | 'unavailable' | 'finishing' }
  | { type: 'asr.error'; code: string; message: string }
  | { type: 'session.completed'; recordingId: string; task: Task }

export type RecordingServiceDependencies = {
  recordingRepository?: RecordingRepository
  taskRepository?: TaskRepository
  knowledgeItems?: KnowledgeItemService
  operationLogger?: OperationLogger
  asrProvider?: AsrProvider
  recordingDir?: string
  sampleRate?: number
  asrSampleRate?: number
}

export class RecordingService {
  private readonly recordings: RecordingRepository
  private readonly tasks: TaskRepository
  private readonly knowledgeItems: KnowledgeItemService
  private readonly operationLogger: OperationLogger
  private readonly asrProvider: AsrProvider
  private readonly recordingDir: string
  private readonly declaredSampleRate: number | null
  private readonly asrSampleRate: number
  private readonly sessions = new Map<string, AsrSession>()
  private readonly sessionFormats = new Map<string, AsrAudioFormat>()
  private readonly sessionOffsets = new Map<string, number>()
  private readonly listeners = new Map<string, (event: RecordingNotice) => void>()
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly seenFinals = new Map<string, Set<string>>()
  private readonly streamStats = new Map<string, { received: number; sent: number; partials: number; finals: number }>()

  constructor(dependencies: RecordingServiceDependencies = {}) {
    this.recordings = dependencies.recordingRepository ?? new RecordingRepository()
    this.tasks = dependencies.taskRepository ?? new TaskRepository()
    this.knowledgeItems = dependencies.knowledgeItems ?? new KnowledgeItemService()
    this.operationLogger = dependencies.operationLogger ?? new OperationLogger()
    this.asrProvider = dependencies.asrProvider ?? createAsrProvider()
    this.recordingDir = dependencies.recordingDir ?? config.recordingDir
    this.declaredSampleRate = dependencies.sampleRate ?? null
    this.asrSampleRate = dependencies.asrSampleRate ?? config.asrSampleRate
  }

  create(input: { requestId: string; title?: string }): { recording: Recording; knowledgeItemId: string } {
    const title = input.title?.trim() || '录音'
    const id = randomUUID()
    const recording = this.recordings.create({ id, title })
    const item = this.knowledgeItems.ensureForSource({
      sourceType: 'RECORDING',
      sourceId: id,
      title,
      status: 'ACTIVE',
    })
    return { recording, knowledgeItemId: item.id }
  }

  get(id: string): {
    recording: Recording
    chunks: RecordingAudioChunk[]
    segments: TranscriptSegment[]
    knowledgeItemId: string | null
    summary: Summary | null
    task: Task | null
  } {
    const recording = this.require(id)
    const item = this.knowledgeItems.getBySource('RECORDING', id)
    return {
      recording,
      chunks: this.recordings.listChunks(id),
      segments: this.recordings.listSegments(id),
      knowledgeItemId: item?.id ?? null,
      summary: item ? this.knowledgeItems.getCurrentSummary(item.id) : null,
      task: this.tasks.findLatestByRecordingId(id),
    }
  }

  list(input: { page: number; pageSize: number }): {
    items: ReturnType<RecordingRepository['listPage']>['items']
    page: number
    pageSize: number
    total: number
  } {
    const page = this.recordings.listPage(input.pageSize, (input.page - 1) * input.pageSize)
    return { items: page.items, page: input.page, pageSize: input.pageSize, total: page.total }
  }

  bindNotice(id: string, listener: ((event: RecordingNotice) => void) | null): void {
    if (listener) this.listeners.set(id, listener)
    else this.listeners.delete(id)
  }

  async start(id: string): Promise<Recording> {
    const recording = this.require(id)
    if (recording.status !== 'CREATED' && recording.status !== 'INTERRUPTED') {
      throw new ApplicationError('INVALID_RECORDING_STATE', { message: '录音当前状态不允许开始' })
    }
    this.recordings.update(id, {
      status: 'RECORDING',
      startedAt: recording.startedAt ?? new Date().toISOString(),
      errorCode: null,
      errorMessage: null,
    })
    return this.require(id)
  }

  async openPcmStream(id: string, sampleRate: number): Promise<Recording> {
    return this.enqueue(id, () => this.openPcmStreamNow(id, sampleRate))
  }

  async pause(id: string): Promise<Recording> {
    return this.enqueue(id, () => this.pauseNow(id))
  }

  async resume(id: string): Promise<Recording> {
    return this.enqueue(id, () => this.resumeNow(id))
  }

  async appendChunk(id: string, input: { sequence: number; audio: Buffer; mimeType: string; sampleRate?: number }): Promise<{
    chunk: RecordingAudioChunk
    segments: TranscriptSegment[]
  }> {
    return this.enqueue(id, () => this.appendChunkNow(id, input))
  }

  async finish(id: string, requestId: string): Promise<{ recording: Recording; task: Task }> {
    return this.enqueue(id, () => this.finishNow(id, requestId))
  }

  private async openPcmStreamNow(id: string, sampleRate: number): Promise<Recording> {
    const recording = this.require(id)
    if (recording.status !== 'RECORDING') {
      throw new ApplicationError('INVALID_RECORDING_STATE', { message: '录音尚未开始' })
    }
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
      throw new ApplicationError('INVALID_REQUEST', { message: '缺少实际采样率' })
    }
    this.recordings.update(id, { mimeType: 'audio/pcm', sampleRate })
    if (this.sessions.has(id)) {
      this.emit(id, { type: 'session.ready', recordingId: id, format: 'pcm', sampleRate, channels: 1, encoding: 'pcm_s16le' })
      return this.require(id)
    }
    if (!this.asrProvider.isConfigured()) {
      this.emit(id, { type: 'session.ready', recordingId: id, format: 'pcm', sampleRate, channels: 1, encoding: 'pcm_s16le' })
      this.emit(id, { type: 'asr.status', status: 'unavailable' })
      return this.require(id)
    }
    await this.openSession(id, 'pcm', this.asrSampleRate, sampleRate, true)
    this.emit(id, { type: 'session.ready', recordingId: id, format: 'pcm', sampleRate, channels: 1, encoding: 'pcm_s16le' })
    return this.require(id)
  }

  private async pauseNow(id: string): Promise<Recording> {
    const recording = this.require(id)
    if (recording.status !== 'RECORDING') {
      throw new ApplicationError('INVALID_RECORDING_STATE', { message: '录音当前状态不允许暂停' })
    }
    try {
      await this.closeSession(id)
    } catch (error: unknown) {
      this.recordings.update(id, { status: 'PAUSED' })
      throw error
    }
    this.emit(id, { type: 'asr.status', status: 'paused' })
    return this.recordings.update(id, { status: 'PAUSED' }) as Recording
  }

  private async resumeNow(id: string): Promise<Recording> {
    const recording = this.require(id)
    if (recording.status !== 'PAUSED') {
      throw new ApplicationError('INVALID_RECORDING_STATE', { message: '录音当前状态不允许继续' })
    }
    this.recordings.update(id, { status: 'RECORDING', errorCode: null, errorMessage: null })
    this.emit(id, { type: 'asr.status', status: 'ready' })
    return this.require(id)
  }

  private async appendChunkNow(id: string, input: { sequence: number; audio: Buffer; mimeType: string; sampleRate?: number }): Promise<{
    chunk: RecordingAudioChunk
    segments: TranscriptSegment[]
  }> {
    const recording = this.require(id)
    if (recording.status !== 'RECORDING') {
      throw new ApplicationError('INVALID_RECORDING_STATE', { message: '录音尚未开始，不能上传音频' })
    }
    if (!Number.isInteger(input.sequence) || input.sequence < 0) {
      throw new ApplicationError('INVALID_REQUEST', { message: '音频分片序号无效' })
    }
    if (input.audio.length === 0) {
      throw new ApplicationError('INVALID_REQUEST', { message: '音频分片为空' })
    }
    const existing = this.recordings.listChunks(id)
    if (input.sequence !== existing.length) {
      throw new ApplicationError('INVALID_REQUEST', { message: '音频分片序号不连续' })
    }
    const sha256 = createHash('sha256').update(input.audio).digest('hex')
    const storagePath = resolve(this.recordingDir, id, `${input.sequence}.bin`)
    await mkdir(dirname(storagePath), { recursive: true })
    await writeFile(storagePath, input.audio)
    const chunkId = randomUUID()
    let chunk: RecordingAudioChunk
    try {
      chunk = this.recordings.insertChunk({
        id: chunkId,
        recordingId: id,
        sequence: input.sequence,
        storagePath,
        byteSize: input.audio.length,
        sha256,
        mimeType: input.mimeType || 'application/octet-stream',
        asrStatus: 'SKIPPED',
      })
    } catch (error: unknown) {
      await rm(storagePath, { force: true })
      throw error
    }
    if (!recording.mimeType) {
      this.recordings.update(id, { mimeType: chunk.mimeType })
    }
    const stats = this.stats(id)
    stats.received += 1
    logger.info('RECORDING_PCM_STORED', { recordingId: id, sequence: input.sequence, bytes: input.audio.length, receivedFrames: stats.received })
    const inspected = inspectAudio(input.audio, input.mimeType)
    if (!inspected.compatible) {
      return this.keepAudioAfterAsrFailure(id, chunk, inspected.reason)
    }
    const activeFormat = this.sessionFormats.get(id)
    if (activeFormat && activeFormat !== inspected.format) {
      return this.keepAudioAfterAsrFailure(id, chunk, '后续音频与当前识别会话的格式不一致')
    }
    const rate = resolveSampleRate(inspected.sampleRate, input.sampleRate ?? recording.sampleRate ?? this.declaredSampleRate)
    if (!('sampleRate' in rate)) {
      return this.keepAudioAfterAsrFailure(id, chunk, rate.reason)
    }
    if (recording.sampleRate !== rate.sampleRate) {
      this.recordings.update(id, { sampleRate: rate.sampleRate })
    }
    if (!this.asrProvider.isConfigured()) return { chunk, segments: [] }
    try {
      const outbound = inspected.format === 'pcm' ? resamplePcm16le(input.audio, rate.sampleRate, this.asrSampleRate) : input.audio
      const session = this.sessions.get(id) ?? await this.openSession(id, inspected.format, inspected.format === 'pcm' ? this.asrSampleRate : rate.sampleRate, rate.sampleRate, false)
      const recognized = await session.pushAudio(outbound)
      stats.sent += 1
      logger.info('RECORDING_PCM_SENT', {
        recordingId: id,
        sequence: input.sequence,
        bytes: outbound.length,
        sentFrames: stats.sent,
        sessionId: session.sessionId ?? null,
      })
      const segments = this.rememberFinals(id, input.sequence, this.shift(recognized, this.sessionOffsets.get(id) ?? 0))
      this.recordings.updateChunkAsrStatus(chunk.id, 'SUCCEEDED')
      return { chunk: { ...chunk, asrStatus: 'SUCCEEDED' }, segments }
    } catch (error: unknown) {
      const message = error instanceof ApplicationError ? error.message : '语音识别失败'
      const code = error instanceof ApplicationError ? error.code : 'ASR_FAILED'
      this.sessions.delete(id)
      this.sessionFormats.delete(id)
      this.recordings.updateChunkAsrStatus(chunk.id, 'FAILED')
      this.recordings.update(id, { errorCode: code, errorMessage: message })
      this.emit(id, { type: 'asr.error', code, message })
      return { chunk: { ...chunk, asrStatus: 'FAILED' }, segments: [] }
    }
  }

  private async finishNow(id: string, requestId: string): Promise<{ recording: Recording; task: Task }> {
    const recording = this.require(id)
    if (recording.status !== 'RECORDING' && recording.status !== 'PAUSED' && recording.status !== 'INTERRUPTED') {
      throw new ApplicationError('INVALID_RECORDING_STATE', { message: '录音当前状态不允许结束' })
    }
    this.emit(id, { type: 'asr.status', status: 'finishing' })
    await this.closeSession(id)
    if (this.recordings.listChunks(id).length === 0) {
      throw new ApplicationError('INVALID_REQUEST', { message: '录音没有可结束的音频' })
    }
    const ended = this.recordings.update(id, {
      status: 'ENDED',
      endedAt: new Date().toISOString(),
    }) as Recording
    const task = this.createProcessingTask(ended, requestId)
    const stats = this.stats(id)
    logger.info('RECORDING_SESSION_COMPLETED', {
      recordingId: id,
      taskId: task.id,
      receivedFrames: stats.received,
      sentFrames: stats.sent,
      partials: stats.partials,
      finals: stats.finals,
      storedSegments: this.recordings.listSegments(id).length,
    })
    this.emit(id, { type: 'session.completed', recordingId: id, task })
    return { recording: this.require(id), task }
  }

  process(id: string, requestId: string): Task {
    const recording = this.require(id)
    if (recording.status !== 'ENDED') {
      throw new ApplicationError('INVALID_RECORDING_STATE', { message: '录音结束后才能重新处理' })
    }
    if (this.recordings.listChunks(id).length === 0) {
      throw new ApplicationError('INVALID_REQUEST', { message: '录音没有可处理的音频' })
    }
    return this.createProcessingTask(recording, requestId)
  }

  listKnowledgePoints(id: string): KnowledgePoint[] {
    this.require(id)
    return this.recordings.listKnowledgePoints(id)
  }

  async readChunk(id: string, sequence: number): Promise<{ bytes: Buffer; mimeType: string }> {
    this.require(id)
    const chunk = this.recordings.listChunks(id).find((item) => item.sequence === sequence)
    if (!chunk) throw new ApplicationError('RECORDING_NOT_FOUND', { message: '音频分片不存在' })
    try {
      return { bytes: await readFile(chunk.storagePath), mimeType: chunk.mimeType }
    } catch (error: unknown) {
      throw new ApplicationError('TASK_EXECUTION_FAILED', { message: '录音音频文件缺失', cause: error })
    }
  }

  async remove(id: string): Promise<void> {
    const recording = this.require(id)
    if (recording.status === 'RECORDING' || recording.status === 'PAUSED') {
      throw new ApplicationError('INVALID_RECORDING_STATE', { message: '录音进行中，不能删除' })
    }
    const chunks = this.recordings.listChunks(id)
    await this.closeSession(id)
    this.knowledgeItems.markSourceDeleted('RECORDING', id)
    this.recordings.delete(id)
    await Promise.all(chunks.map((chunk) => rm(chunk.storagePath, { force: true })))
    await rm(resolve(this.recordingDir, id), { recursive: true, force: true })
  }

  markInterrupted(): number {
    this.sessions.clear()
    this.sessionFormats.clear()
    this.sessionOffsets.clear()
    return this.recordings.markInterrupted(RECORDING_INTERRUPTED_MESSAGE)
  }

  private keepAudioAfterAsrFailure(id: string, chunk: RecordingAudioChunk, message: string): { chunk: RecordingAudioChunk; segments: TranscriptSegment[] } {
    this.recordings.updateChunkAsrStatus(chunk.id, 'FAILED')
    this.recordings.update(id, { errorCode: 'ASR_FAILED', errorMessage: message })
    this.emit(id, { type: 'asr.error', code: 'ASR_FAILED', message })
    return { chunk: { ...chunk, asrStatus: 'FAILED' }, segments: [] }
  }

  private async openSession(id: string, format: AsrAudioFormat, sessionRate: number, timelineRate: number, includeStoredAudio: boolean): Promise<AsrSession> {
    const existing = this.recordings.listChunks(id)
    const basis = includeStoredAudio ? existing : existing.slice(0, -1)
    const offset = format === 'pcm' ? pcmDurationMs(basis, timelineRate) : 0
    const session = await this.asrProvider.openSession({ format, sampleRate: sessionRate })
    logger.info('RECORDING_ASR_READY', { recordingId: id, sessionId: session.sessionId ?? null, format, sampleRate: sessionRate })
    session.setListener?.((event) => {
      try {
        const beginTime = event.segment.startTimeMs + offset
        const endTime = event.segment.endTimeMs + offset
        const sequence = Math.max(0, this.recordings.listChunks(id).length - 1)
        if (event.type === 'final') {
          this.rememberFinals(id, sequence, this.shift([event.segment], offset))
          return
        }
        this.stats(id).partials += 1
        this.emit(id, {
          type: 'transcript.partial',
          segmentId: `partial:${beginTime}`,
          text: event.segment.text,
          beginTime,
          endTime,
          speakerId: event.segment.speakerId,
          isFinal: false,
          sequence,
        })
      } catch (error: unknown) {
        logger.error('RECORDING_LISTENER_FAILED', {
          recordingId: id,
          errorMessage: error instanceof Error ? error.message : 'listener failed',
        })
      }
    })
    this.sessions.set(id, session)
    this.sessionFormats.set(id, format)
    this.sessionOffsets.set(id, offset)
    return session
  }

  private emit(id: string, event: RecordingNotice): void {
    const listener = this.listeners.get(id)
    logger.info('RECORDING_EVENT_EMIT', {
      recordingId: id,
      type: event.type,
      segmentId: 'segmentId' in event ? event.segmentId : undefined,
      delivered: Boolean(listener),
    })
    listener?.(event)
  }

  private stats(id: string): { received: number; sent: number; partials: number; finals: number } {
    const current = this.streamStats.get(id) ?? { received: 0, sent: 0, partials: 0, finals: 0 }
    this.streamStats.set(id, current)
    return current
  }

  private enqueue<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve()
    const run = previous.then(work, work)
    this.tails.set(id, run.then(() => undefined, () => undefined))
    return run
  }

  private rememberFinals(id: string, sequence: number, recognized: AsrTranscriptSegment[]): TranscriptSegment[] {
    const seen = this.seenFinals.get(id) ?? new Set<string>()
    this.seenFinals.set(id, seen)
    const fresh = recognized.filter((segment) => !seen.has(`${segment.startTimeMs}:${segment.endTimeMs}:${segment.text}`))
    const segments = this.storeSegments(id, sequence, fresh)
    for (const segment of segments) seen.add(`${segment.startTimeMs}:${segment.endTimeMs}:${segment.content}`)
    this.stats(id).finals += segments.length
    this.emitFinals(id, sequence, segments)
    return segments
  }

  private emitFinals(id: string, sequence: number, segments: TranscriptSegment[]): void {
    for (const segment of segments) {
      this.emit(id, {
        type: 'transcript.final',
        segmentId: `partial:${segment.startTimeMs}`,
        id: segment.id,
        text: segment.content,
        beginTime: segment.startTimeMs,
        endTime: segment.endTimeMs,
        speakerId: segment.speakerId,
        isFinal: true,
        sequence,
      })
    }
  }

  private shift(segments: AsrTranscriptSegment[], offset: number): AsrTranscriptSegment[] {
    if (offset === 0) return segments
    return segments.map((segment) => ({
      ...segment,
      startTimeMs: segment.startTimeMs + offset,
      endTimeMs: segment.endTimeMs + offset,
    }))
  }

  private createProcessingTask(recording: Recording, requestId: string): Task {
    if (this.tasks.findActiveByRecordingId(recording.id)) {
      throw new ApplicationError('TASK_ALREADY_RUNNING', { message: '当前录音已有正在执行的任务' })
    }
    try {
      const task = this.tasks.create({
        id: randomUUID(),
        recordingId: recording.id,
        taskType: 'PROCESS_RECORDING',
        requestId,
      })
      this.operationLogger.log({
        requestId,
        taskId: task.id,
        fileId: null,
        operation: 'TASK_CREATED',
        status: 'SUCCEEDED',
      })
      return task
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : ''
      if (message.includes('ux_tasks_one_active_per_recording') || message.includes('tasks.recording_id')) {
        throw new ApplicationError('TASK_ALREADY_RUNNING', { message: '当前录音已有正在执行的任务', cause: error })
      }
      throw error
    }
  }

  private storeSegments(recordingId: string, audioSequence: number, recognized: Array<{ text: string; startTimeMs: number; endTimeMs: number; speakerId: string | null }>): TranscriptSegment[] {
    if (recognized.length === 0) return []
    const start = this.recordings.listSegments(recordingId).length
    const rows = recognized.map((segment, offset) => ({
      id: randomUUID(),
      recordingId,
      segmentIndex: start + offset,
      audioSequence,
      content: segment.text,
      startTimeMs: segment.startTimeMs,
      endTimeMs: segment.endTimeMs,
      speakerId: segment.speakerId,
    }))
    this.recordings.appendSegments(rows)
    return this.recordings.listSegments(recordingId).slice(start)
  }

  private async closeSession(id: string): Promise<void> {
    const session = this.sessions.get(id)
    const offset = this.sessionOffsets.get(id) ?? 0
    this.sessions.delete(id)
    this.sessionFormats.delete(id)
    if (!session) return
    const stats = this.stats(id)
    try {
      const recognized = await session.finish()
      this.rememberFinals(id, Math.max(0, this.recordings.listChunks(id).length - 1), this.shift(recognized, offset))
      logger.info('RECORDING_ASR_CLOSED', {
        recordingId: id,
        receivedFrames: stats.received,
        sentFrames: stats.sent,
        partials: stats.partials,
        finals: stats.finals,
        outcome: 'finished',
      })
    } catch (error: unknown) {
      const message = error instanceof ApplicationError ? error.message : '语音识别失败'
      const code = error instanceof ApplicationError ? error.code : 'ASR_FAILED'
      const liveFinals = this.recordings.listSegments(id).length
      logger.error('RECORDING_ASR_CLOSED', {
        recordingId: id,
        receivedFrames: stats.received,
        sentFrames: stats.sent,
        partials: stats.partials,
        finals: stats.finals,
        liveFinals,
        outcome: liveFinals > 0 ? 'finished-with-provider-error' : 'recovery',
        errorCode: code,
        errorMessage: message,
      })
      if (liveFinals === 0) this.recordings.update(id, { errorCode: code, errorMessage: message })
    }
  }

  private require(id: string): Recording {
    const recording = this.recordings.findById(id)
    if (!recording || recording.status === 'DELETED') throw new ApplicationError('RECORDING_NOT_FOUND')
    return recording
  }
}

function pcmDurationMs(chunks: readonly { byteSize: number }[], sampleRate: number): number {
  const bytes = chunks.reduce((total, chunk) => total + chunk.byteSize, 0)
  return Math.round((bytes / 2) / sampleRate * 1000)
}

export function recordingStoragePath(recordingDir: string, recordingId: string, sequence: number): string {
  return join(recordingDir, recordingId, `${sequence}.bin`)
}

export { audioFormatFromMime }
