import type { ErrorRequestHandler, Request } from 'express'
import { randomUUID } from 'node:crypto'
import { ApplicationError } from './application-error.js'

type ErrorResponse = {
  error: {
    code: string
    message: string
    requestId: string
    fileId?: string
    taskId?: string
    details?: unknown
  }
}

function getRequestId(request: Request): string {
  return request.requestId ?? request.get('X-Request-Id') ?? randomUUID()
}

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  const requestId = getRequestId(request)
  response.setHeader('X-Request-Id', requestId)
  const normalized = isJsonParseError(error)
    ? new ApplicationError('INVALID_REQUEST', { message: '请求体不是有效的 JSON' })
    : error
  const isApplicationError = normalized instanceof ApplicationError

  if (!isApplicationError) {
    console.error(`[${requestId}] Unhandled backend error`, error)
  }

  const applicationError = isApplicationError
    ? normalized
    : new ApplicationError('INTERNAL_ERROR', { cause: error })

  const body: ErrorResponse = {
    error: {
      code: applicationError.code,
      message: applicationError.message,
      requestId,
    },
  }

  if (applicationError.fileId) body.error.fileId = applicationError.fileId
  if (applicationError.taskId) body.error.taskId = applicationError.taskId
  if (applicationError.details !== undefined) body.error.details = applicationError.details

  response.status(applicationError.httpStatus).json(body)
}

function isJsonParseError(error: unknown): boolean {
  if (!(error instanceof SyntaxError)) return false
  const parsed = error as SyntaxError & { status?: number; type?: string }
  return parsed.status === 400 && parsed.type === 'entity.parse.failed'
}
