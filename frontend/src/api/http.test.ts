import { describe, expect, it, vi } from 'vitest'
import { getDocumentText } from './document-text.ts'
import { getPdfContent } from './files.ts'
import { API_BASE_URL_INVALID_MESSAGE, API_BASE_URL_MISSING_MESSAGE, createHttp, resolveRequestUrl } from './http.ts'
import { fetchTask } from './tasks.ts'

const taskBody = {
  id: 'task_1',
  fileId: 'file_1',
  taskType: 'PROCESS_PDF',
  status: 'QUEUED',
  currentStep: 'EXTRACT_TEXT',
  progress: 0,
  errorCode: null,
  errorMessage: null,
  startedAt: null,
  finishedAt: null,
}

describe('API base URL', () => {
  it('keeps a relative /api path when development has no base URL', () => {
    expect(resolveRequestUrl('/api/files', { production: false })).toBe('/api/files')
    expect(resolveRequestUrl('api/files/file_1/content', { production: false })).toBe('/api/files/file_1/content')
  })

  it('joins a remote origin without a double slash or a repeated /api segment', () => {
    expect(resolveRequestUrl('/api/files', { production: true, baseUrl: 'https://api.example.com/' })).toBe('https://api.example.com/api/files')
    expect(resolveRequestUrl('/api/files/file_1/document-text', { production: true, baseUrl: 'https://api.example.com/api' })).toBe(
      'https://api.example.com/api/files/file_1/document-text',
    )
    expect(resolveRequestUrl('/api/tasks/task_1', { production: true, baseUrl: 'https://api.example.com/api/' })).toBe(
      'https://api.example.com/api/tasks/task_1',
    )
  })

  it('sends file, task, document text, and PDF requests through the same client', async () => {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input))
      if (String(input).endsWith('/content')) {
        return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { 'Content-Type': 'application/pdf' } })
      }
      if (String(input).endsWith('/document-text')) {
        return new Response(JSON.stringify({ data: { pages: [{ pageNumber: 1, content: '正文' }] } }), { status: 200 })
      }
      return new Response(JSON.stringify({ data: { task: taskBody } }), { status: 200 })
    })
    const client = createHttp(fetchImpl as typeof fetch, { production: true, baseUrl: 'https://api.example.com/' })

    await fetchTask('task_1', client.request)
    await getDocumentText('file_1', client.request)
    await getPdfContent('file_1', client.requestBlob)

    expect(urls).toEqual([
      'https://api.example.com/api/tasks/task_1',
      'https://api.example.com/api/files/file_1/document-text',
      'https://api.example.com/api/files/file_1/content',
    ])
  })

  it.each([
    'http://api.example.com',
    'https://localhost',
    'https://localhost:3000',
    'https://127.0.0.1',
    'https://127.0.0.1:3000',
    '/api',
    'api.example.com',
    'not a url',
  ])('rejects an unusable production API base: %s', async (baseUrl) => {
    const fetchImpl = vi.fn()
    const client = createHttp(fetchImpl as typeof fetch, { production: true, baseUrl })

    await expect(client.request('/api/files')).rejects.toThrow(API_BASE_URL_INVALID_MESSAGE)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not call fetch when a production build has no API base URL', async () => {
    const fetchImpl = vi.fn()
    const client = createHttp(fetchImpl as typeof fetch, { production: true })

    await expect(client.request('/api/files')).rejects.toThrow(API_BASE_URL_MISSING_MESSAGE)
    await expect(client.requestBlob('/api/files/file_1/content')).rejects.toThrow(API_BASE_URL_MISSING_MESSAGE)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends a request id when the page is not a secure context', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }))
    const randomUUID = crypto.randomUUID
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined })
    try {
      const client = createHttp(fetchImpl, { production: false })
      await client.request('/api/files')
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: randomUUID })
    }

    const init = fetchImpl.mock.calls[0]?.[1]
    expect(new Headers(init?.headers).get('X-Request-Id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })
})
