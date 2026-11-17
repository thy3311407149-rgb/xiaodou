import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../app/app.js'
import { NoteService } from '../app/services/note-service.js'
import { closeRepositoryTestDatabase, insertTestFile, openRepositoryTestDatabase } from './repository-test-helper.js'

let directory = ''

afterEach(async () => {
  if (directory) {
    await closeRepositoryTestDatabase(directory)
    directory = ''
  }
})

describe('note API', () => {
  it('creates a note, rejects invalid input, and replays the same idempotency key', async () => {
    const { app, database } = await openApi()
    const created = await request(app)
      .post('/api/notes')
      .set('Idempotency-Key', 'request-1')
      .send({ title: '  标题  ', tags: ['WORK', 'TODO'], bodyHtml: '<p onclick="alert(1)">正文</p>' })

    expect(created.status).toBe(201)
    expect(created.body.data).toMatchObject({
      title: '标题',
      tags: ['TODO', 'WORK'],
      bodyHtml: '<p>正文</p>',
      bodyText: '正文',
      status: 'CREATED',
      knowledgeItemId: expect.any(String),
    })
    expect(created.body.requestId).toEqual(expect.any(String))
    expect(created.body.data.createRequestId).toBeUndefined()
    expect(created.body.data.createRequestHash).toBeUndefined()
    expect(database.prepare(`
      SELECT source_type, source_id, title, status
      FROM knowledge_items WHERE id = ?
    `).get(created.body.data.knowledgeItemId)).toEqual({
      source_type: 'NOTE',
      source_id: created.body.data.noteId,
      title: '标题',
      status: 'ACTIVE',
    })

    const replay = await request(app)
      .post('/api/notes')
      .set('Idempotency-Key', 'request-1')
      .send({ title: '标题', tags: ['TODO', 'WORK'], bodyHtml: '<p>正文</p>' })
    expect(replay.status).toBe(200)
    expect(replay.body.data.noteId).toBe(created.body.data.noteId)

    const conflict = await request(app)
      .post('/api/notes')
      .set('Idempotency-Key', 'request-1')
      .send({ title: '另一篇', tags: ['TODO'], bodyHtml: '<p>正文</p>' })
    expect(conflict.status).toBe(409)
    expect(conflict.body.error.code).toBe('NOTE_IDEMPOTENCY_CONFLICT')
    expect(JSON.stringify(conflict.body)).not.toContain('createRequestHash')

    const missingKey = await request(app).post('/api/notes').send({ title: '标题' })
    expect(missingKey.status).toBe(400)
    expect(missingKey.body.error.code).toBe('INVALID_REQUEST')

    const emptyTitle = await request(app).post('/api/notes').set('Idempotency-Key', 'request-2').send({ title: '   ' })
    expect(emptyTitle.status).toBe(400)

    const badTag = await request(app).post('/api/notes').set('Idempotency-Key', 'request-3').send({ title: '标题', tags: ['OTHER'] })
    expect(badTag.status).toBe(400)

    const emptyBody = await request(app).post('/api/notes').set('Idempotency-Key', 'request-4').send({ title: '空正文' })
    expect(emptyBody.status).toBe(201)
    expect(emptyBody.body.data).toMatchObject({ bodyHtml: '', bodyText: '' })

    const internalField = await request(app)
      .post('/api/notes')
      .set('Idempotency-Key', 'request-5')
      .send({ title: '标题', bodyText: '客户端正文', status: 'DELETED' })
    expect(internalField.status).toBe(400)
    expect(database.prepare(`SELECT COUNT(*) AS count FROM notes WHERE title = '标题' AND create_request_id = 'request-5'`).get()).toEqual({ count: 0 })

    const invalidJson = await request(app)
      .post('/api/notes')
      .set('Content-Type', 'application/json')
      .set('Idempotency-Key', 'request-6')
      .send('{"title":')
    expect(invalidJson.status).toBe(400)
    expect(invalidJson.body.error).toMatchObject({ code: 'INVALID_REQUEST', message: '请求体不是有效的 JSON' })
    expect(JSON.stringify(invalidJson.body)).not.toContain('SyntaxError')
  })

  it('lists only active notes with the real total and repository order', async () => {
    const { app, database } = await openApi()
    const older = await createNote(app, 'request-old', '较早')
    const middle = await createNote(app, 'request-middle', '中间')
    const newer = await createNote(app, 'request-new', '最新')
    const removed = await createNote(app, 'request-removed', '已删')
    database.prepare(`UPDATE notes SET updated_at = ? WHERE id = ?`).run('2026-11-12T00:00:01.000Z', older)
    database.prepare(`UPDATE notes SET updated_at = ? WHERE id = ?`).run('2026-11-12T00:00:02.000Z', middle)
    database.prepare(`UPDATE notes SET updated_at = ? WHERE id = ?`).run('2026-11-12T00:00:03.000Z', newer)
    database.prepare(`UPDATE notes SET updated_at = ? WHERE id = ?`).run('2026-11-12T00:00:04.000Z', removed)
    expect((await request(app).delete(`/api/notes/${removed}`)).status).toBe(200)

    const defaults = await request(app).get('/api/notes')
    expect(defaults.status).toBe(200)
    expect(defaults.body.data).toMatchObject({ page: 1, pageSize: 20, total: 3 })
    expect(defaults.body.data.items.map((item: { noteId: string }) => item.noteId)).toEqual([newer, middle, older])
    expect(defaults.body.data.items[0]).toMatchObject({
      noteId: newer,
      title: '最新',
      bodyHtml: '',
      bodyText: '',
      status: 'CREATED',
    })
    expect(defaults.body.data.items[0].createRequestHash).toBeUndefined()

    const page = await request(app).get('/api/notes').query({ page: '2', pageSize: '2' })
    expect(page.status).toBe(200)
    expect(page.body.data).toMatchObject({ page: 2, pageSize: 2, total: 3 })
    expect(page.body.data.items.map((item: { noteId: string }) => item.noteId)).toEqual([older])

    expect((await request(app).get('/api/notes').query({ page: '0' })).status).toBe(400)
    expect((await request(app).get('/api/notes').query({ pageSize: 'abc' })).status).toBe(400)
    expect((await request(app).get('/api/notes').query({ pageSize: '101' })).status).toBe(400)
  })

  it('returns a visible note and hides missing or deleted notes', async () => {
    const { app } = await openApi()
    const noteId = await createNote(app, 'request-1', '标题', '<p>正文</p>')
    const detail = await request(app).get(`/api/notes/${noteId}`)
    expect(detail.status).toBe(200)
    expect(detail.body.data).toMatchObject({
      noteId,
      title: '标题',
      bodyHtml: '<p>正文</p>',
      bodyText: '正文',
      status: 'CREATED',
      knowledgeItemId: expect.any(String),
    })
    expect(detail.body.data.createRequestId).toBeUndefined()
    expect(detail.body.data.createRequestHash).toBeUndefined()

    expect((await request(app).get('/api/notes/missing-note')).status).toBe(404)
    expect((await request(app).get('/api/notes/missing-note')).body.error.code).toBe('NOTE_NOT_FOUND')

    await request(app).delete(`/api/notes/${noteId}`)
    const deleted = await request(app).get(`/api/notes/${noteId}`)
    expect(deleted.status).toBe(404)
    expect(deleted.body.error.code).toBe('NOTE_NOT_FOUND')
  })

  it('updates only supplied fields and keeps the knowledge item identity', async () => {
    const { app, database } = await openApi()
    const noteId = await createNote(app, 'request-1', '标题', '<p>正文</p>')
    const original = await request(app).get(`/api/notes/${noteId}`)
    const knowledgeItemId = original.body.data.knowledgeItemId as string
    const fingerprint = database.prepare(`SELECT create_request_hash FROM notes WHERE id = ?`).get(noteId)

    const renamed = await request(app).patch(`/api/notes/${noteId}`).send({ title: '  新标题  ' })
    expect(renamed.status).toBe(200)
    expect(renamed.body.data).toMatchObject({
      noteId,
      title: '新标题',
      bodyHtml: '<p>正文</p>',
      bodyText: '正文',
      knowledgeItemId,
    })
    expect(database.prepare(`SELECT title, source_id FROM knowledge_items WHERE id = ?`).get(knowledgeItemId)).toEqual({
      title: '新标题',
      source_id: noteId,
    })

    const retagged = await request(app).patch(`/api/notes/${noteId}`).send({ tags: ['IDEA'] })
    expect(retagged.status).toBe(200)
    expect(retagged.body.data.tags).toEqual(['IDEA'])
    expect(retagged.body.data.title).toBe('新标题')

    const rewritten = await request(app).patch(`/api/notes/${noteId}`).send({ bodyHtml: '<div>你好</div><script>alert(1)</script>' })
    expect(rewritten.status).toBe(200)
    expect(rewritten.body.data).toMatchObject({ bodyHtml: '<div>你好</div>', bodyText: '你好', title: '新标题' })

    const combined = await request(app).patch(`/api/notes/${noteId}`).send({
      title: '合并标题',
      tags: ['WORK'],
      bodyHtml: '<p>合并</p>',
    })
    expect(combined.status).toBe(200)
    expect(combined.body.data).toMatchObject({ title: '合并标题', tags: ['WORK'], bodyHtml: '<p>合并</p>', bodyText: '合并' })

    const emptied = await request(app).patch(`/api/notes/${noteId}`).send({ bodyHtml: '' })
    expect(emptied.status).toBe(200)
    expect(emptied.body.data).toMatchObject({ bodyHtml: '', bodyText: '', title: '合并标题' })
    expect(database.prepare(`SELECT create_request_hash FROM notes WHERE id = ?`).get(noteId)).toEqual(fingerprint)

    expect((await request(app).patch(`/api/notes/${noteId}`).send({ title: '  ' })).status).toBe(400)
    expect((await request(app).patch(`/api/notes/${noteId}`).send({ tags: ['NOPE'] })).status).toBe(400)
    expect((await request(app).patch(`/api/notes/${noteId}`).send({ bodyText: '伪造正文' })).status).toBe(400)
    expect((await request(app).patch('/api/notes/missing-note').send({ title: '标题' })).status).toBe(404)

    await request(app).delete(`/api/notes/${noteId}`)
    const deletedUpdate = await request(app).patch(`/api/notes/${noteId}`).send({ title: '不能改' })
    expect(deletedUpdate.status).toBe(404)
    expect(deletedUpdate.body.error.code).toBe('NOTE_NOT_FOUND')
    expect(database.prepare(`SELECT title FROM notes WHERE id = ?`).get(noteId)).toEqual({ title: '合并标题' })
  })

  it('soft-deletes a note without removing its row, knowledge item, or task', async () => {
    const { app, database } = await openApi()
    insertTestFile(database, 'file_pdf')
    database.prepare(`
      INSERT INTO knowledge_items (id, source_type, source_id, title)
      VALUES ('item_pdf', 'PDF', 'file_pdf', 'one.pdf')
    `).run()
    const noteId = await createNote(app, 'request-1', '标题', '<p>正文</p>')
    database.prepare(`
      INSERT INTO tasks (id, note_id, task_type, current_step, request_id)
      VALUES ('task_note', ?, 'PROCESS_NOTE', 'GENERATE_SUMMARY', 'request_note')
    `).run(noteId)

    const deleted = await request(app).delete(`/api/notes/${noteId}`)
    expect(deleted.status).toBe(200)
    expect(deleted.body.data).toEqual({ noteId, status: 'DELETED' })
    expect((await request(app).get(`/api/notes/${noteId}`)).status).toBe(404)
    expect((await request(app).get('/api/notes')).body.data).toMatchObject({ items: [], total: 0 })
    expect(database.prepare(`SELECT status FROM notes WHERE id = ?`).get(noteId)).toEqual({ status: 'DELETED' })
    expect(database.prepare(`SELECT status FROM knowledge_items WHERE source_type = 'NOTE' AND source_id = ?`).get(noteId)).toEqual({ status: 'DELETED' })
    expect(database.prepare(`SELECT id FROM tasks WHERE note_id = ?`).get(noteId)).toEqual({ id: 'task_note' })
    expect(database.prepare(`SELECT status FROM knowledge_items WHERE id = 'item_pdf'`).get()).toEqual({ status: 'ACTIVE' })
    expect((await request(app).delete(`/api/notes/${noteId}`)).status).toBe(404)
    expect((await request(app).delete('/api/notes/missing-note')).status).toBe(404)
  })
})

async function openApi() {
  const opened = await openRepositoryTestDatabase()
  directory = opened.directory
  const app = createApp({ noteService: new NoteService({ database: opened.database }) })
  return { app, database: opened.database }
}

async function createNote(app: ReturnType<typeof createApp>, key: string, title: string, bodyHtml = ''): Promise<string> {
  const response = await request(app).post('/api/notes').set('Idempotency-Key', key).send({ title, bodyHtml })
  expect(response.status).toBe(201)
  return response.body.data.noteId as string
}
