import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createApp } from '../app/app.js'

describe('CORS', () => {
  it('returns the configured origin and leaves the API body unchanged', async () => {
    const app = createApp({ allowedOrigins: ['https://app.example'] })
    const response = await request(app).get('/health').set('Origin', 'https://app.example')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: 'ok' })
    expect(response.headers['access-control-allow-origin']).toBe('https://app.example')
    expect(response.headers['vary']).toBe('Origin')
    expect(response.headers['access-control-allow-credentials']).toBeUndefined()
    expect(response.headers['access-control-allow-origin']).not.toBe('*')
  })

  it('answers preflight with the methods and headers the API uses', async () => {
    const app = createApp({ allowedOrigins: ['https://app.example'] })
    const response = await request(app)
      .options('/api/files')
      .set('Origin', 'https://app.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-request-id,idempotency-key')

    expect(response.status).toBe(204)
    expect(response.headers['access-control-allow-origin']).toBe('https://app.example')
    expect(response.headers['access-control-allow-methods']).toContain('POST')
    expect(response.headers['access-control-allow-methods']).toContain('DELETE')
    expect(response.headers['access-control-allow-headers']).toContain('Content-Type')
    expect(response.headers['access-control-allow-headers']).toContain('X-Request-Id')
    expect(response.headers['access-control-allow-headers']).toContain('Idempotency-Key')
    expect(response.headers['access-control-allow-credentials']).toBeUndefined()
  })

  it('rejects an origin that is not on the allowlist', async () => {
    const app = createApp({ allowedOrigins: ['https://app.example'] })
    const response = await request(app).get('/health').set('Origin', 'https://evil.example')

    expect(response.status).toBe(403)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    expect(response.headers['access-control-allow-credentials']).toBeUndefined()
  })

  it('does not allow every origin when the allowlist is empty', async () => {
    const app = createApp({ allowedOrigins: [] })
    const response = await request(app).options('/api/files').set('Origin', 'https://evil.example')

    expect(response.status).toBe(403)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('keeps the allowed origin on an API error response', async () => {
    const app = createApp({ allowedOrigins: ['https://app.example'] })
    const response = await request(app)
      .post('/api/knowledge/search')
      .set('Origin', 'https://app.example')
      .send({})

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_REQUEST')
    expect(response.headers['access-control-allow-origin']).toBe('https://app.example')
    expect(response.headers['access-control-allow-origin']).not.toBe('*')
    expect(response.headers['access-control-allow-credentials']).toBeUndefined()
  })

  it('allows the phone dev server origin on a private network address', async () => {
    const origin = 'http://172.20.10.3:5173'
    const app = createApp({ allowedOrigins: [], allowPrivateNetworkOrigins: true })
    const response = await request(app).post('/api/knowledge/search').set('Origin', origin).send({})

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_REQUEST')
    expect(response.headers['access-control-allow-origin']).toBe(origin)
    expect(response.headers['access-control-allow-origin']).not.toBe('*')
    expect(response.headers['access-control-allow-credentials']).toBeUndefined()
  })

  it('rejects a private-network origin when that development exception is off', async () => {
    const app = createApp({ allowedOrigins: [], allowPrivateNetworkOrigins: false })
    const response = await request(app).get('/health').set('Origin', 'http://172.20.10.3:5173')

    expect(response.status).toBe(403)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('does not treat a public host that merely contains a private address as local', async () => {
    const app = createApp({ allowedOrigins: [], allowPrivateNetworkOrigins: true })
    const response = await request(app).get('/health').set('Origin', 'http://172.20.10.3.evil.example')

    expect(response.status).toBe(403)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('keeps requests without an Origin on the existing response', async () => {
    const app = createApp({ allowedOrigins: [] })
    const response = await request(app).get('/health')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: 'ok' })
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })
})
