import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../app/app.js'
import { KnowledgeItemRepository } from '../app/repositories/knowledge-item-repository.js'
import { RecordingRepository } from '../app/repositories/recording-repository.js'
import { SummaryRepository } from '../app/repositories/summary-repository.js'
import { TaskRepository } from '../app/repositories/task-repository.js'
import { UnconfiguredAsrProvider } from '../app/services/asr/bailian-asr-provider.js'
import { KnowledgeItemService } from '../app/services/knowledge-item-service.js'
import { RecordingService } from '../app/services/recording-service.js'
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

describe('GET /api/recordings', () => {
  it('lists history by creation time without starting recognition or summary work', async () => {
    const opened = await openRepositoryTestDatabase()
    databaseDirectory = opened.directory
    recordingDirectory = await mkdtemp(join(tmpdir(), 'xiaodou-recordings-'))
    const recordings = new RecordingRepository(opened.database)
    const tasks = new TaskRepository(opened.database)
    const summaries = new SummaryRepository(opened.database)
    const knowledgeItems = new KnowledgeItemRepository(opened.database)
    const service = new RecordingService({
      recordingRepository: recordings,
      taskRepository: tasks,
      knowledgeItems: new KnowledgeItemService({ database: opened.database }),
      asrProvider: new UnconfiguredAsrProvider(),
      recordingDir: recordingDirectory,
    })
    const app = createApp({ recordingService: service })

    const older = await request(app).post('/api/recordings').send({ title: '旧录音' })
    const newer = await request(app).post('/api/recordings').send({ title: '新录音' })
    const failed = await request(app).post('/api/recordings').send({ title: '失败录音' })
    const olderId = older.body.data.recording.id as string
    const newerId = newer.body.data.recording.id as string
    const failedId = failed.body.data.recording.id as string
    opened.database.prepare('UPDATE recordings SET created_at = ? WHERE id = ?').run('2026-11-08T01:00:00.000Z', olderId)
    opened.database.prepare('UPDATE recordings SET created_at = ? WHERE id = ?').run('2026-11-08T03:00:00.000Z', newerId)
    opened.database.prepare('UPDATE recordings SET created_at = ?, status = ?, mime_type = ?, sample_rate = ? WHERE id = ?')
      .run('2026-11-08T02:00:00.000Z', 'ENDED', 'audio/pcm', 16000, failedId)
    recordings.insertChunk({
      id: 'chunk-failed',
      recordingId: failedId,
      sequence: 0,
      storagePath: 'failed.bin',
      byteSize: 16_000,
      sha256: 'b'.repeat(64),
      mimeType: 'audio/pcm',
      asrStatus: 'FAILED',
    })
    const failedTask = tasks.create({ id: 'task-failed', recordingId: failedId, taskType: 'PROCESS_RECORDING', status: 'FAILED', requestId: 'list-test' })
    const doneTask = tasks.create({ id: 'task-done', recordingId: olderId, taskType: 'PROCESS_RECORDING', status: 'SUCCEEDED', requestId: 'list-test-done' })
    recordings.update(olderId, { status: 'ENDED', mimeType: 'audio/pcm', sampleRate: 16000 })
    const summary = summaries.create({
      id: 'summary-older',
      recordingId: olderId,
      taskId: doneTask.id,
      content: '已有摘要',
      keyPoints: [],
      citations: [],
      modelName: 'test',
      promptVersion: 'v1',
    })
    const item = knowledgeItems.findBySource('RECORDING', olderId)
    if (!item) throw new Error('missing knowledge item')
    knowledgeItems.replaceCurrentSummary(item.id, summary.id)
    const taskCount = opened.database.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }
    const summaryCount = opened.database.prepare('SELECT COUNT(*) AS count FROM summaries').get() as { count: number }

    const page = await request(app).get('/api/recordings').query({ page: 1, pageSize: 2 })
    expect(page.status).toBe(200)
    expect(page.body.data.total).toBe(3)
    expect(page.body.data.page).toBe(1)
    expect(page.body.data.pageSize).toBe(2)
    expect(page.body.data.items).toEqual([
      {
        recordingId: newerId,
        title: '新录音',
        createdAt: '2026-11-08T03:00:00.000Z',
        durationMs: null,
        status: 'CREATED',
        processingStatus: null,
        summaryGenerated: false,
      },
      {
        recordingId: failedId,
        title: '失败录音',
        createdAt: '2026-11-08T02:00:00.000Z',
        durationMs: 500,
        status: 'ENDED',
        processingStatus: 'FAILED',
        summaryGenerated: false,
      },
    ])
    expect(page.body.data.items[1]).not.toHaveProperty('summary')

    const next = await request(app).get('/api/recordings').query({ page: 2, pageSize: 2 })
    expect(next.body.data.items).toEqual([
      expect.objectContaining({
        recordingId: olderId,
        title: '旧录音',
        status: 'ENDED',
        processingStatus: 'SUCCEEDED',
        summaryGenerated: true,
      }),
    ])
    expect(next.body.data.total).toBe(3)

    const invalid = await request(app).get('/api/recordings').query({ pageSize: 0 })
    expect(invalid.status).toBe(400)
    expect(opened.database.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual(taskCount)
    expect(opened.database.prepare('SELECT COUNT(*) AS count FROM summaries').get()).toEqual(summaryCount)
    expect(failedTask.status).toBe('FAILED')

    const detail = await request(app).get(`/api/recordings/${olderId}`)
    expect(detail.status).toBe(200)
    expect(detail.body.data.recording.id).toBe(olderId)
    expect(detail.body.data.summary.content).toBe('已有摘要')
  })
})
