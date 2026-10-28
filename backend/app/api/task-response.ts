import type { Task } from '../models/task.js'

export type PublicTask = {
  id: string
  fileId: string
  taskType: Task['taskType']
  status: Task['status']
  currentStep: Task['currentStep']
  progress: number
  errorCode: string | null
  errorMessage: string | null
  startedAt: string | null
  finishedAt: string | null
}

export function toPublicTask(task: Task): PublicTask {
  return {
    id: task.id,
    fileId: task.fileId,
    taskType: task.taskType,
    status: task.status,
    currentStep: task.currentStep,
    progress: task.progress,
    errorCode: task.errorCode,
    errorMessage: task.errorMessage,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
  }
}
