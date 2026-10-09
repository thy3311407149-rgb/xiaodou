import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { errorHandler } from '../app/core/errors/error-handler.js'
import { requestIdMiddleware } from '../app/core/request-id-middleware.js'
import { requestLoggingMiddleware } from '../app/core/request-logging-middleware.js'
import { logger } from '../app/core/logger.js'

function createLoggingTestApp() {
  const app = express()
  app.use(express.json())
  app.use(requestIdMiddleware)
  app.use(requestLoggingMiddleware)
  app.post('/echo', (_request, response) => response.status(201).json({ ok: true }))
  app.get('/fail', () => { throw new Error('private stack') })
  app.use(errorHandler)
  return app
}

afterEach(() => vi.restoreAllMocks())

describe('RequestId and HTTP logging middleware', () => {
  it('reuses the client requestId and returns it in the response header', async () => {
    const response = await request(createLoggingTestApp())
      .get('/fail')
      .set('X-Request-Id', 'req_phase56_manual')

    expect(response.headers['x-request-id']).toBe('req_phase56_manual')
    expect(response.body.error.requestId).toBe('req_phase56_manual')
  })

  it('generates a requestId and uses the same value for error response and header', async () => {
    const response = await request(createLoggingTestApp()).get('/fail')

    expect(response.headers['x-request-id']).toEqual(expect.any(String))
    expect(response.body.error.requestId).toBe(response.headers['x-request-id'])
  })

  it('logs started and completed events without logging request body', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const response = await request(createLoggingTestApp())
      .post('/echo')
      .set('X-Request-Id', 'req_logging_001')
      .send({ privatePdfContent: 'must-not-be-logged' })

    expect(response.status).toBe(201)
    expect(info).toHaveBeenCalledTimes(2)
    expect(info.mock.calls[0]).toEqual(['HTTP_REQUEST_STARTED', expect.objectContaining({ requestId: 'req_logging_001', method: 'POST', path: '/echo' })])
    expect(info.mock.calls[1]).toEqual(['HTTP_REQUEST_COMPLETED', expect.objectContaining({ requestId: 'req_logging_001', method: 'POST', path: '/echo', statusCode: 201, durationMs: expect.any(Number) })])
    expect(JSON.stringify(info.mock.calls)).not.toContain('must-not-be-logged')
  })
})
