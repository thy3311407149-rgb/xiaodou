import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { KnowledgeItemRepository } from '../../app/repositories/knowledge-item-repository.js'
import { RecordingRepository } from '../../app/repositories/recording-repository.js'
import { SummaryRepository } from '../../app/repositories/summary-repository.js'
import { TaskRepository } from '../../app/repositories/task-repository.js'
import { closeRepositoryTestDatabase, openRepositoryTestDatabase } from '../repository-test-helper.js'

let directory = ''
afterEach(async () => closeRepositoryTestDatabase(directory))

describe('RecordingRepository list', () => {
  it('returns recordings newest first with duration, task status, and current summary', async () => {
    const context = await openRepositoryTestDatabase()
    directory = context.directory
    const database = context.database
    const recordings = new RecordingRepository(database)
    const tasks = new TaskRepository(database)
    const summaries = new SummaryRepository(database)
    const knowledgeItems = new KnowledgeItemRepository(database)

    recordings.create({ id: 'rec-new', title: '最新' })
    recordings.update('rec-new', { status: 'ENDED', mimeType: 'audio/pcm', sampleRate: 16000 })
    recordings.insertChunk(chunk('rec-new', 32_000))
    tasks.create({ id: 'task-old-ok', recordingId: 'rec-new', taskType: 'PROCESS_RECORDING', status: 'SUCCEEDED', requestId: 'r1' })
    tasks.create({ id: 'task-new-failed', recordingId: 'rec-new', taskType: 'PROCESS_RECORDING', status: 'FAILED', requestId: 'r2' })
    database.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run('2026-11-08T00:00:00.000Z', 'task-old-ok')
    database.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run('2026-11-08T00:00:01.000Z', 'task-new-failed')
    summaries.create({
      id: 'summary-unlinked',
      recordingId: 'rec-new',
      taskId: 'task-new-failed',
      content: '尚未设为当前摘要',
      keyPoints: [],
      citations: [],
      modelName: 'test',
      promptVersion: 'v1',
    })
    stamp(database, 'rec-new', '2026-11-08T03:00:00.000Z')

    recordings.create({ id: 'rec-run', title: '处理中' })
    recordings.update('rec-run', { status: 'RECORDING' })
    tasks.create({ id: 'task-running', recordingId: 'rec-run', taskType: 'PROCESS_RECORDING', status: 'RUNNING', requestId: 'r3' })
    stamp(database, 'rec-run', '2026-11-08T02:00:00.000Z')

    recordings.create({ id: 'rec-done', title: '已完成' })
    recordings.update('rec-done', { status: 'ENDED', mimeType: 'audio/webm', sampleRate: 48000 })
    recordings.insertChunk({ ...chunk('rec-done', 9600), id: 'chunk-done' })
    recordings.appendSegments([{
      id: 'segment-done',
      recordingId: 'rec-done',
      segmentIndex: 0,
      audioSequence: null,
      content: '已经结束',
      startTimeMs: 0,
      endTimeMs: 2500,
      speakerId: null,
    }])
    const doneTask = tasks.create({ id: 'task-done', recordingId: 'rec-done', taskType: 'PROCESS_RECORDING', status: 'SUCCEEDED', requestId: 'r4' })
    const summary = summaries.create({
      id: 'summary-done',
      recordingId: 'rec-done',
      taskId: doneTask.id,
      content: '摘要',
      keyPoints: [],
      citations: [],
      modelName: 'test',
      promptVersion: 'v1',
    })
    const item = knowledgeItems.create({ id: 'item-done', sourceType: 'RECORDING', sourceId: 'rec-done', title: '已完成', status: 'ACTIVE' })
    knowledgeItems.replaceCurrentSummary(item.id, summary.id)
    stamp(database, 'rec-done', '2026-11-08T01:00:00.000Z')

    recordings.create({ id: 'rec-plain', title: '未处理' })
    stamp(database, 'rec-plain', '2026-11-08T00:00:00.000Z')
    recordings.create({ id: 'rec-tie-a', title: '并列甲' })
    recordings.create({ id: 'rec-tie-b', title: '并列乙' })
    stamp(database, 'rec-tie-a', '2026-10-01T00:00:00.000Z')
    stamp(database, 'rec-tie-b', '2026-10-01T00:00:00.000Z')
    recordings.create({ id: 'rec-deleted', title: '已删除' })
    recordings.update('rec-deleted', { status: 'DELETED' })
    stamp(database, 'rec-deleted', '2026-12-01T00:00:00.000Z')

    const first = recordings.listPage(2, 0)
    expect(first.total).toBe(6)
    expect(first.items.map((item) => item.recordingId)).toEqual(['rec-new', 'rec-run'])
    expect(first.items[0]).toMatchObject({
      title: '最新',
      createdAt: '2026-11-08T03:00:00.000Z',
      durationMs: 1000,
      status: 'ENDED',
      processingStatus: 'FAILED',
      summaryGenerated: false,
    })
    expect(first.items[1]).toMatchObject({
      status: 'RECORDING',
      processingStatus: 'RUNNING',
      durationMs: null,
      summaryGenerated: false,
    })

    const second = recordings.listPage(2, 2)
    expect(second.items.map((item) => [item.recordingId, item.processingStatus, item.summaryGenerated, item.durationMs])).toEqual([
      ['rec-done', 'SUCCEEDED', true, 2500],
      ['rec-plain', null, false, null],
    ])
    expect(second.items[0]?.status).toBe('ENDED')
    expect(second.items[1]?.status).toBe('CREATED')

    const third = recordings.listPage(2, 4)
    expect(third.items.map((item) => item.recordingId)).toEqual(['rec-tie-b', 'rec-tie-a'])
    expect(recordings.listPage(2, 6).items).toEqual([])
  })
})

function stamp(database: Database.Database, id: string, createdAt: string): void {
  database.prepare('UPDATE recordings SET created_at = ? WHERE id = ?').run(createdAt, id)
}

function chunk(recordingId: string, byteSize: number) {
  return {
    id: `chunk-${recordingId}`,
    recordingId,
    sequence: 0,
    storagePath: `${recordingId}.bin`,
    byteSize,
    sha256: 'a'.repeat(64),
    mimeType: 'audio/pcm',
    asrStatus: 'SUCCEEDED' as const,
  }
}
