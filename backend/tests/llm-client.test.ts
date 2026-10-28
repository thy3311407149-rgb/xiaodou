import { describe, expect, it, vi } from 'vitest'
import { ApplicationError } from '../app/core/errors/application-error.js'
import { HttpLlmClient } from '../app/services/llm/llm-client.js'

const options = {
  baseUrl: 'https://llm.test/v1',
  apiKey: 'test-key',
  model: 'test-model',
  timeoutMs: 1000,
  maxRetries: 1,
  maxTokens: 1200,
  temperature: 0.2,
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('HttpLlmClient', () => {
  it('retries a server error once and records token usage', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'busy' }, 503))
      .mockResolvedValueOnce(jsonResponse({
        model: 'test-model',
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 11, completion_tokens: 4 },
      }))
    const client = new HttpLlmClient(options, fetchImpl, async () => undefined)

    const completion = await client.complete([{ role: 'user', content: 'hello' }])

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const requestBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)) as { max_tokens?: number; temperature?: number }
    expect(requestBody.max_tokens).toBe(1200)
    expect(requestBody.temperature).toBe(0.2)
    expect(completion).toEqual({
      content: '{"ok":true}',
      modelName: 'test-model',
      inputTokens: 11,
      outputTokens: 4,
    })
    expect(JSON.stringify(completion)).not.toContain('test-key')
  })

  it('maps a timeout to LLM_TIMEOUT without exposing a stack', async () => {
    const timeout = new Error('socket hang up')
    timeout.name = 'TimeoutError'
    const fetchImpl = vi.fn().mockRejectedValue(timeout)
    const client = new HttpLlmClient({ ...options, maxRetries: 0 }, fetchImpl, async () => undefined)

    await expect(client.complete([{ role: 'user', content: 'hello' }])).rejects.toMatchObject({
      code: 'LLM_TIMEOUT',
      message: 'AI 服务响应超时',
    })
    try {
      await client.complete([{ role: 'user', content: 'hello' }])
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ApplicationError)
      expect((error as ApplicationError).message).not.toContain('socket hang up')
      expect((error as ApplicationError).message).not.toContain('at ')
    }
  })

  it('maps HTTP 429 to LLM_RATE_LIMITED', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'slow down' }, 429))
    const client = new HttpLlmClient({ ...options, maxRetries: 0 }, fetchImpl, async () => undefined)

    await expect(client.complete([{ role: 'user', content: 'hello' }])).rejects.toMatchObject({
      code: 'LLM_RATE_LIMITED',
      message: 'AI 服务请求过于频繁',
    })
  })
})
