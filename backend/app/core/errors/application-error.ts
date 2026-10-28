import { defaultErrorMessage, errorHttpStatus, type ErrorCode } from './error-code.js'

export type ApplicationErrorOptions = {
  message?: string
  details?: unknown
  fileId?: string
  taskId?: string
  cause?: unknown
}

export class ApplicationError extends Error {
  readonly code: ErrorCode
  readonly httpStatus: number
  readonly details?: unknown
  readonly fileId?: string
  readonly taskId?: string

  constructor(code: ErrorCode, options: ApplicationErrorOptions = {}) {
    super(options.message ?? defaultErrorMessage[code], { cause: options.cause })
    this.name = 'ApplicationError'
    this.code = code
    this.httpStatus = errorHttpStatus[code]
    this.details = options.details
    this.fileId = options.fileId
    this.taskId = options.taskId
  }
}
