export const TASK_STATUSES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'] as const
export const TASK_STEPS = [
  'EXTRACT_TEXT',
  'SAVE_DOCUMENT_TEXT',
  'CREATE_CHUNKS',
  'GENERATE_SUMMARY',
  'SAVE_SUMMARY',
  'COMPLETED',
] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]
export type TaskStep = (typeof TASK_STEPS)[number]

export type TaskSnapshot = {
  id: string
  fileId: string
  taskType: 'PROCESS_PDF'
  status: TaskStatus
  currentStep: TaskStep
  progress: number
  errorCode: string | null
  errorMessage: string | null
  startedAt: string | null
  finishedAt: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && TASK_STATUSES.some((status) => status === value)
}

function isTaskStep(value: unknown): value is TaskStep {
  return typeof value === 'string' && TASK_STEPS.some((step) => step === value)
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function parseTask(value: unknown): TaskSnapshot | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || !value.id) return null
  if (typeof value.fileId !== 'string' || !value.fileId) return null
  if (value.taskType !== 'PROCESS_PDF') return null
  if (!isTaskStatus(value.status) || !isTaskStep(value.currentStep)) return null
  if (typeof value.progress !== 'number' || !Number.isFinite(value.progress)) return null

  return {
    id: value.id,
    fileId: value.fileId,
    taskType: 'PROCESS_PDF',
    status: value.status,
    currentStep: value.currentStep,
    progress: value.progress,
    errorCode: nullableString(value.errorCode),
    errorMessage: nullableString(value.errorMessage),
    startedAt: nullableString(value.startedAt),
    finishedAt: nullableString(value.finishedAt),
  }
}

export function parseTaskResponse(body: unknown): TaskSnapshot | null {
  if (!isRecord(body) || !isRecord(body.data)) return null
  return parseTask(body.data.task)
}

export type UploadedPdf = {
  fileId: string
  fileName: string
  task: TaskSnapshot
}

export function parseUploadResponse(body: unknown): UploadedPdf | null {
  if (!isRecord(body) || !isRecord(body.data) || !isRecord(body.data.file)) return null
  if (typeof body.data.file.id !== 'string' || !body.data.file.id) return null
  const task = parseTask(body.data.task)
  if (!task) return null
  const fileName = typeof body.data.file.fileName === 'string' ? body.data.file.fileName : ''
  return { fileId: body.data.file.id, fileName, task }
}
