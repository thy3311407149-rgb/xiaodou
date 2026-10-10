import { ApiError, REQUEST_FAILED_MESSAGE, http, type HttpRequest } from './http.ts'
import { parseUploadResponse, type UploadedPdf } from '../upload/task.ts'

export async function uploadPdf(file: File, request: HttpRequest = http.request): Promise<UploadedPdf> {
  const body = new FormData()
  body.append('file', file, file.name)
  const response = await request('/api/files', { method: 'POST', body })
  if (response.status !== 201) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  const uploaded = parseUploadResponse(response.body)
  if (!uploaded) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  return { ...uploaded, fileName: uploaded.fileName || file.name }
}
