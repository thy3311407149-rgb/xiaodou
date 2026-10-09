import type { RequestHandler } from 'express'
import { logger } from './logger.js'

export const requestLoggingMiddleware: RequestHandler = (request, response, next) => {
  const startedAt = process.hrtime.bigint()
  const requestId = request.requestId

  logger.info('HTTP_REQUEST_STARTED', {
    requestId,
    method: request.method,
    path: request.path,
  })

  response.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
    logger.info('HTTP_REQUEST_COMPLETED', {
      requestId,
      method: request.method,
      path: request.path,
      statusCode: response.statusCode,
      durationMs: Math.round(durationMs),
    })
  })

  next()
}
