import { afterEach, describe, expect, it } from 'vitest'
import { ApplicationError } from '../app/core/errors/application-error.js'
import { KnowledgeItemRepository } from '../app/repositories/knowledge-item-repository.js'
import { NoteRepository } from '../app/repositories/note-repository.js'
import { fingerprintNoteRequest, NoteService } from '../app/services/note-service.js'
import { sanitizeNoteHtml } from '../app/services/note/html-sanitizer.js'
import { closeRepositoryTestDatabase, insertTestFile, openRepositoryTestDatabase } from './repository-test-helper.js'

let directory = ''
afterEach(async () => closeRepositoryTestDatabase(directory))

describe('NoteService', () => {
  it('creates a note and its NOTE knowledge item in one transaction', async () => {
    const service = await openService()
    const created = service.create({
      idempotencyKey: 'request-1',
      title: '  标题  ',
      tags: ['WORK', 'TODO', 'TODO'],
      bodyHtml: '<p onclick="alert(1)">正文</p><script>alert(1)</script>',
    })

    expect(created).toMatchObject({
      title: '标题',
      tags: ['TODO', 'WORK'],
      bodyHtml: '<p>正文</p>',
      bodyText: '正文',
      status: 'CREATED',
      createRequestId: 'request-1',
    })
    expect(created.knowledgeItem).toMatchObject({
      sourceType: 'NOTE',
      sourceId: created.id,
      title: '标题',
      status: 'ACTIVE',
    })
    expect(created.createRequestHash).toBe(fingerprintNoteRequest({
      title: '标题',
      tags: ['TODO', 'WORK'],
      bodyHtml: '<p>正文</p>',
    }))
  })

  it('returns the current note for the same request and rejects a different request', async () => {
    const { service, database } = await openContext()
    const created = service.create({ idempotencyKey: 'request-1', title: '标题', tags: ['IDEA'], bodyHtml: '<p>正文</p>' })
    const repeated = service.create({ idempotencyKey: ' request-1 ', title: '标题', tags: ['IDEA'], bodyHtml: '<p>正文</p>' })
    expect(repeated.id).toBe(created.id)

    service.update(created.id, { title: '编辑后的标题' })
    const retried = service.create({ idempotencyKey: 'request-1', title: '标题', tags: ['IDEA'], bodyHtml: '<p>正文</p>' })
    expect(retried).toMatchObject({
      id: created.id,
      title: '编辑后的标题',
      createRequestId: 'request-1',
      createRequestHash: created.createRequestHash,
    })
    expect(database.prepare(`SELECT COUNT(*) AS count FROM notes`).get()).toEqual({ count: 1 })

    expect(() => service.create({
      idempotencyKey: 'request-1',
      title: '另一篇',
      tags: ['IDEA'],
      bodyHtml: '<p>正文</p>',
    })).toThrow(ApplicationError)
    try {
      service.create({ idempotencyKey: 'request-1', title: '另一篇', tags: [], bodyHtml: '' })
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ApplicationError)
      expect((error as ApplicationError).code).toBe('NOTE_IDEMPOTENCY_CONFLICT')
      expect((error as ApplicationError).httpStatus).toBe(409)
    }
    expect(database.prepare(`SELECT title FROM notes WHERE id = ?`).get(created.id)).toEqual({ title: '编辑后的标题' })
  })

  it('resolves a concurrent insert through the unique index', async () => {
    const { service, database, notes, knowledgeItems } = await openContext()
    const input = { idempotencyKey: 'request-race', title: '标题', tags: ['TODO'] as const, bodyHtml: '<p>正文</p><script>alert(1)</script>' }
    const sanitized = sanitizeNoteHtml(input.bodyHtml)
    const hash = fingerprintNoteRequest({ title: input.title, tags: ['TODO'], bodyHtml: sanitized })
    let primed = false
    notes.findByCreateRequestId = (key: string) => {
      if (!primed) {
        primed = true
        notes.create({
          id: 'winner',
          title: input.title,
          tags: ['TODO'],
          bodyHtml: sanitized,
          bodyText: '正文',
          createRequestId: key,
          createRequestHash: hash,
        })
        knowledgeItems.create({ id: 'item-winner', sourceType: 'NOTE', sourceId: 'winner', title: input.title, status: 'ACTIVE' })
        return null
      }
      return NoteRepository.prototype.findByCreateRequestId.call(notes, key)
    }

    const created = service.create(input)
    expect(created.id).toBe('winner')
    expect(database.prepare(`SELECT COUNT(*) AS count FROM notes`).get()).toEqual({ count: 1 })
    expect(database.prepare(`SELECT COUNT(*) AS count FROM knowledge_items WHERE source_type = 'NOTE'`).get()).toEqual({ count: 1 })
  })

  it('reports a conflict when the concurrent insert has a different fingerprint', async () => {
    const { service, database, notes, knowledgeItems } = await openContext()
    let primed = false
    notes.findByCreateRequestId = (key: string) => {
      if (!primed) {
        primed = true
        notes.create({
          id: 'winner',
          title: '另一篇',
          tags: [],
          bodyHtml: '',
          bodyText: '',
          createRequestId: key,
          createRequestHash: 'b'.repeat(64),
        })
        knowledgeItems.create({ id: 'item-winner', sourceType: 'NOTE', sourceId: 'winner', title: '另一篇', status: 'ACTIVE' })
        return null
      }
      return NoteRepository.prototype.findByCreateRequestId.call(notes, key)
    }

    expect(() => service.create({ idempotencyKey: 'request-race', title: '标题', bodyHtml: '<p>正文</p>' })).toThrow(expect.objectContaining({
      code: 'NOTE_IDEMPOTENCY_CONFLICT',
      httpStatus: 409,
    }))
    expect(database.prepare(`SELECT COUNT(*) AS count FROM notes`).get()).toEqual({ count: 1 })
  })

  it('rolls back the note when the knowledge item write fails', async () => {
    const { database, notes } = await openContext()
    const service = new NoteService({
      database,
      noteRepository: notes,
      knowledgeItemRepository: {
        create() {
          throw new Error('knowledge write failed')
        },
      },
    })

    expect(() => service.create({ idempotencyKey: 'request-1', title: '标题', bodyHtml: '' })).toThrow(/knowledge write failed/)
    expect(database.prepare(`SELECT COUNT(*) AS count FROM notes`).get()).toEqual({ count: 0 })
    expect(database.prepare(`SELECT COUNT(*) AS count FROM knowledge_items`).get()).toEqual({ count: 0 })
  })

  it('updates only supplied fields and keeps the create fingerprint', async () => {
    const { service, database } = await openContext()
    const created = service.create({
      idempotencyKey: 'request-1',
      title: '标题',
      tags: ['TODO'],
      bodyHtml: '<p>正文</p>',
    })
    const knowledgeId = created.knowledgeItem?.id

    const renamed = service.update(created.id, { title: '  新标题  ' })
    expect(renamed).toMatchObject({
      title: '新标题',
      tags: ['TODO'],
      bodyHtml: '<p>正文</p>',
      bodyText: '正文',
      createRequestId: 'request-1',
      createRequestHash: created.createRequestHash,
    })
    expect(renamed.knowledgeItem).toMatchObject({
      id: knowledgeId,
      sourceType: 'NOTE',
      sourceId: created.id,
      title: '新标题',
    })

    const rewritten = service.update(created.id, { bodyHtml: '<div>你好</div><div>世界</div><script>alert(1)</script>' })
    expect(rewritten.bodyHtml).toBe('<div>你好</div><div>世界</div>')
    expect(rewritten.bodyText).toBe('你好\n世界')
    expect(rewritten.title).toBe('新标题')
    expect(rewritten.createRequestHash).toBe(created.createRequestHash)

    const retagged = service.update(created.id, { tags: ['IDEA', 'WORK'] })
    expect(retagged.tags).toEqual(['IDEA', 'WORK'])
    expect(retagged.bodyText).toBe('你好\n世界')
    expect(database.prepare(`SELECT title FROM knowledge_items WHERE id = ?`).get(knowledgeId)).toEqual({ title: '新标题' })

    const emptied = service.update(created.id, { bodyHtml: '' })
    expect(emptied.bodyHtml).toBe('')
    expect(emptied.bodyText).toBe('')
  })

  it('rejects an empty title, an unknown tag, and a missing idempotency key', async () => {
    const service = await openService()
    expect(() => service.create({ idempotencyKey: 'request-1', title: '   ', bodyHtml: '' })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(() => service.create({ idempotencyKey: 'request-1', title: '标题', tags: ['OTHER'], bodyHtml: '' })).toThrow(/无法识别的标签/)
    expect(() => service.create({ idempotencyKey: '   ', title: '标题', bodyHtml: '' })).toThrow(/缺少幂等键/)
  })

  it('soft-deletes the note and knowledge item without deleting rows or tasks', async () => {
    const { service, database } = await openContext()
    insertTestFile(database, 'file_pdf')
    database.prepare(`
      INSERT INTO knowledge_items (id, source_type, source_id, title)
      VALUES ('item_pdf', 'PDF', 'file_pdf', 'one.pdf')
    `).run()
    const created = service.create({ idempotencyKey: 'request-1', title: '标题', bodyHtml: '<p>正文</p>' })
    database.prepare(`
      INSERT INTO tasks (id, note_id, task_type, current_step, request_id)
      VALUES ('task_note', ?, 'PROCESS_NOTE', 'GENERATE_SUMMARY', 'request_note')
    `).run(created.id)

    const deleted = service.delete(created.id)
    expect(deleted.status).toBe('DELETED')
    expect(deleted.knowledgeItem?.status).toBe('DELETED')
    expect(service.get(created.id).status).toBe('DELETED')
    expect(service.list({ page: 1, pageSize: 20 })).toMatchObject({ items: [], total: 0 })
    expect(database.prepare(`SELECT status FROM notes WHERE id = ?`).get(created.id)).toEqual({ status: 'DELETED' })
    expect(database.prepare(`SELECT id FROM tasks WHERE note_id = ?`).get(created.id)).toEqual({ id: 'task_note' })
    expect(database.prepare(`SELECT status FROM knowledge_items WHERE source_type = 'PDF'`).get()).toEqual({ status: 'ACTIVE' })
    expect(service.delete(created.id).id).toBe(created.id)
  })

  it('rolls back a delete when the knowledge item update fails', async () => {
    const { database, notes } = await openContext()
    const service = new NoteService({ database, noteRepository: notes })
    const created = service.create({ idempotencyKey: 'request-1', title: '标题', bodyHtml: '' })
    notes.markKnowledgeItemDeleted = () => {
      throw new Error('knowledge status failed')
    }

    expect(() => service.delete(created.id)).toThrow(/knowledge status failed/)
    expect(database.prepare(`SELECT status FROM notes WHERE id = ?`).get(created.id)).toEqual({ status: 'CREATED' })
    expect(database.prepare(`SELECT status FROM knowledge_items WHERE source_id = ?`).get(created.id)).toEqual({ status: 'ACTIVE' })
  })

  it('refuses to edit a deleted note', async () => {
    const { service, database } = await openContext()
    const created = service.create({ idempotencyKey: 'request-1', title: '标题', tags: ['TODO'], bodyHtml: '<p>正文</p>' })
    service.delete(created.id)

    expect(() => service.update(created.id, { title: '新标题' })).toThrow(expect.objectContaining({ code: 'INVALID_NOTE_STATE' }))
    expect(database.prepare(`SELECT title, status FROM notes WHERE id = ?`).get(created.id)).toEqual({
      title: '标题',
      status: 'DELETED',
    })
    expect(database.prepare(`SELECT title, status FROM knowledge_items WHERE source_id = ?`).get(created.id)).toEqual({
      title: '标题',
      status: 'DELETED',
    })
  })
})

async function openService(): Promise<NoteService> {
  const context = await openContext()
  return context.service
}

async function openContext(): Promise<{
  service: NoteService
  database: Awaited<ReturnType<typeof openRepositoryTestDatabase>>['database']
  notes: NoteRepository
  knowledgeItems: KnowledgeItemRepository
}> {
  const opened = await openRepositoryTestDatabase()
  directory = opened.directory
  const notes = new NoteRepository(opened.database)
  const knowledgeItems = new KnowledgeItemRepository(opened.database)
  return {
    service: new NoteService({ database: opened.database, noteRepository: notes, knowledgeItemRepository: knowledgeItems }),
    database: opened.database,
    notes,
    knowledgeItems,
  }
}
