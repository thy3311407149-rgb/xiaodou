import { randomUUID } from 'node:crypto'
import { OperationLogRepository } from '../repositories/operation-log-repository.js'
import type { CreateOperationLogInput } from '../models/operation-log.js'
import { logger } from '../core/logger.js'

export type OperationLogEvent = Omit<CreateOperationLogInput, 'id'>
type OperationLogWriter = Pick<OperationLogRepository, 'create'>

export class OperationLogger {
  constructor(private readonly repository: OperationLogWriter = new OperationLogRepository()) {}

  log(event: OperationLogEvent): void {
    try {
      this.repository.create({ id: randomUUID(), ...event })
    } catch (error: unknown) {
      logger.error('OPERATION_LOG_WRITE_FAILED', {
        requestId: event.requestId,
        fileId: event.fileId ?? undefined,
        taskId: event.taskId ?? undefined,
        operation: event.operation,
        status: event.status,
        errorCode: 'DATABASE_ERROR',
      })
      console.error(error)
    }
  }
}
