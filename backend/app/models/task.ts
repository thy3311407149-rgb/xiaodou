export type TaskStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
export type TaskType = 'PROCESS_PDF'
export type TaskStep =
  | 'EXTRACT_TEXT'
  | 'SAVE_DOCUMENT_TEXT'
  | 'CREATE_CHUNKS'
  | 'GENERATE_SUMMARY'
  | 'SAVE_SUMMARY'
  | 'COMPLETED'

export type Task = {
  id: string
  fileId: string
  taskType: TaskType
  status: TaskStatus
  currentStep: TaskStep
  progress: number
  retryCount: number
  requestId: string
  idempotencyKey: string | null
  errorCode: string | null
  errorMessage: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
  updatedAt: string
}

export type CreateTaskInput = {
  id: string
  fileId: string
  taskType?: TaskType
  status?: TaskStatus
  currentStep?: TaskStep
  progress?: number
  retryCount?: number
  requestId: string
  idempotencyKey?: string | null
}

export type UpdateTaskInput = {
  status?: TaskStatus
  currentStep?: TaskStep
  progress?: number
  retryCount?: number
  errorCode?: string | null
  errorMessage?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  updatedAt?: string
}
