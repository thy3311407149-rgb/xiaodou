import { afterEach, describe, expect, it } from 'vitest'
import { OperationLogRepository } from '../../app/repositories/operation-log-repository.js'
import { closeRepositoryTestDatabase, insertTestFile, insertTestTask, openRepositoryTestDatabase } from '../repository-test-helper.js'

let directory = ''
afterEach(async () => closeRepositoryTestDatabase(directory))

describe('OperationLogRepository', () => {
  it('creates and queries logs with nullable fields', async () => {
    const context = await openRepositoryTestDatabase(); directory = context.directory; insertTestFile(context.database); insertTestTask(context.database, 'task_001', 'file_001')
    const repository = new OperationLogRepository(context.database)
    repository.create({ id: 'log_001', requestId: 'request_001', operation: 'TASK_CREATED', status: 'SUCCEEDED' })
    repository.create({ id: 'log_002', requestId: 'request_001', taskId: 'task_001', fileId: 'file_001', operation: 'PDF_EXTRACTION_STARTED', status: 'STARTED', durationMs: 0, errorMessage: null })
    expect(repository.findByRequestId('request_001')).toHaveLength(2)
    expect(repository.listByFileId('file_001')).toHaveLength(1)
    expect(repository.listByTaskId('task_001')).toHaveLength(1)
    expect(repository.findByRequestId('request_001')[0]).toMatchObject({ taskId: null, fileId: null, durationMs: null, errorMessage: null })
  })
})
