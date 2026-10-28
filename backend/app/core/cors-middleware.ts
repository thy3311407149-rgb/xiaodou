import type { RequestHandler } from 'express'

const allowedMethods = 'GET, POST, DELETE, OPTIONS'
const allowedHeaders = 'Content-Type, X-Request-Id, Idempotency-Key'

export type CorsMiddlewareOptions = {
  allowPrivateNetworkOrigins?: boolean
}

export function isPrivateNetworkOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return false
  const parts = match.slice(1).map(Number)
  if (parts.some((part) => part > 255)) return false
  const [first, second] = parts
  if (first === 10 || first === 127) return true
  if (first === 192 && second === 168) return true
  return first === 172 && second >= 16 && second <= 31
}

export function createCorsMiddleware(allowedOrigins: readonly string[], options: CorsMiddlewareOptions = {}): RequestHandler {
  const allowlist = new Set(allowedOrigins)
  const allowPrivateNetworkOrigins = options.allowPrivateNetworkOrigins === true

  return (request, response, next) => {
    const origin = request.get('Origin')
    if (!origin) {
      next()
      return
    }

    response.setHeader('Vary', 'Origin')
    const allowed = allowlist.has(origin) || (allowPrivateNetworkOrigins && isPrivateNetworkOrigin(origin))
    if (!allowed) {
      response.status(403).end()
      return
    }

    response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader('Access-Control-Allow-Methods', allowedMethods)
    response.setHeader('Access-Control-Allow-Headers', allowedHeaders)
    if (request.method === 'OPTIONS') {
      response.status(204).end()
      return
    }
    next()
  }
}
