import { describe, expect, it, vi } from 'vitest'
import { ApiError, createHttp } from './http.ts'
import { createNote, deleteNote, fetchNote, fetchNoteList, updateNote } from './notes.ts'

const note = {
  noteId: 'note_1',
  title: '小记 · 待办',
  tags: ['TODO'],
  bodyHtml: '<p>正文</p>',
  bodyText: '正文',
  status: 'CREATED',
  createdAt: '2026-11-12T00:00:00.000Z',
  updatedAt: '2026-11-12T00:00:00.000Z',
  knowledgeItemId: 'item_1',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

describe('note client', () => {
  it('creates a note with an idempotency key and accepts the first response', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_input)).toBe('/api/notes')
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('key-1')
      expect(JSON.parse(String(init?.body))).toEqual({ title: '小记 · 待办', tags: ['TODO'], bodyHtml: '<p>正文</p>' })
      return jsonResponse({ requestId: 'req_1', data: note }, 201)
    })
    const client = createHttp(fetchImpl as typeof fetch)
    await expect(createNote({
      idempotencyKey: 'key-1',
      title: '小记 · 待办',
      tags: ['TODO'],
      bodyHtml: '<p>正文</p>',
    }, client.request)).resolves.toMatchObject({ noteId: 'note_1', knowledgeItemId: 'item_1' })
  })

  it('treats an idempotent replay as the same note', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ requestId: 'req_2', data: note }, 200))
    const client = createHttp(fetchImpl as typeof fetch)
    await expect(createNote({
      idempotencyKey: 'key-1',
      title: '小记 · 待办',
      tags: ['TODO'],
      bodyHtml: '<p>正文</p>',
    }, client.request)).resolves.toMatchObject({ noteId: 'note_1' })
  })

  it('does not send attachment markup or unsafe urls', async () => {
    const fetchImpl = vi.fn()
    const client = createHttp(fetchImpl as typeof fetch)
    const html = '<p>正文</p><div data-nc-files="blob%3Ahttp"></div><img src="data:image/png;base64,aaa">'
    await expect(createNote({
      idempotencyKey: 'key-1',
      title: '小记 · 待办',
      tags: ['TODO'],
      bodyHtml: html,
    }, client.request)).rejects.toBeInstanceOf(ApiError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reads the first page with the real total', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('/api/notes?page=1&pageSize=20')
      return jsonResponse({
        requestId: 'req_list',
        data: { items: [{ ...note, knowledgeItemId: undefined }], total: 21, page: 1, pageSize: 20 },
      })
    })
    const client = createHttp(fetchImpl as typeof fetch)
    await expect(fetchNoteList(1, 20, client.request)).resolves.toMatchObject({
      total: 21,
      page: 1,
      pageSize: 20,
      items: [{ noteId: 'note_1', knowledgeItemId: null }],
    })
  })

  it('reads one note with its knowledge item', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('/api/notes/note_1')
      return jsonResponse({ requestId: 'req_get', data: note })
    })
    const client = createHttp(fetchImpl as typeof fetch)
    await expect(fetchNote('note_1', client.request)).resolves.toMatchObject({ knowledgeItemId: 'item_1' })
  })

  it('patches only the fields it is given', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('PATCH')
      expect(JSON.parse(String(init?.body))).toEqual({ bodyHtml: '<p>新正文</p>' })
      return jsonResponse({ requestId: 'req_patch', data: { ...note, bodyHtml: '<p>新正文</p>', bodyText: '新正文' } })
    })
    const client = createHttp(fetchImpl as typeof fetch)
    await expect(updateNote('note_1', { bodyHtml: '<p>新正文</p>' }, client.request)).resolves.toMatchObject({ bodyText: '新正文' })
  })

  it('reads a deleted note', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('DELETE')
      return jsonResponse({ requestId: 'req_delete', data: { noteId: 'note_1', status: 'DELETED' } })
    })
    const client = createHttp(fetchImpl as typeof fetch)
    await expect(deleteNote('note_1', client.request)).resolves.toEqual({ noteId: 'note_1', status: 'DELETED' })
  })

  it('rejects a list payload that is missing the total', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ requestId: 'req_bad', data: { items: [], page: 1, pageSize: 20 } }))
    const client = createHttp(fetchImpl as typeof fetch)
    await expect(fetchNoteList(1, 20, client.request)).rejects.toBeInstanceOf(ApiError)
  })

  it('ends a hung save on timeout and aborts the request', async () => {
    let signal: AbortSignal | undefined
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal ?? undefined
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted', 'AbortError'))
      })
    }))
    const client = createHttp(fetchImpl as typeof fetch)
    await expect(createNote({
      idempotencyKey: 'key-1',
      title: '小记 · 待办',
      tags: ['TODO'],
      bodyHtml: '<p>正文</p>',
    }, client.request, 30)).rejects.toMatchObject({ message: '保存超时，内容已保留，请再保存一次', status: 0, code: 'REQUEST_TIMEOUT' })
    expect(signal?.aborted).toBe(true)
  })

  it('keeps a dropped connection as a request failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network down')
    })
    const client = createHttp(fetchImpl as typeof fetch)
    await expect(createNote({
      idempotencyKey: 'key-1',
      title: '小记 · 待办',
      tags: ['TODO'],
      bodyHtml: '<p>正文</p>',
    }, client.request, 1000)).rejects.toMatchObject({ message: '请求失败', status: 0, code: null })
  })

  it('ends a hung update on timeout', async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted', 'AbortError'))
      })
    }))
    const client = createHttp(fetchImpl as typeof fetch)
    await expect(updateNote('note_1', { bodyHtml: '<p>新正文</p>' }, client.request, 30)).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
  })
})
