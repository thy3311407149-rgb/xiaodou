import { ApiError, REQUEST_FAILED_MESSAGE, http, type HttpRequest } from './http.ts'

export type DocumentPage = {
  pageNumber: number
  content: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function parseDocumentText(body: unknown): DocumentPage[] | null {
  if (!isRecord(body) || !isRecord(body.data) || !Array.isArray(body.data.pages)) return null
  const pages: DocumentPage[] = []
  for (const page of body.data.pages) {
    if (!isRecord(page) || typeof page.pageNumber !== 'number' || typeof page.content !== 'string') return null
    pages.push({ pageNumber: page.pageNumber, content: page.content })
  }
  return pages
}

export async function getDocumentText(fileId: string, request: HttpRequest = http.request): Promise<DocumentPage[]> {
  const response = await request(`/api/files/${encodeURIComponent(fileId)}/document-text`)
  const pages = parseDocumentText(response.body)
  if (!pages) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  return pages
}
