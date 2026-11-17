import { ApplicationError } from '../../core/errors/application-error.js'
import type { TaskType } from '../../models/task.js'
import type { TaskHandler } from './task-handler.js'

export class TaskHandlerRegistry {
  private readonly handlers: Map<TaskType, TaskHandler>

  constructor(handlers: readonly TaskHandler[]) {
    this.handlers = new Map(handlers.map((handler) => [handler.taskType, handler]))
  }

  resolve(taskType: TaskType): TaskHandler {
    const handler = this.handlers.get(taskType)
    if (!handler) {
      throw new ApplicationError('TASK_EXECUTION_FAILED', { message: '不支持的任务类型' })
    }
    return handler
  }
}
