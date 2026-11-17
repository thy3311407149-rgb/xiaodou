import { ApplicationError } from '../../core/errors/application-error.js'
import type { Task } from '../../models/task.js'
import type { TaskHandler, TaskHandlerResult } from './task-handler.js'

export class NoteTaskHandler implements TaskHandler {
  readonly taskType = 'PROCESS_NOTE' as const

  execute(task: Task): Promise<TaskHandlerResult> {
    if (!task.noteId || task.fileId || task.recordingId) {
      throw new ApplicationError('TASK_EXECUTION_FAILED', { message: '笔记任务缺少笔记来源', taskId: task.id })
    }
    throw new ApplicationError('TASK_EXECUTION_FAILED', {
      message: '笔记任务尚未实现',
      taskId: task.id,
    })
  }
}
