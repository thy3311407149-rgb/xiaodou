export class ApiError extends Error {
  readonly status: number
  readonly code: string | null

  constructor(message: string, status: number, code: string | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export const REQUEST_FAILED_MESSAGE = '请求失败'

export type HttpResponse = {
  status: number
  body: unknown
}

export type HttpRequest = (path: string, init?: RequestInit) => Promise<HttpResponse>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function errorMessageFromBody(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.error)) return null
  const message = body.error.message
  return typeof message === 'string' && message.trim() ? message : null
}

function errorCodeFromBody(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.error)) return null
  const code = body.error.code
  return typeof code === 'string' && code ? code : null
}

function withRequestId(init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (!headers.has('X-Request-Id')) headers.set('X-Request-Id', crypto.randomUUID())
  return { ...init, headers }
}

async function readError(response: Response) {
  const text = await response.text()
  if (!text) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  try {
    const body = JSON.parse(text) as unknown
    throw new ApiError(errorMessageFromBody(body) ?? REQUEST_FAILED_MESSAGE, response.status, errorCodeFromBody(body))
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error
    throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  }
}

export function createHttp(fetchImpl: typeof fetch = fetch): { request: HttpRequest; requestBlob: (path: string, init?: RequestInit) => Promise<Blob> } {
  return {
    async request(path, init = {}) {
      let response: Response
      try {
        response = await fetchImpl(path, withRequestId(init))
      } catch {
        throw new ApiError(REQUEST_FAILED_MESSAGE, 0)
      }

      const text = await response.text()
      if (!text) {
        if (!response.ok) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
        return { status: response.status, body: null }
      }

      let body: unknown
      try {
        body = JSON.parse(text) as unknown
      } catch {
        throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
      }

      if (!response.ok) {
        throw new ApiError(errorMessageFromBody(body) ?? REQUEST_FAILED_MESSAGE, response.status, errorCodeFromBody(body))
      }

      return { status: response.status, body }
    },
    async requestBlob(path, init = {}) {
      let response: Response
      try {
        response = await fetchImpl(path, withRequestId(init))
      } catch {
        throw new ApiError(REQUEST_FAILED_MESSAGE, 0)
      }
      if (!response.ok) await readError(response)
      const blob = await response.blob()
      return blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' })
    },
  }
}

export const http = createHttp()
