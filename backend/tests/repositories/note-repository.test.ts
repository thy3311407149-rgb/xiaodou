import { afterEach, describe, expect, it } from 'vitest'
import { KnowledgeItemRepository } from '../../app/repositories/knowledge-item-repository.js'
import { NoteRepository } from '../../app/repositories/note-repository.js'
import { closeRepositoryTestDatabase, openRepositoryTestDatabase } from '../repository-test-helper.js'

let directory = ''
afterEach(async () => closeRepositoryTestDatabase(directory))

describe('NoteRepository', () => {
  it('creates, finds, pages, updates, and soft-deletes notes with their knowledge item', async () => {
    const context = await openRepositoryTestDatabase()
    directory = context.directory
    const notes = new NoteRepository(context.database)
    const knowledgeItems = new KnowledgeItemRepository(context.database)
    const fingerprint = 'a'.repeat(64)

    const created = notes.create({
      id: 'note_b',
      title: '较早',
      tags: ['WORK', 'TODO'],
      bodyHtml: '<p>正文</p>',
      bodyText: '正文',
      createRequestId: 'request_b',
      createRequestHash: fingerprint,
    })
    notes.create({
      id: 'note_c',
      title: '并列',
      tags: [],
      bodyHtml: '',
      bodyText: '',
      createRequestId: 'request_c',
      createRequestHash: 'b'.repeat(64),
    })
    notes.create({
      id: 'note_a',
      title: '最新',
      tags: ['IDEA'],
      bodyHtml: '<p>新</p>',
      bodyText: '新',
      createRequestId: 'request_a',
      createRequestHash: 'c'.repeat(64),
    })
    knowledgeItems.create({ id: 'item_b', sourceType: 'NOTE', sourceId: 'note_b', title: '较早', status: 'ACTIVE' })
    expect(notes.findById('note_b')).toEqual(created)
    context.database.prepare(`UPDATE notes SET updated_at = ? WHERE id = ?`).run('2026-11-12T00:00:02.000Z', 'note_b')
    context.database.prepare(`UPDATE notes SET updated_at = ? WHERE id = ?`).run('2026-11-12T00:00:02.000Z', 'note_c')
    context.database.prepare(`UPDATE notes SET updated_at = ? WHERE id = ?`).run('2026-11-12T00:00:01.000Z', 'note_a')

    expect(created).toMatchObject({
      id: 'note_b',
      title: '较早',
      tags: ['WORK', 'TODO'],
      bodyHtml: '<p>正文</p>',
      bodyText: '正文',
      status: 'CREATED',
      createRequestId: 'request_b',
      createRequestHash: fingerprint,
    })
    expect(notes.findByCreateRequestId('request_b')?.id).toBe('note_b')
    expect(notes.findWithKnowledgeItem('note_b')?.knowledgeItem).toMatchObject({
      id: 'item_b',
      sourceType: 'NOTE',
      sourceId: 'note_b',
      title: '较早',
      status: 'ACTIVE',
    })
    expect(notes.countCreated()).toBe(3)
    expect(notes.listCreated(2, 0).map((note) => note.id)).toEqual(['note_c', 'note_b'])
    expect(notes.listCreated(2, 2).map((note) => note.id)).toEqual(['note_a'])

    expect(notes.update('note_b', { title: '改标题', bodyHtml: '<p>改</p>', bodyText: '改' })).toMatchObject({
      title: '改标题',
      tags: ['WORK', 'TODO'],
      bodyHtml: '<p>改</p>',
      bodyText: '改',
      createRequestId: 'request_b',
      createRequestHash: fingerprint,
    })
    expect(notes.updateKnowledgeItemTitle('note_b', '改标题')).toBe(1)
    expect(notes.findWithKnowledgeItem('note_b')?.knowledgeItem?.title).toBe('改标题')

    expect(notes.markDeleted('note_b')?.status).toBe('DELETED')
    expect(notes.markKnowledgeItemDeleted('note_b')).toBe(1)
    expect(notes.findById('note_b')?.status).toBe('DELETED')
    expect(notes.findWithKnowledgeItem('note_b')?.knowledgeItem?.status).toBe('DELETED')
    expect(notes.countCreated()).toBe(2)
    expect(notes.listCreated(10, 0).map((note) => note.id)).not.toContain('note_b')
    expect(context.database.prepare(`SELECT COUNT(*) AS count FROM notes WHERE id = 'note_b'`).get()).toEqual({ count: 1 })
    expect(context.database.prepare(`SELECT COUNT(*) AS count FROM knowledge_items WHERE id = 'item_b'`).get()).toEqual({ count: 1 })
  })
})
