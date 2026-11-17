import { describe, expect, it } from 'vitest'
import type { NoteRecord } from '../api/notes.ts'
import {
  applySavedNote,
  composeLibrary,
  htmlForApi,
  isNoteDirty,
  libraryItemFromNote,
  mergeNotePages,
  noteCreatePayload,
  notePatchPayload,
  orderNotes,
  primaryUiTag,
  shouldApplyNoteList,
} from './library-item.ts'

const savedNote: NoteRecord = {
  noteId: 'note_1',
  title: '小记 · 灵感',
  tags: ['IDEA', 'WORK'],
  bodyHtml: '<p>服务端正文</p>',
  bodyText: '服务端正文',
  status: 'CREATED',
  createdAt: '2026-11-12T00:00:00.000Z',
  updatedAt: '2026-11-12T00:00:02.000Z',
  knowledgeItemId: 'item_1',
}

describe('note library mapping', () => {
  it('maps tags by priority and keeps a saved note out of the inbox badge', () => {
    const item = libraryItemFromNote(savedNote)
    expect(item).toMatchObject({
      id: 'note_1',
      status: 'done',
      persisted: true,
      title: '小记 · 灵感',
      desc: '服务端正文',
      body: '服务端正文',
      html: '<p>服务端正文</p>',
      serverTags: ['IDEA', 'WORK'],
      knowledgeItemId: 'item_1',
    })
    expect(item.tags).toEqual(['灵感', '工作'])
    expect(primaryUiTag(savedNote.tags)).toBe('灵感')
    expect(primaryUiTag(['WORK', 'TODO', 'IDEA'])).toBe('待办')
  })

  it('strips attachment carriers and unsafe urls before either write', () => {
    const html = '<p>正文</p><div data-nc-files="blob%3Ahttp%3A%2F%2Flocal%2F1"></div><img alt="" src="data:image/png;base64,aaa">'
    expect(htmlForApi(html)).toBe('<p>正文</p><img alt="">')
    expect(htmlForApi(html)).not.toContain('blob:')
    expect(htmlForApi(html)).not.toContain('data:')
    expect(noteCreatePayload({ title: '  课堂记录  ', tags: ['工作', '待办', '灵感'], html })).toEqual({
      title: '课堂记录',
      tags: ['TODO', 'IDEA', 'WORK'],
      bodyHtml: '<p>正文</p><img alt="">',
    })
    expect(noteCreatePayload({ title: '只有标题', tags: [], html: '<div><br></div>' })).toEqual({
      title: '只有标题',
      tags: [],
      bodyHtml: '',
    })
  })

  it('patches the full tag set only when that set changes and allows an empty body', () => {
    expect(notePatchPayload({
      title: '课堂记录',
      originalTitle: '课堂记录',
      tags: ['灵感', '待办'],
      originalTags: ['待办', '灵感'],
      html: '<p>新正文</p><div data-nc-files="x"></div>',
      originalHtml: '<p>旧正文</p>',
    })).toEqual({ bodyHtml: '<p>新正文</p>' })
    expect(notePatchPayload({
      title: '  新标题  ',
      originalTitle: '旧标题',
      tags: ['工作', '待办'],
      originalTags: ['灵感'],
      html: '',
      originalHtml: '<p>旧正文</p>',
    })).toEqual({ title: '新标题', tags: ['TODO', 'WORK'], bodyHtml: '' })
    expect(notePatchPayload({
      title: '课堂记录',
      originalTitle: '课堂记录',
      tags: [],
      originalTags: ['待办'],
      html: '<p>旧正文</p>',
      originalHtml: '<p>旧正文</p>',
    })).toEqual({ tags: [] })
  })

  it('keeps a dirty note when an older list response arrives', () => {
    const current = [{ id: 'note_1', draft: false, updatedAt: '2026-11-12T00:00:02.000Z', html: '用户刚写的' }]
    const incoming = [{ id: 'note_1', draft: false, updatedAt: '2026-11-12T00:00:01.000Z', html: '旧列表' }]
    expect(mergeNotePages(current, incoming, 1, new Set(['note_1']))).toEqual([current[0]])
    expect(mergeNotePages(current, [{ id: 'note_2', draft: false, updatedAt: '2026-11-12T00:00:01.000Z', html: '下一页' }], 2).map((note) => note.id)).toEqual(['note_1', 'note_2'])
    expect(shouldApplyNoteList(1, 2)).toBe(false)
    expect(shouldApplyNoteList(2, 2)).toBe(true)
  })

  it('keeps the newer editor text when a save response is stale', () => {
    const applied = applySavedNote({
      local: { title: '小记 · 待办', html: '<p>继续输入</p>', tags: ['待办'] },
      saved: savedNote,
      sameRevision: false,
    })
    expect(applied.overwriteContent).toBe(false)
    expect(applied).toMatchObject({ noteId: 'note_1', html: '<p>继续输入</p>', knowledgeItemId: 'item_1' })
    expect(isNoteDirty({ note: applied.html, original: savedNote.bodyHtml, tagChanged: false })).toBe(true)
  })

  it('places unsaved drafts ahead of server notes and drops the fixture once notes are ready', () => {
    const recordings = [{ id: 'rec_1', type: 'voice' }]
    const items = [
      { id: 'v1', type: 'voice' },
      { id: 'n1', type: 'note' },
      { id: 'd1', type: 'doc' },
    ]
    const notes = orderNotes([
      { id: 'note_old', type: 'note', draft: false, updatedAt: '2026-11-12T00:00:01.000Z' },
      { id: 'draft_1', type: 'note', draft: true, updatedAt: '' },
      { id: 'note_new', type: 'note', draft: false, updatedAt: '2026-11-12T00:00:03.000Z' },
    ])
    expect(notes.map((note) => note.id)).toEqual(['draft_1', 'note_new', 'note_old'])
    expect(composeLibrary(recordings, items, notes, true).map((item) => item.id)).toEqual([
      'rec_1',
      'v1',
      'draft_1',
      'note_new',
      'note_old',
      'd1',
    ])
    expect(composeLibrary(recordings, items, [], false).map((item) => item.id)).toEqual(['rec_1', 'v1', 'n1', 'd1'])
  })
})
