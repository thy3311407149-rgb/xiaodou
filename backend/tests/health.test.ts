import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createApp } from '../app/app.js'

describe('GET /health', () => {
  it('returns an ok status', async () => {
    const response = await request(createApp()).get('/health')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: 'ok' })
  })
})
