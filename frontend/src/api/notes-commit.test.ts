import { describe, expect, it } from 'vitest'
import { ApiError } from './http.ts'
import {
  NOTE_CREATE_CONFLICT_MESSAGE,
  commitPendingNote,
  createSaveGate,
  type NoteDraftBody,
  type NoteRecord,
  type PendingNoteCreate,
} from './notes.ts'

const original: NoteDraftBody = { title: '小记 · 待办', tags: ['TODO'], bodyHtml: '<p>原始</p>' }
const edited: NoteDraftBody = { title: '小记 · 灵感', tags: ['IDEA'], bodyHtml: '<p>修改</p>' }

function pending(): PendingNoteCreate {
  return { idempotencyKey: 'key-1', snapshot: null, noteId: null, created: null }
}

function record(body: NoteDraftBody, noteId = 'note_1'): NoteRecord {
  return {
    noteId,
    title: body.title,
    tags: [...body.tags],
    bodyHtml: body.bodyHtml,
    bodyText: body.bodyHtml.replace(/<[^>]+>/g, ''),
    status: 'CREATED',
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:01.000Z',
    knowledgeItemId: 'item_1',
  }
}

describe('pending note commit', () => {
  it('replays the original snapshot after a lost create and patches the later edit', async () => {
    const draft = pending()
    let latest = original
    const createdNote: { current: NoteRecord | null } = { current: null }
    const posts: NoteDraftBody[] = []
    const post = async (snapshot: NoteDraftBody, key: string) => {
      expect(key).toBe('key-1')
      posts.push({ ...snapshot, tags: [...snapshot.tags] })
      if (!createdNote.current) {
        createdNote.current = record(snapshot)
        throw new ApiError('请求失败', 0)
      }
      expect(snapshot).toEqual(original)
      return createdNote.current
    }
    const patches: Array<{ noteId: string; bodyHtml?: string; title?: string; tags?: readonly string[] }> = []
    const patch = async (noteId: string, body: { title?: string; tags?: readonly string[]; bodyHtml?: string }) => {
      patches.push({ noteId, ...body })
      return record({ title: body.title ?? original.title, tags: (body.tags ?? original.tags) as NoteDraftBody['tags'], bodyHtml: body.bodyHtml ?? original.bodyHtml })
    }

    await expect(commitPendingNote({ pending: draft, readLatest: () => latest, post, patch, timeoutMs: 1000 })).rejects.toMatchObject({ message: '请求失败' })
    expect(draft.noteId).toBeNull()
    expect(draft.snapshot).toEqual(original)
    latest = edited
    const saved = await commitPendingNote({ pending: draft, readLatest: () => latest, post, patch, timeoutMs: 1000 })
    expect(posts).toHaveLength(2)
    expect(posts[1]).toEqual(original)
    expect(patches).toEqual([{ noteId: 'note_1', title: edited.title, tags: edited.tags, bodyHtml: edited.bodyHtml }])
    expect(saved.note.bodyHtml).toBe(edited.bodyHtml)
    expect(saved.note.title).toBe(edited.title)
    expect(saved.sent).toEqual(edited)
    expect(createdNote.current?.noteId).toBe('note_1')
  })

  it('retries the same snapshot when the first create never landed', async () => {
    const draft = pending()
    let created = false
    let posts = 0
    const saved = commitPendingNote({
      pending: draft,
      readLatest: () => original,
      timeoutMs: 1000,
      post: async (snapshot, key) => {
        posts += 1
        expect(key).toBe('key-1')
        expect(snapshot).toEqual(original)
        if (!created) throw new ApiError('请求失败', 0)
        return record(snapshot)
      },
      patch: async () => {
        throw new Error('should not patch an unchanged draft')
      },
    })
    await expect(saved).rejects.toMatchObject({ message: '请求失败' })
    created = true
    await expect(commitPendingNote({
      pending: draft,
      readLatest: () => original,
      timeoutMs: 1000,
      post: async (snapshot, key) => {
        posts += 1
        expect(key).toBe('key-1')
        expect(snapshot).toEqual(original)
        return record(snapshot)
      },
      patch: async () => {
        throw new Error('should not patch an unchanged draft')
      },
    })).resolves.toMatchObject({ note: { noteId: 'note_1', bodyHtml: original.bodyHtml } })
    expect(posts).toBe(2)
  })

  it('keeps the recovered note and patches on the next save when the update fails', async () => {
    const draft = pending()
    let latest = original
    let stored: NoteRecord | null = null
    let posts = 0
    let patches = 0
    const post = async (snapshot: NoteDraftBody) => {
      posts += 1
      expect(snapshot).toEqual(original)
      if (!stored) {
        stored = record(snapshot)
        throw new ApiError('请求失败', 0)
      }
      return stored
    }
    const patch = async (noteId: string, body: { bodyHtml?: string }) => {
      patches += 1
      if (patches === 1) throw new ApiError('请求失败', 0)
      return record({ ...edited, bodyHtml: body.bodyHtml ?? edited.bodyHtml }, noteId)
    }
    await expect(commitPendingNote({ pending: draft, readLatest: () => latest, post, patch, timeoutMs: 1000 })).rejects.toMatchObject({ message: '请求失败' })
    latest = edited
    await expect(commitPendingNote({ pending: draft, readLatest: () => latest, post, patch, timeoutMs: 1000 })).rejects.toMatchObject({ message: '请求失败' })
    expect(draft.noteId).toBe('note_1')
    expect(posts).toBe(2)
    const saved = await commitPendingNote({ pending: draft, readLatest: () => latest, post, patch, timeoutMs: 1000 })
    expect(posts).toBe(2)
    expect(patches).toBe(2)
    expect(saved.note.bodyHtml).toBe(edited.bodyHtml)
    expect(saved.note.noteId).toBe('note_1')
  })

  it('stops after the snapshot itself conflicts and keeps the key', async () => {
    const draft = pending()
    let latest = original
    let posts = 0
    const post = async (snapshot: NoteDraftBody, key: string) => {
      posts += 1
      expect(key).toBe('key-1')
      expect(snapshot).toEqual(original)
      throw new ApiError('相同幂等键对应了不同的创建请求', 409, 'NOTE_IDEMPOTENCY_CONFLICT')
    }
    await expect(commitPendingNote({
      pending: draft,
      readLatest: () => latest,
      post,
      patch: async () => record(edited),
      timeoutMs: 1000,
    })).rejects.toMatchObject({ message: NOTE_CREATE_CONFLICT_MESSAGE, status: 409 })
    expect(posts).toBe(2)
    expect(draft.noteId).toBeNull()
    expect(draft.idempotencyKey).toBe('key-1')
    latest = edited
    await expect(commitPendingNote({
      pending: draft,
      readLatest: () => latest,
      post,
      patch: async () => record(edited),
      timeoutMs: 1000,
    })).rejects.toMatchObject({ status: 409 })
    expect(posts).toBe(4)
    expect(draft.snapshot).toEqual(original)
  })

  it('releases a timed out create without adopting the late response', async () => {
    const draft = pending()
    let release: ((note: NoteRecord) => void) | undefined
    const first = commitPendingNote({
      pending: draft,
      readLatest: () => original,
      timeoutMs: 20,
      post: () => new Promise((resolve) => {
        release = resolve
      }),
      patch: async () => {
        throw new Error('should not patch before the note id is known')
      },
    })
    await expect(first).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
    expect(draft.noteId).toBeNull()
    expect(draft.snapshot).toEqual(original)
    expect(draft.idempotencyKey).toBe('key-1')
    release?.(record(edited, 'note_late'))
    await Promise.resolve()
    expect(draft.noteId).toBeNull()
    const saved = await commitPendingNote({
      pending: draft,
      readLatest: () => original,
      timeoutMs: 1000,
      post: async (snapshot, key) => {
        expect(key).toBe('key-1')
        expect(snapshot).toEqual(original)
        return record(snapshot)
      },
      patch: async () => {
        throw new Error('should not patch an unchanged draft')
      },
    })
    expect(saved.note.noteId).toBe('note_1')
    expect(draft.noteId).toBe('note_1')
  })

  it('patches edits made while the original create is in flight', async () => {
    const draft = pending()
    let latest = original
    const saved = await commitPendingNote({
      pending: draft,
      readLatest: () => latest,
      timeoutMs: 1000,
      post: async (snapshot) => {
        expect(snapshot).toEqual(original)
        latest = edited
        return record(snapshot)
      },
      patch: async (_noteId, body) => record({
        title: body.title ?? original.title,
        tags: body.tags ?? original.tags,
        bodyHtml: body.bodyHtml ?? original.bodyHtml,
      }),
    })
    expect(saved.sent).toEqual(edited)
    expect(saved.note).toMatchObject({ noteId: 'note_1', title: edited.title, bodyHtml: edited.bodyHtml, tags: ['IDEA'] })
    expect(saved.note.bodyHtml).not.toBe(original.bodyHtml)
  })
})

describe('save gate', () => {
  it('does not let a finished request release the next save', () => {
    const gate = createSaveGate()
    const first = gate.begin()
    expect(first).toBe(1)
    expect(gate.begin()).toBeNull()
    expect(gate.end(first ?? 0)).toBe(true)
    expect(gate.isSaving()).toBe(false)
    const second = gate.begin()
    expect(gate.end(first ?? 0)).toBe(false)
    expect(gate.isSaving()).toBe(true)
    expect(gate.end(second ?? 0)).toBe(true)
    expect(gate.isSaving()).toBe(false)
  })
})
