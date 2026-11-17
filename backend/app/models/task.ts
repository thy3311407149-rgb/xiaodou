export type TaskStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
export type TaskType = 'PROCESS_PDF' | 'PROCESS_RECORDING' | 'PROCESS_NOTE'
export type PdfTaskStep =
  | 'EXTRACT_TEXT'
  | 'SAVE_DOCUMENT_TEXT'
  | 'CREATE_CHUNKS'
  | 'GENERATE_SUMMARY'
  | 'SAVE_SUMMARY'
  | 'COMPLETED'
export type RecordingTaskStep =
  | 'PERSIST_AUDIO'
  | 'TRANSCRIBE_AUDIO'
  | 'SAVE_TRANSCRIPT'
  | 'GENERATE_SUMMARY'
  | 'SAVE_SUMMARY'
  | 'EXTRACT_KNOWLEDGE'
  | 'COMPLETED'
export type NoteTaskStep =
  | 'GENERATE_SUMMARY'
  | 'SAVE_SUMMARY'
  | 'EXTRACT_KNOWLEDGE'
  | 'COMPLETED'
export type TaskStep = PdfTaskStep | RecordingTaskStep | NoteTaskStep

export type Task = {
  id: string
  fileId: string | null
  recordingId: string | null
  noteId: string | null
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
  fileId?: string | null
  recordingId?: string | null
  noteId?: string | null
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
