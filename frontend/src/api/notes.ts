import { ApiError, REQUEST_FAILED_MESSAGE, http, type HttpRequest, type HttpResponse } from './http.ts'

export const NOTE_TAG_CODES = ['TODO', 'IDEA', 'WORK'] as const
export type NoteTagCode = (typeof NOTE_TAG_CODES)[number]

export type NoteRecord = {
  noteId: string
  title: string
  tags: NoteTagCode[]
  bodyHtml: string
  bodyText: string
  status: 'CREATED'
  createdAt: string
  updatedAt: string
  knowledgeItemId: string | null
}

export type NoteListPage = {
  items: NoteRecord[]
  page: number
  pageSize: number
  total: number
}

export type NoteWrite = {
  title?: string
  tags?: readonly NoteTagCode[]
  bodyHtml?: string
}

export type DeletedNote = {
  noteId: string
  status: 'DELETED'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function dataOf(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body) || !isRecord(body.data)) return null
  return body.data
}

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function readTags(value: unknown): NoteTagCode[] | null {
  if (!Array.isArray(value)) return null
  const tags: NoteTagCode[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !NOTE_TAG_CODES.some((code) => code === entry) || tags.includes(entry as NoteTagCode)) return null
    tags.push(entry as NoteTagCode)
  }
  return tags
}

export function htmlHasAttachmentPayload(html: string): boolean {
  return /data-nc-files/i.test(html) || /(?:src|href)\s*=\s*["'](?:blob:|data:)/i.test(html)
}

function assertPersistable(body: NoteWrite): void {
  if (body.tags && body.tags.some((tag) => !NOTE_TAG_CODES.some((code) => code === tag))) {
    throw new ApiError(REQUEST_FAILED_MESSAGE, 0)
  }
  if (typeof body.bodyHtml === 'string' && htmlHasAttachmentPayload(body.bodyHtml)) {
    throw new ApiError(REQUEST_FAILED_MESSAGE, 0)
  }
}

export function parseNote(value: unknown): NoteRecord | null {
  if (!isRecord(value) || typeof value.noteId !== 'string' || !value.noteId) return null
  if (typeof value.title !== 'string' || typeof value.bodyHtml !== 'string' || typeof value.bodyText !== 'string') return null
  if (value.status !== 'CREATED') return null
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return null
  const tags = readTags(value.tags)
  if (!tags) return null
  if (value.knowledgeItemId != null && typeof value.knowledgeItemId !== 'string') return null
  return {
    noteId: value.noteId,
    title: value.title,
    tags,
    bodyHtml: value.bodyHtml,
    bodyText: value.bodyText,
    status: 'CREATED',
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    knowledgeItemId: typeof value.knowledgeItemId === 'string' ? value.knowledgeItemId : null,
  }
}

export function parseNoteList(body: unknown): NoteListPage | null {
  const data = dataOf(body)
  if (!data || !Array.isArray(data.items)) return null
  const page = readCount(data.page)
  const pageSize = readCount(data.pageSize)
  const total = readCount(data.total)
  if (page == null || pageSize == null || total == null) return null
  if (page < 1 || pageSize < 1 || total < 0) return null
  const items: NoteRecord[] = []
  for (const item of data.items) {
    const parsed = parseNote(item)
    if (!parsed) return null
    items.push(parsed)
  }
  return { items, page, pageSize, total }
}

function writeBody(input: NoteWrite): string {
  assertPersistable(input)
  const body: NoteWrite = {}
  if (input.title !== undefined) body.title = input.title
  if (input.tags !== undefined) body.tags = input.tags
  if (input.bodyHtml !== undefined) body.bodyHtml = input.bodyHtml
  return JSON.stringify(body)
}

export const NOTE_SAVE_TIMEOUT_MS = 20_000
export const NOTE_SAVE_TIMEOUT_MESSAGE = '保存超时，内容已保留，请再保存一次'
export const NOTE_CREATE_CONFLICT_MESSAGE = '创建请求发生冲突，内容已保留，没有新建第二篇'

export type NoteDraftBody = {
  title: string
  tags: readonly NoteTagCode[]
  bodyHtml: string
}

export type PendingNoteCreate = {
  idempotencyKey: string
  snapshot: NoteDraftBody | null
  noteId: string | null
  created: NoteRecord | null
}

export type CommittedNote = {
  note: NoteRecord
  sent: NoteDraftBody
}

function sameTags(left: readonly NoteTagCode[], right: readonly NoteTagCode[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index])
}

export function noteBodiesDiffer(snapshot: NoteDraftBody, latest: NoteDraftBody): NoteWrite | null {
  const patch: NoteWrite = {}
  if (latest.title !== snapshot.title) patch.title = latest.title
  if (!sameTags(snapshot.tags, latest.tags)) patch.tags = [...latest.tags]
  if (latest.bodyHtml !== snapshot.bodyHtml) patch.bodyHtml = latest.bodyHtml
  if (patch.title === undefined && patch.tags === undefined && patch.bodyHtml === undefined) return null
  return patch
}

export function sameNoteBody(left: NoteDraftBody, right: NoteDraftBody): boolean {
  return noteBodiesDiffer(left, right) === null
}

function copyBody(body: NoteDraftBody): NoteDraftBody {
  return { title: body.title, tags: [...body.tags], bodyHtml: body.bodyHtml }
}

async function withSaveTimeout(request: HttpRequest, path: string, init: RequestInit, timeoutMs: number): Promise<HttpResponse> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending = request(path, { ...init, signal: controller.signal }).then(
    (response) => ({ ok: true as const, response }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  try {
    const winner = await Promise.race([
      pending,
      new Promise<{ timeout: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timeout: true }), timeoutMs)
      }),
    ])
    if ('timeout' in winner) {
      controller.abort()
      throw new ApiError(NOTE_SAVE_TIMEOUT_MESSAGE, 0, 'REQUEST_TIMEOUT')
    }
    if (!winner.ok) throw winner.error
    return winner.response
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function runWithin<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending = work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  try {
    const winner = await Promise.race([
      pending,
      new Promise<{ timeout: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timeout: true }), timeoutMs)
      }),
    ])
    if ('timeout' in winner) throw new ApiError(NOTE_SAVE_TIMEOUT_MESSAGE, 0, 'REQUEST_TIMEOUT')
    if (!winner.ok) throw winner.error
    return winner.value
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function isCreateConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409
}

async function postSnapshot(
  pending: PendingNoteCreate,
  snapshot: NoteDraftBody,
  post: (snapshot: NoteDraftBody, key: string) => Promise<NoteRecord>,
  timeoutMs: number,
): Promise<NoteRecord> {
  try {
    return await runWithin(post(snapshot, pending.idempotencyKey), timeoutMs)
  } catch (error: unknown) {
    if (!isCreateConflict(error)) throw error
  }
  try {
    return await runWithin(post(snapshot, pending.idempotencyKey), timeoutMs)
  } catch (error: unknown) {
    if (isCreateConflict(error)) throw new ApiError(NOTE_CREATE_CONFLICT_MESSAGE, 409, 'NOTE_IDEMPOTENCY_CONFLICT')
    throw error
  }
}

export async function commitPendingNote(input: {
  pending: PendingNoteCreate
  readLatest: () => NoteDraftBody
  post: (snapshot: NoteDraftBody, key: string) => Promise<NoteRecord>
  patch: (noteId: string, body: NoteWrite) => Promise<NoteRecord>
  timeoutMs?: number
}): Promise<CommittedNote> {
  const timeoutMs = input.timeoutMs ?? NOTE_SAVE_TIMEOUT_MS
  if (!input.pending.idempotencyKey.trim()) throw new ApiError(REQUEST_FAILED_MESSAGE, 0)
  if (!input.pending.snapshot) input.pending.snapshot = copyBody(input.readLatest())
  const snapshot = input.pending.snapshot
  if (!input.pending.noteId) {
    const created = await postSnapshot(input.pending, snapshot, input.post, timeoutMs)
    input.pending.noteId = created.noteId
    input.pending.created = created
  }
  const noteId = input.pending.noteId
  const sent = copyBody(input.readLatest())
  const patch = noteBodiesDiffer(snapshot, sent)
  if (!patch) {
    if (!input.pending.created) throw new ApiError(REQUEST_FAILED_MESSAGE, 0)
    return { note: input.pending.created, sent: snapshot }
  }
  const note = await runWithin(input.patch(noteId, patch), timeoutMs)
  return { note, sent }
}

export function createSaveGate() {
  let ticket = 0
  let saving = false
  const settled = new Set<number>()
  return {
    begin(): number | null {
      if (saving) return null
      saving = true
      ticket += 1
      return ticket
    },
    end(current: number): boolean {
      if (current !== ticket || settled.has(current)) return false
      settled.add(current)
      saving = false
      return true
    },
    isSaving(): boolean {
      return saving
    },
  }
}

export async function createNote(
  input: { idempotencyKey: string; title: string; tags: readonly NoteTagCode[]; bodyHtml: string },
  request: HttpRequest = http.request,
  timeoutMs = NOTE_SAVE_TIMEOUT_MS,
): Promise<NoteRecord> {
  if (!input.idempotencyKey.trim()) throw new ApiError(REQUEST_FAILED_MESSAGE, 0)
  const response = await withSaveTimeout(request, '/api/notes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': input.idempotencyKey,
    },
    body: writeBody({ title: input.title, tags: input.tags, bodyHtml: input.bodyHtml }),
  }, timeoutMs)
  if (response.status !== 201 && response.status !== 200) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  const note = parseNote(dataOf(response.body))
  if (!note) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  return note
}

export async function fetchNoteList(page: number, pageSize = 20, request: HttpRequest = http.request): Promise<NoteListPage> {
  const response = await request(`/api/notes?page=${page}&pageSize=${pageSize}`)
  const listed = parseNoteList(response.body)
  if (!listed) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  return listed
}

export async function fetchNote(noteId: string, request: HttpRequest = http.request): Promise<NoteRecord> {
  const response = await request(`/api/notes/${encodeURIComponent(noteId)}`)
  const note = parseNote(dataOf(response.body))
  if (!note || note.noteId !== noteId) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  return note
}

export async function updateNote(
  noteId: string,
  input: NoteWrite,
  request: HttpRequest = http.request,
  timeoutMs = NOTE_SAVE_TIMEOUT_MS,
): Promise<NoteRecord> {
  if (input.title === undefined && input.tags === undefined && input.bodyHtml === undefined) {
    throw new ApiError(REQUEST_FAILED_MESSAGE, 0)
  }
  const response = await withSaveTimeout(request, `/api/notes/${encodeURIComponent(noteId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: writeBody(input),
  }, timeoutMs)
  const note = parseNote(dataOf(response.body))
  if (!note || note.noteId !== noteId) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  return note
}

export async function deleteNote(noteId: string, request: HttpRequest = http.request): Promise<DeletedNote> {
  const response = await request(`/api/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' })
  const data = dataOf(response.body)
  if (!data || data.noteId !== noteId || data.status !== 'DELETED') throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  return { noteId, status: 'DELETED' }
}
