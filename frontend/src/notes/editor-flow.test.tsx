/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/http.ts'
import { NOTE_CREATE_CONFLICT_MESSAGE, NOTE_SAVE_TIMEOUT_MESSAGE, NOTE_SAVE_TIMEOUT_MS } from '../api/notes.ts'
import App from '../App.tsx'

const mocks = vi.hoisted(() => ({
  fetchNoteList: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
}))

vi.mock('../api/notes.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/notes.ts')>()
  return { ...actual, ...mocks }
})
vi.mock('../api/files.ts', () => ({ fetchStoredFiles: vi.fn(async () => []), uploadPdf: vi.fn() }))
vi.mock('../api/recordings.ts', () => ({ fetchRecordingList: vi.fn(async () => ({ items: [], page: 1, pageSize: 20, total: 0 })) }))
vi.mock('../api/tasks.ts', () => ({ fetchTask: vi.fn() }))

type StoredNote = {
  noteId: string
  title: string
  tags: string[]
  bodyHtml: string
  bodyText: string
  status: 'CREATED'
  createdAt: string
  updatedAt: string
  knowledgeItemId: string
}

const store: {
  notes: StoredNote[]
  keys: Map<string, { hash: string; note: StoredNote }>
  failCreates: number
  loseCreates: number
  failPatches: number
  forceConflict: boolean
} = {
  notes: [],
  keys: new Map(),
  failCreates: 0,
  loseCreates: 0,
  failPatches: 0,
  forceConflict: false,
}

function persistCreate(input: { idempotencyKey: string; title: string; tags: string[]; bodyHtml: string }): StoredNote {
  const hash = JSON.stringify({ title: input.title, tags: input.tags, bodyHtml: input.bodyHtml })
  const previous = store.keys.get(input.idempotencyKey)
  if (previous) {
    if (previous.hash !== hash) throw new ApiError('相同幂等键对应了不同的创建请求', 409, 'NOTE_IDEMPOTENCY_CONFLICT')
    return previous.note
  }
  if (store.failCreates > 0) {
    store.failCreates -= 1
    throw new ApiError('请求失败', 0)
  }
  if (store.forceConflict) throw new ApiError('相同幂等键对应了不同的创建请求', 409, 'NOTE_IDEMPOTENCY_CONFLICT')
  const note: StoredNote = {
    noteId: `note_${store.notes.length + 1}`,
    title: input.title,
    tags: input.tags,
    bodyHtml: input.bodyHtml,
    bodyText: textOf(input.bodyHtml),
    status: 'CREATED',
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
    knowledgeItemId: `item_${store.notes.length + 1}`,
  }
  store.notes.unshift(note)
  store.keys.set(input.idempotencyKey, { hash, note })
  if (store.loseCreates > 0) {
    store.loseCreates -= 1
    throw new ApiError('请求失败', 0)
  }
  return note
}

function textOf(html: string) {
  return html.replace(/<[^>]+>/g, '').trim()
}

beforeEach(() => {
  store.notes.length = 0
  store.keys.clear()
  store.failCreates = 0
  store.loseCreates = 0
  store.failPatches = 0
  store.forceConflict = false
  mocks.fetchNoteList.mockImplementation(async (page: number, pageSize = 20) => {
    const sorted = [...store.notes].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.noteId.localeCompare(left.noteId))
    const start = (page - 1) * pageSize
    return { items: sorted.slice(start, start + pageSize), page, pageSize, total: sorted.length }
  })
  mocks.createNote.mockImplementation(async (input: { idempotencyKey: string; title: string; tags: string[]; bodyHtml: string }) => persistCreate(input))
  mocks.updateNote.mockImplementation(async (noteId: string, patch: { title?: string; tags?: string[]; bodyHtml?: string }) => {
    if (store.failPatches > 0) {
      store.failPatches -= 1
      throw new ApiError('请求失败', 0)
    }
    const note = store.notes.find((item) => item.noteId === noteId)
    if (!note) throw new ApiError('随笔不存在', 404, 'NOTE_NOT_FOUND')
    if (patch.title !== undefined) note.title = patch.title
    if (patch.tags !== undefined) note.tags = patch.tags
    if (patch.bodyHtml !== undefined) {
      note.bodyHtml = patch.bodyHtml
      note.bodyText = textOf(patch.bodyHtml)
    }
    note.updatedAt = new Date().toISOString()
    return { ...note }
  })
  mocks.deleteNote.mockImplementation(async (noteId: string) => {
    const index = store.notes.findIndex((item) => item.noteId === noteId)
    if (index < 0) throw new ApiError('随笔不存在', 404, 'NOTE_NOT_FOUND')
    store.notes.splice(index, 1)
    return { noteId, status: 'DELETED' }
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function settleList() {
  await waitFor(() => expect(screen.queryByText('下周小组作业要用到社会认同实验。')).toBeNull())
}

async function writeNote(text: string) {
  const editor = await screen.findByRole('textbox', { name: '笔记正文' })
  editor.innerHTML = text ? `<div>${text}</div>` : ''
  fireEvent.input(editor)
  return editor
}

async function fillTitle(title: string) {
  fireEvent.change(await screen.findByRole('textbox', { name: '笔记标题' }), { target: { value: title } })
}

describe('note editor flow', () => {
  it('keeps a created note after refresh and opens it from the list, search, and review', async () => {
    const view = render(<App />)
    await settleList()
    fireEvent.click(screen.getByRole('button', { name: '闪念笔记' }))
    await fillTitle('持久化标题')
    await writeNote('持久化随笔')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('已保存')).toBeTruthy()
    expect(mocks.createNote).toHaveBeenCalledTimes(1)
    const created = mocks.createNote.mock.calls[0][0] as { idempotencyKey: string; title: string; bodyHtml: string; tags: string[] }
    expect(created.title).toBe('持久化标题')
    expect(created.tags).toEqual([])
    expect(created.bodyHtml).not.toContain('data-nc-files')
    expect(await screen.findByText('持久化标题')).toBeTruthy()

    view.unmount()
    render(<App />)
    expect(await screen.findByText('持久化标题')).toBeTruthy()
    expect(screen.queryByText('下周小组作业要用到社会认同实验。')).toBeNull()
    expect(screen.queryByText('待处理')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /持久化标题/ }))
    expect((await screen.findByRole('textbox', { name: '笔记标题' }))).toHaveProperty('value', '持久化标题')
    expect((await screen.findByRole('textbox', { name: '笔记正文' })).textContent).toContain('持久化随笔')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索笔记、录音、文档要点' }), { target: { value: '持久化随笔' } })
    fireEvent.click(await screen.findByRole('button', { name: /持久化标题/ }))
    expect((await screen.findByRole('textbox', { name: '笔记正文' })).textContent).toContain('持久化随笔')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    fireEvent.click(screen.getByRole('tab', { name: '知识库' }))
    fireEvent.click(screen.getByRole('button', { name: '温故反刍' }))
    fireEvent.click(screen.getByRole('button', { name: '立即重温 →' }))
    expect((await screen.findByRole('textbox', { name: '笔记正文' })).textContent).toContain('持久化随笔')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    fireEvent.click(screen.getByRole('tab', { name: '文件库' }))
    fireEvent.click(screen.getByRole('button', { name: '+ 添加知识' }))
    fireEvent.click(screen.getByRole('button', { name: '随笔' }))
    expect((await screen.findByRole('textbox', { name: '笔记标题' }))).toHaveProperty('value', '')
    expect((await screen.findByRole('textbox', { name: '笔记正文' })).textContent ?? '').not.toContain('持久化随笔')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.click(screen.getByRole('tab', { name: '知识库' }))
    expect(screen.getByText('持久化标题')).toBeTruthy()
  })

  it('patches changed text without tags and keeps later keystrokes', async () => {
    store.notes.push({
      noteId: 'note_existing',
      title: '小记 · 待办',
      tags: ['TODO', 'IDEA'],
      bodyHtml: '<p>原来的正文</p>',
      bodyText: '原来的正文',
      status: 'CREATED',
      createdAt: '2026-11-12T00:00:00.000Z',
      updatedAt: '2026-11-12T00:00:00.000Z',
      knowledgeItemId: 'item_existing',
    })
    const pending: { run: (() => void) | null } = { run: null }
    mocks.updateNote.mockImplementation((noteId: string, patch: { bodyHtml?: string }) => new Promise<StoredNote>((resolve) => {
      pending.run = () => {
        const note = store.notes.find((item) => item.noteId === noteId)
        if (!note) throw new ApiError('随笔不存在', 404, 'NOTE_NOT_FOUND')
        if (patch.bodyHtml !== undefined) {
          note.bodyHtml = patch.bodyHtml
          note.bodyText = textOf(patch.bodyHtml)
        }
        note.updatedAt = '2026-11-12T00:00:05.000Z'
        resolve({ ...note })
      }
    }))
    render(<App />)
    await settleList()
    fireEvent.click(screen.getByRole('button', { name: /小记 · 待办/ }))
    expect(screen.getByRole('button', { name: '待办' })).toHaveProperty('ariaPressed', 'true')
    expect(screen.getByRole('button', { name: '灵感' })).toHaveProperty('ariaPressed', 'true')
    expect(screen.getByRole('button', { name: '工作' })).toHaveProperty('ariaPressed', 'false')
    const editor = await writeNote('保存时的正文')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      if (!pending.run) throw new Error('保存还没有开始')
    })
    editor.innerHTML = '<div>保存后继续写</div>'
    fireEvent.input(editor)
    if (!pending.run) throw new Error('保存还没有开始')
    pending.run()
    expect(await screen.findByText('已更新')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '笔记正文' }).textContent).toContain('保存后继续写')
    const patch = mocks.updateNote.mock.calls[0][1] as { tags?: string[]; bodyHtml: string }
    expect(patch.tags).toBeUndefined()
    expect(patch.bodyHtml).toContain('保存时的正文')
    expect(patch.bodyHtml).not.toContain('保存后继续写')
    fireEvent.click(screen.getByRole('tab', { name: '文件库' }))
    fireEvent.click(screen.getByRole('button', { name: '+ 添加知识' }))
    fireEvent.click(screen.getByRole('button', { name: '随笔' }))
    expect(await screen.findByText('先保存当前随笔')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '笔记正文' }).textContent).toContain('保存后继续写')
  })

  it('keeps the draft and idempotency key when creating fails', async () => {
    store.failCreates = 1
    render(<App />)
    await settleList()
    fireEvent.click(screen.getByRole('button', { name: '闪念笔记' }))
    await fillTitle('失败标题')
    await writeNote('失败后还在')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('请求失败')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '笔记正文' }).textContent).toContain('失败后还在')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('已保存')).toBeTruthy()
    expect(mocks.createNote).toHaveBeenCalledTimes(2)
    const [first, second] = mocks.createNote.mock.calls.map((call) => call[0] as { idempotencyKey: string; bodyHtml: string })
    expect(second.idempotencyKey).toBe(first.idempotencyKey)
    expect(second.bodyHtml).toBe(first.bodyHtml)
    expect(store.notes).toHaveLength(1)
  })

  it('shows an empty review state and does not treat the fixture as a saved note', async () => {
    render(<App />)
    await settleList()
    fireEvent.click(screen.getByRole('button', { name: '温故反刍' }))
    fireEvent.click(screen.getByRole('button', { name: '立即重温 →' }))
    expect(await screen.findByText('暂无可重温的笔记')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '笔记正文' })).toBeNull()
  })

  it('removes a note after a confirmed swipe and after a missing note response', async () => {
    store.notes.push({
      noteId: 'note_existing',
      title: '小记 · 待办',
      tags: ['TODO'],
      bodyHtml: '<p>待删除</p>',
      bodyText: '待删除',
      status: 'CREATED',
      createdAt: '2026-11-12T00:00:00.000Z',
      updatedAt: '2026-11-12T00:00:00.000Z',
      knowledgeItemId: 'item_existing',
    })
    render(<App />)
    await settleList()
    const row = screen.getByRole('button', { name: /小记 · 待办/ })
    fireEvent.pointerDown(row, { clientX: 180, clientY: 40, button: 0, pointerId: 1 })
    fireEvent.pointerMove(row, { clientX: 40, clientY: 40, button: 0, pointerId: 1 })
    fireEvent.pointerUp(row, { clientX: 40, clientY: 40, button: 0, pointerId: 1 })
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    expect(await screen.findByText('已删除')).toBeTruthy()
    await waitFor(() => expect(screen.queryByText('小记 · 待办')).toBeNull())
    expect(mocks.deleteNote).toHaveBeenCalledWith('note_existing')
  })

  it('replays the original create after a lost response and patches the edited draft', async () => {
    store.loseCreates = 1
    render(<App />)
    await settleList()
    fireEvent.click(screen.getByRole('button', { name: '闪念笔记' }))
    await fillTitle('原始标题')
    await writeNote('原始正文')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('请求失败')).toBeTruthy()
    await writeNote('修改后的正文')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('已保存')).toBeTruthy()
    expect(mocks.createNote).toHaveBeenCalledTimes(2)
    const [first, second] = mocks.createNote.mock.calls.map((call) => call[0] as { idempotencyKey: string; title: string; tags: string[]; bodyHtml: string })
    expect(second.idempotencyKey).toBe(first.idempotencyKey)
    expect(second).toEqual(first)
    const patch = mocks.updateNote.mock.calls[0][1] as { bodyHtml: string }
    expect(patch.bodyHtml).toContain('修改后的正文')
    expect(patch.bodyHtml).not.toContain('原始正文')
    expect(store.notes).toHaveLength(1)
    expect(store.notes[0]?.bodyHtml).toContain('修改后的正文')
    expect(screen.queryByText('原始正文')).toBeNull()
  })

  it('patches a recovered note without creating another one when the first update fails', async () => {
    store.loseCreates = 1
    store.failPatches = 1
    render(<App />)
    await settleList()
    fireEvent.click(screen.getByRole('button', { name: '闪念笔记' }))
    await fillTitle('原始标题')
    await writeNote('原始正文')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('请求失败')).toBeTruthy()
    await writeNote('修改后的正文')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(mocks.updateNote).toHaveBeenCalledTimes(1))
    expect(screen.getByText('请求失败')).toBeTruthy()
    expect(mocks.createNote).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('textbox', { name: '笔记正文' }).textContent).toContain('修改后的正文')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('已更新')).toBeTruthy()
    expect(mocks.createNote).toHaveBeenCalledTimes(2)
    expect(mocks.updateNote).toHaveBeenCalledTimes(2)
    expect(store.notes).toHaveLength(1)
    expect(store.notes[0]?.bodyHtml).toContain('修改后的正文')
  })

  it('releases the save button after a hung request and retries the original snapshot', async () => {
    let hung = true
    mocks.createNote.mockImplementation(async (input: { idempotencyKey: string; title: string; tags: string[]; bodyHtml: string }) => {
      if (hung) return new Promise(() => {})
      return persistCreate(input)
    })
    render(<App />)
    await settleList()
    fireEvent.click(screen.getByRole('button', { name: '闪念笔记' }))
    await fillTitle('超时标题')
    await writeNote('超时后还在')
    fireEvent.click(screen.getByRole('button', { name: '待办' }))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTE_SAVE_TIMEOUT_MS)
    })
    expect(screen.getByRole('textbox', { name: '笔记标题' })).toHaveProperty('value', '超时标题')
    expect(screen.getByRole('textbox', { name: '笔记正文' }).textContent).toContain('超时后还在')
    expect(screen.getByRole('button', { name: '待办' }).className).toContain('on')
    expect(screen.getByText(NOTE_SAVE_TIMEOUT_MESSAGE)).toBeTruthy()
    vi.useRealTimers()
    hung = false
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('已保存')).toBeTruthy()
    expect(mocks.createNote).toHaveBeenCalledTimes(2)
    const [first, second] = mocks.createNote.mock.calls.map((call) => call[0] as { idempotencyKey: string; bodyHtml: string; tags: string[] })
    expect(second.idempotencyKey).toBe(first.idempotencyKey)
    expect(second.bodyHtml).toBe(first.bodyHtml)
    expect(second.tags).toEqual(['TODO'])
    expect(store.notes).toHaveLength(1)
  })

  it('drops a late create response and keeps the newer save locked', async () => {
    const deferred: Array<{ run: () => void }> = []
    mocks.createNote.mockImplementation((input: { idempotencyKey: string; title: string; tags: string[]; bodyHtml: string }) => new Promise((resolve) => {
      deferred.push({ run: () => resolve(persistCreate(input)) })
    }))
    render(<App />)
    await settleList()
    fireEvent.click(screen.getByRole('button', { name: '闪念笔记' }))
    await fillTitle('第一次标题')
    await writeNote('第一次正文')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTE_SAVE_TIMEOUT_MS)
    })
    vi.useRealTimers()
    await writeNote('第二次正文')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(mocks.createNote).toHaveBeenCalledTimes(2)
    await act(async () => {
      deferred[0]?.run()
    })
    expect(screen.getByRole('textbox', { name: '笔记正文' }).textContent).toContain('第二次正文')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(mocks.createNote).toHaveBeenCalledTimes(2)
    await act(async () => {
      deferred[1]?.run()
    })
    expect(await screen.findByText('已保存')).toBeTruthy()
    const replay = mocks.createNote.mock.calls[1]?.[0] as { bodyHtml: string; idempotencyKey: string }
    const original = mocks.createNote.mock.calls[0]?.[0] as { bodyHtml: string; idempotencyKey: string }
    expect(replay.idempotencyKey).toBe(original.idempotencyKey)
    expect(replay.bodyHtml).toContain('第一次正文')
    expect(replay.bodyHtml).not.toContain('第二次正文')
    const patch = mocks.updateNote.mock.calls[0]?.[1] as { bodyHtml: string }
    expect(patch.bodyHtml).toContain('第二次正文')
    expect(store.notes).toHaveLength(1)
    expect(store.notes[0]?.bodyHtml).toContain('第二次正文')
    expect(screen.queryByText('第一次正文')).toBeNull()
  })

  it('patches title, body, and tag changed while the first create is in flight', async () => {
    const pending: { run: (() => void) | null } = { run: null }
    mocks.createNote.mockImplementation((input: { idempotencyKey: string; title: string; tags: string[]; bodyHtml: string }) => new Promise((resolve) => {
      pending.run = () => resolve(persistCreate(input))
    }))
    render(<App />)
    await settleList()
    fireEvent.click(screen.getByRole('button', { name: '闪念笔记' }))
    await fillTitle('原来的标题')
    fireEvent.click(screen.getByRole('button', { name: '待办' }))
    await writeNote('原来的正文')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      if (!pending.run) throw new Error('创建还没有开始')
    })
    await fillTitle('新的标题')
    fireEvent.click(screen.getByRole('button', { name: '灵感' }))
    fireEvent.click(screen.getByRole('button', { name: '工作' }))
    await writeNote('新的正文')
    if (!pending.run) throw new Error('创建还没有开始')
    pending.run()
    expect(await screen.findByText('已保存')).toBeTruthy()
    const created = mocks.createNote.mock.calls[0]?.[0] as { title: string; tags: string[]; bodyHtml: string }
    expect(created.tags).toEqual(['TODO'])
    expect(created.title).toBe('原来的标题')
    expect(created.bodyHtml).toContain('原来的正文')
    expect(created.bodyHtml).not.toContain('新的正文')
    const patch = mocks.updateNote.mock.calls[0]?.[1] as { title?: string; tags?: string[]; bodyHtml?: string }
    expect(patch.title).toBe('新的标题')
    expect(patch.tags).toEqual(['TODO', 'IDEA', 'WORK'])
    expect(patch.bodyHtml).toContain('新的正文')
    expect(store.notes).toHaveLength(1)
    expect(store.notes[0]?.title).toBe('新的标题')
    expect(store.notes[0]?.tags).toEqual(['TODO', 'IDEA', 'WORK'])
    expect(store.notes[0]?.bodyHtml).toContain('新的正文')
    expect(screen.queryByText('原来的正文')).toBeNull()
    expect(screen.queryByText('原来的标题')).toBeNull()
  })

  it('stops after a second create conflict and does not mint another note', async () => {
    store.forceConflict = true
    render(<App />)
    await settleList()
    fireEvent.click(screen.getByRole('button', { name: '闪念笔记' }))
    await fillTitle('冲突标题')
    await writeNote('冲突后还在')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText(NOTE_CREATE_CONFLICT_MESSAGE)).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '笔记正文' }).textContent).toContain('冲突后还在')
    expect(store.notes).toHaveLength(0)
    expect(mocks.createNote).toHaveBeenCalledTimes(2)
    const [first, second] = mocks.createNote.mock.calls.map((call) => call[0] as { idempotencyKey: string; bodyHtml: string })
    expect(second.idempotencyKey).toBe(first.idempotencyKey)
    expect(second.bodyHtml).toBe(first.bodyHtml)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(mocks.createNote).toHaveBeenCalledTimes(4))
    expect(screen.getByText(NOTE_CREATE_CONFLICT_MESSAGE)).toBeTruthy()
    const keys = mocks.createNote.mock.calls.map((call) => (call[0] as { idempotencyKey: string }).idempotencyKey)
    expect(new Set(keys).size).toBe(1)
    expect(store.notes).toHaveLength(0)
  })

  it('requires a trimmed title and does not let a tag replace it', async () => {
    render(<App />)
    await settleList()
    fireEvent.click(screen.getByRole('button', { name: '闪念笔记' }))
    await writeNote('还没写标题')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('先填写标题')).toBeTruthy()
    expect(mocks.createNote).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: '笔记正文' }).textContent).toContain('还没写标题')
    await fillTitle('  我的标题  ')
    fireEvent.click(screen.getByRole('button', { name: '工作' }))
    fireEvent.click(screen.getByRole('button', { name: '待办' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('已保存')).toBeTruthy()
    const created = mocks.createNote.mock.calls[0]?.[0] as { title: string; tags: string[]; bodyHtml: string }
    expect(created.title).toBe('我的标题')
    expect(created.tags).toEqual(['TODO', 'WORK'])
    expect(created.bodyHtml).toContain('还没写标题')
  })

  it('creates a note with only a title, or a title and tags, and an empty body', async () => {
    render(<App />)
    await settleList()
    fireEvent.click(screen.getByRole('button', { name: '闪念笔记' }))
    await fillTitle('只有标题')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('已保存')).toBeTruthy()
    expect(mocks.createNote.mock.calls[0]?.[0]).toMatchObject({ title: '只有标题', tags: [], bodyHtml: '' })

    fireEvent.click(screen.getByRole('button', { name: '闪念笔记' }))
    await fillTitle('带标签')
    fireEvent.click(screen.getByRole('button', { name: '工作' }))
    fireEvent.click(screen.getByRole('button', { name: '灵感' }))
    fireEvent.click(screen.getByRole('button', { name: '待办' }))
    fireEvent.click(screen.getByRole('button', { name: '灵感' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(mocks.createNote).toHaveBeenCalledTimes(2))
    expect(mocks.createNote.mock.calls[1]?.[0]).toMatchObject({ title: '带标签', tags: ['TODO', 'WORK'], bodyHtml: '' })
  })

  it('restores every saved tag and can clear the body without resending tags', async () => {
    store.notes.push({
      noteId: 'note_existing',
      title: '课堂记录',
      tags: ['TODO', 'WORK'],
      bodyHtml: '<p>原来的正文</p><div data-nc-files="blob%3Ahttp%3A%2F%2Flocal%2F1"></div>',
      bodyText: '原来的正文',
      status: 'CREATED',
      createdAt: '2026-11-12T00:00:00.000Z',
      updatedAt: '2026-11-12T00:00:00.000Z',
      knowledgeItemId: 'item_existing',
    })
    render(<App />)
    await settleList()
    fireEvent.click(screen.getByRole('button', { name: /课堂记录/ }))
    expect(screen.getByRole('textbox', { name: '笔记标题' })).toHaveProperty('value', '课堂记录')
    expect(screen.getByRole('button', { name: '待办' }).className).toContain('on')
    expect(screen.getByRole('button', { name: '灵感' }).className).not.toContain('on')
    expect(screen.getByRole('button', { name: '工作' }).className).toContain('on')
    await fillTitle('  修改后的标题  ')
    await writeNote('')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('已更新')).toBeTruthy()
    const patch = mocks.updateNote.mock.calls[0]?.[1] as { title?: string; tags?: string[]; bodyHtml?: string }
    expect(patch.title).toBe('修改后的标题')
    expect(patch.tags).toBeUndefined()
    expect(patch.bodyHtml).toBe('')
    expect(JSON.stringify(patch)).not.toContain('data-nc-files')
    expect(JSON.stringify(patch)).not.toContain('blob:')
  })
})
