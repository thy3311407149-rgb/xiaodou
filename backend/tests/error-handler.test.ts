import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app/app.js'
import { ApplicationError, errorHandler } from '../app/core/errors/index.js'

function createErrorTestApp(error: unknown) {
  const app = express()
  app.get('/known-error', () => {
    throw error
  })
  app.use(errorHandler)
  return app
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ApplicationError', () => {
  it('stores stable code, mapped status, and optional context', () => {
    const error = new ApplicationError('FILE_NOT_FOUND', {
      message: '指定文件不存在',
      fileId: 'file_001',
      taskId: 'task_001',
      details: { retryable: false },
    })

    expect(error.code).toBe('FILE_NOT_FOUND')
    expect(error.message).toBe('指定文件不存在')
    expect(error.httpStatus).toBe(404)
    expect(error.fileId).toBe('file_001')
    expect(error.taskId).toBe('task_001')
    expect(error.details).toEqual({ retryable: false })
  })
})

describe('unified error handler', () => {
  it('returns a known ApplicationError without converting it to INTERNAL_ERROR', async () => {
    const response = await request(createErrorTestApp(new ApplicationError('FILE_NOT_FOUND', {
      fileId: 'file_001',
    }))).get('/known-error').set('X-Request-Id', 'req_known_001')

    expect(response.status).toBe(404)
    expect(response.body).toEqual({
      error: {
        code: 'FILE_NOT_FOUND',
        message: '文件不存在',
        requestId: 'req_known_001',
        fileId: 'file_001',
      },
    })
  })

  it('converts ordinary errors to INTERNAL_ERROR without exposing stack or cause', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const response = await request(createErrorTestApp(new Error('database SQL secret')))
      .get('/known-error')
      .set('X-Request-Id', 'req_internal_001')

    expect(response.status).toBe(500)
    expect(response.body.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: '服务器内部错误',
      requestId: 'req_internal_001',
    })
    expect(JSON.stringify(response.body)).not.toContain('database SQL secret')
    expect(response.body.error.stack).toBeUndefined()
    expect(consoleError).toHaveBeenCalledOnce()
  })

  it('generates a requestId when the request does not provide one', async () => {
    const response = await request(createErrorTestApp(new ApplicationError('INVALID_REQUEST'))).get('/known-error')

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_REQUEST')
    expect(response.body.error.requestId).toEqual(expect.any(String))
    expect(response.body.error.requestId.length).toBeGreaterThan(0)
  })

  it('keeps the existing health endpoint unchanged', async () => {
    const response = await request(createApp()).get('/health')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: 'ok' })
  })
})
