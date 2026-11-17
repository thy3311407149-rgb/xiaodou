import type { Task, TaskType } from '../../models/task.js'

export type TaskHandlerResult = {
  finished: boolean
}

export interface TaskHandler {
  readonly taskType: TaskType
  execute(task: Task): Promise<TaskHandlerResult>
}
