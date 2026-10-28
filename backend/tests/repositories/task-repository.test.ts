import { afterEach, describe, expect, it } from 'vitest'
import { TaskRepository } from '../../app/repositories/task-repository.js'
import { closeRepositoryTestDatabase, insertTestFile, openRepositoryTestDatabase } from '../repository-test-helper.js'

let directory = ''
afterEach(async () => closeRepositoryTestDatabase(directory))

describe('TaskRepository', () => {
  it('creates, finds active/history tasks, and updates fields', async () => {
    const context = await openRepositoryTestDatabase(); directory = context.directory; insertTestFile(context.database)
    const repository = new TaskRepository(context.database)
    const created = repository.create({ id: 'task_001', fileId: 'file_001', requestId: 'request_001', idempotencyKey: 'retry_001' })
    expect(created).toMatchObject({ fileId: 'file_001', taskType: 'PROCESS_PDF', status: 'QUEUED', currentStep: 'EXTRACT_TEXT' })
    expect(repository.findById('task_001')).toEqual(created)
    expect(repository.findByIdempotencyKey('retry_001')?.id).toBe('task_001')
    expect(repository.findActiveByFileId('file_001')?.id).toBe('task_001')
    expect(repository.update('task_001', { status: 'RUNNING', currentStep: 'GENERATE_SUMMARY', progress: 70, startedAt: '2026-09-06T00:00:00.000Z' })?.progress).toBe(70)
    expect(repository.update('task_001', { status: 'FAILED', errorCode: 'LLM_TIMEOUT', finishedAt: null })?.status).toBe('FAILED')
    expect(repository.findActiveByFileId('file_001')).toBeNull()
  })

  it('lets SQLite reject two active tasks for one file', async () => {
    const context = await openRepositoryTestDatabase(); directory = context.directory; insertTestFile(context.database)
    const repository = new TaskRepository(context.database)
    repository.create({ id: 'task_001', fileId: 'file_001', requestId: 'request_001' })
    expect(() => repository.create({ id: 'task_002', fileId: 'file_001', requestId: 'request_002' })).toThrow()
  })
})
