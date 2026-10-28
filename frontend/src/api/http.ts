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
export const API_BASE_URL_MISSING_MESSAGE = '未配置 VITE_API_BASE_URL'
export const API_BASE_URL_INVALID_MESSAGE = 'VITE_API_BASE_URL 必须是公网 HTTPS 地址'

export type ApiTarget = {
  baseUrl?: string
  production: boolean
}

export function readApiTarget(env: { VITE_API_BASE_URL?: string; PROD?: boolean } = import.meta.env): ApiTarget {
  return {
    baseUrl: env.VITE_API_BASE_URL,
    production: env.PROD === true,
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0') return true
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!ipv4) return false
  const parts = ipv4.slice(1).map(Number)
  return parts.every((part) => part <= 255) && parts[0] === 127
}

function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!host || isLoopbackHost(host)) return false
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').every((part) => Number(part) <= 255)
  }
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)
}

function assertProductionBase(baseUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new ApiError(API_BASE_URL_INVALID_MESSAGE, 0)
  }
  if (parsed.protocol !== 'https:' || !isPublicHostname(parsed.hostname)) {
    throw new ApiError(API_BASE_URL_INVALID_MESSAGE, 0)
  }
}

function joinBase(baseUrl: string, requestPath: string): string {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    const base = baseUrl.replace(/\/+$/, '')
    return `${base}${requestPath}`
  }
  const pathname = parsed.pathname.replace(/\/+$/, '')
  let base = `${parsed.origin}${pathname === '/' ? '' : pathname}`
  if ((requestPath === '/api' || requestPath.startsWith('/api/')) && base.endsWith('/api')) {
    base = base.slice(0, -'/api'.length)
  }
  return `${base}${requestPath}`
}

export function resolveRequestUrl(path: string, target: ApiTarget): string {
  const requestPath = path.startsWith('/') ? path : `/${path}`
  const configuredBase = target.baseUrl?.trim() ?? ''
  if (!configuredBase) {
    if (target.production) throw new ApiError(API_BASE_URL_MISSING_MESSAGE, 0)
    return requestPath
  }
  if (target.production) assertProductionBase(configuredBase)
  return joinBase(configuredBase, requestPath)
}

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

function createRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function withRequestId(init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (!headers.has('X-Request-Id')) headers.set('X-Request-Id', createRequestId())
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

export function createHttp(
  fetchImpl: typeof fetch = fetch,
  target: ApiTarget = readApiTarget(),
): { request: HttpRequest; requestBlob: (path: string, init?: RequestInit) => Promise<Blob> } {
  return {
    async request(path, init = {}) {
      const url = resolveRequestUrl(path, target)
      let response: Response
      try {
        response = await fetchImpl(url, withRequestId(init))
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
      const url = resolveRequestUrl(path, target)
      let response: Response
      try {
        response = await fetchImpl(url, withRequestId(init))
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
