export type FileStatus =
  | 'CREATED'
  | 'UPLOADING'
  | 'UPLOADED'
  | 'UPLOAD_FAILED'
  | 'QUEUED'
  | 'EXTRACTING'
  | 'EXTRACTED'
  | 'EXTRACTION_FAILED'
  | 'SUMMARIZING'
  | 'COMPLETED'
  | 'SUMMARY_FAILED'
  | 'DELETED'

export type File = {
  id: string
  userId: string
  fileName: string
  fileType: 'application/pdf'
  fileSize: number
  storagePath: string
  status: FileStatus
  errorCode: string | null
  errorMessage: string | null
  idempotencyKey: string | null
  createdAt: string
  updatedAt: string
}

export type CreateFileInput = {
  id: string
  userId?: string
  fileName: string
  fileType: 'application/pdf'
  fileSize: number
  storagePath: string
  status?: FileStatus
  idempotencyKey?: string | null
}

export type UpdateFileInput = {
  status?: FileStatus
  errorCode?: string | null
  errorMessage?: string | null
  updatedAt?: string
}
