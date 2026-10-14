import { parseTask, type TaskSnapshot, parseUploadResponse, type UploadedPdf } from '../upload/task.ts'
import { parseFileSummary, type FileSummary } from './summaries.ts'
import { ApiError, REQUEST_FAILED_MESSAGE, http, type HttpRequest } from './http.ts'

export type FileDetail = {
  file: { id: string; fileName: string; status: string }
  task: TaskSnapshot | null
  summary: FileSummary | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function parseFileDetail(body: unknown): FileDetail | null {
  if (!isRecord(body) || !isRecord(body.data) || !isRecord(body.data.file)) return null
  const file = body.data.file
  if (typeof file.id !== 'string' || !file.id || typeof file.fileName !== 'string') return null
  const summary = body.data.summary == null ? null : parseFileSummary(body.data.summary)
  if (body.data.summary != null && !summary) return null
  return {
    file: { id: file.id, fileName: file.fileName, status: typeof file.status === 'string' ? file.status : '' },
    task: body.data.task == null ? null : parseTask(body.data.task),
    summary,
  }
}

export async function fetchFileDetail(fileId: string, request: HttpRequest = http.request): Promise<FileDetail> {
  const response = await request(`/api/files/${encodeURIComponent(fileId)}`)
  const detail = parseFileDetail(response.body)
  if (!detail) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  return detail
}

export async function getPdfContent(fileId: string, requestBlob: (path: string, init?: RequestInit) => Promise<Blob> = http.requestBlob): Promise<Blob> {
  return requestBlob(`/api/files/${encodeURIComponent(fileId)}/content`)
}

export async function uploadPdf(file: File, request: HttpRequest = http.request): Promise<UploadedPdf> {
  const body = new FormData()
  body.append('file', file, file.name)
  const response = await request('/api/files', { method: 'POST', body })
  if (response.status !== 201) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  const uploaded = parseUploadResponse(response.body)
  if (!uploaded) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  return { ...uploaded, fileName: uploaded.fileName || file.name }
}
