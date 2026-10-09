import { afterEach, describe, expect, it, vi } from 'vitest'
import { OperationLogRepository } from '../app/repositories/operation-log-repository.js'
import { OperationLogger } from '../app/services/operation-logger.js'
import { closeRepositoryTestDatabase, openRepositoryTestDatabase } from './repository-test-helper.js'
import { logger } from '../app/core/logger.js'

let directory = ''
afterEach(async () => {
  if (directory) {
    await closeRepositoryTestDatabase(directory)
    directory = ''
  }
})

describe('OperationLogger', () => {
  it('persists operation events through the existing repository', async () => {
    const context = await openRepositoryTestDatabase()
    directory = context.directory
    const operationLogger = new OperationLogger(new OperationLogRepository(context.database))

    operationLogger.log({ requestId: 'req_operation_001', operation: 'TASK_CREATED', status: 'SUCCEEDED', durationMs: 3 })

    const logs = new OperationLogRepository(context.database).findByRequestId('req_operation_001')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ requestId: 'req_operation_001', taskId: null, fileId: null, operation: 'TASK_CREATED', status: 'SUCCEEDED', durationMs: 3, errorMessage: null })
  })

  it('does not propagate operation log write failures', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const operationLogger = new OperationLogger({
      create: () => { throw new Error('database unavailable') },
    })

    expect(() => operationLogger.log({ requestId: 'req_operation_002', operation: 'TASK_FAILED', status: 'FAILED', errorMessage: 'hidden' })).not.toThrow()
    expect(error).toHaveBeenCalledWith('OPERATION_LOG_WRITE_FAILED', expect.objectContaining({ requestId: 'req_operation_002', operation: 'TASK_FAILED', status: 'FAILED', errorCode: 'DATABASE_ERROR' }))
  })
})
