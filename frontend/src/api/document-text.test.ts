import { describe, expect, it, vi } from 'vitest'
import { createHttp } from './http.ts'
import { getDocumentText } from './document-text.ts'
import { getPdfContent } from './files.ts'

describe('document text and pdf content', () => {
  it('loads pages from GET /api/files/:fileId/document-text', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/files/file_1/document-text')
      expect(new Headers(init?.headers).get('X-Request-Id')).toBeTruthy()
      return new Response(JSON.stringify({
        requestId: 'req_text',
        data: { pages: [{ pageNumber: 1, content: '第一页正文' }, { pageNumber: 2, content: '第二页正文' }] },
      }), { status: 200 })
    })
    const client = createHttp(fetchImpl as typeof fetch)
    await expect(getDocumentText('file_1', client.request)).resolves.toEqual([
      { pageNumber: 1, content: '第一页正文' },
      { pageNumber: 2, content: '第二页正文' },
    ])
  })

  it('loads the pdf binary from GET /api/files/:fileId/content', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('/api/files/file_1/content')
      return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { 'Content-Type': 'application/pdf' } })
    })
    const client = createHttp(fetchImpl as typeof fetch)
    const blob = await getPdfContent('file_1', client.requestBlob)
    expect(blob.type).toBe('application/pdf')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]))
  })
})
