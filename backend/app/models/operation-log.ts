export type Operation =
  | 'FILE_UPLOAD_STARTED'
  | 'FILE_UPLOAD_COMPLETED'
  | 'FILE_UPLOAD_FAILED'
  | 'FILE_DELETE_FAILED'
  | 'TASK_CREATED'
  | 'PDF_EXTRACTION_STARTED'
  | 'PDF_EXTRACTION_COMPLETED'
  | 'PDF_EXTRACTION_FAILED'
  | 'SUMMARY_STARTED'
  | 'LLM_REQUEST_STARTED'
  | 'LLM_REQUEST_COMPLETED'
  | 'LLM_REQUEST_FAILED'
  | 'SUMMARY_SAVED'
  | 'TASK_COMPLETED'
  | 'TASK_FAILED'
  | 'TASK_RETRY_CREATED'

export type OperationStatus = 'STARTED' | 'SUCCEEDED' | 'FAILED'

export type OperationLog = {
  id: string
  requestId: string
  taskId: string | null
  fileId: string | null
  operation: Operation
  status: OperationStatus
  durationMs: number | null
  errorMessage: string | null
  createdAt: string
}

export type CreateOperationLogInput = {
  id: string
  requestId: string
  taskId?: string | null
  fileId?: string | null
  operation: Operation
  status: OperationStatus
  durationMs?: number | null
  errorMessage?: string | null
}
