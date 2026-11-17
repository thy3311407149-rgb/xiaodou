import { readFileSync } from 'node:fs'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDatabaseConnection, createDatabaseConnection } from '../app/db/connection.js'
import { runMigration } from '../app/db/migration-runner.js'
import { markHistoricalBootstrap } from './migration-state-helper.js'
import { KnowledgeItemRepository } from '../app/repositories/knowledge-item-repository.js'
import { FileService } from '../app/services/file-service.js'
import { KnowledgeItemService } from '../app/services/knowledge-item-service.js'

const preservedTaskColumns = 'id, file_id, task_type, status, current_step, progress, retry_count, request_id, idempotency_key, error_code, error_message, started_at, finished_at, created_at, updated_at'

let directory = ''

afterEach(async () => {
  closeDatabaseConnection()
  if (directory) {
    await rm(directory, { recursive: true, force: true })
    directory = ''
  }
})

async function openDatabase() {
  directory = await mkdtemp(join(tmpdir(), 'xiaodou-knowledge-'))
  return createDatabaseConnection(join(directory, 'knowledge.db'))
}

function tableNames(database: ReturnType<typeof createDatabaseConnection>): string[] {
  return database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => (row as { name: string }).name)
}

describe('unified knowledge items', () => {
  it('initializes an empty database and can run twice', async () => {
    const database = await openDatabase()
    runMigration(database)
    runMigration(database)

    expect(tableNames(database)).toEqual(expect.arrayContaining(['knowledge_items', 'knowledge_item_summaries', 'files', 'summaries', 'text_chunks']))
    expect(database.prepare('SELECT COUNT(*) AS count FROM knowledge_items').get()).toEqual({ count: 0 })
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1)
    const columns = database.prepare('PRAGMA table_info(text_chunks)').all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(['page_number', 'start_time', 'end_time', 'speaker_id', 'note_id']))
  })

  it('backfills existing PDFs once and preserves the original rows', async () => {
    const database = await openDatabase()
    database.exec(readFileSync(resolve('app/db/migrations/001_initial_schema.sql'), 'utf8'))
    database.prepare(`
      INSERT INTO files (id, file_name, file_type, file_size, storage_path, status, created_at, updated_at)
      VALUES ('file_pdf', '计划书.pdf', 'application/pdf', 20, 'uploads/file_pdf.pdf', 'COMPLETED', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z')
    `).run()
    database.prepare(`
      INSERT INTO files (id, file_name, file_type, file_size, storage_path, status)
      VALUES ('file_deleted', '旧文件.pdf', 'application/pdf', 20, 'uploads/file_deleted.pdf', 'DELETED')
    `).run()
    database.prepare(`INSERT INTO tasks (id, file_id, request_id, status) VALUES ('task_pdf', 'file_pdf', 'request_pdf', 'SUCCEEDED')`).run()
    database.prepare(`INSERT INTO document_texts (id, file_id, page_number, content) VALUES ('text_pdf', 'file_pdf', 1, '第一页')`).run()
    database.prepare(`
      INSERT INTO text_chunks (id, file_id, page_number, chunk_index, content, token_count)
      VALUES ('chunk_pdf', 'file_pdf', 3, 0, '原文片段', 4)
    `).run()
    database.prepare(`
      INSERT INTO summaries (id, file_id, task_id, content, model_name, prompt_version, created_at, updated_at)
      VALUES ('summary_old', 'file_pdf', 'task_pdf', '旧摘要', 'qwen-plus', 'summary-v4', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')
    `).run()
    database.prepare(`
      INSERT INTO tasks (id, file_id, request_id, status) VALUES ('task_pdf_2', 'file_pdf', 'request_pdf_2', 'FAILED')
    `).run()
    database.prepare(`
      INSERT INTO summaries (id, file_id, task_id, content, model_name, prompt_version, created_at, updated_at)
      VALUES ('summary_new', 'file_pdf', 'task_pdf_2', '新摘要', 'qwen-plus', 'summary-v4', '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z')
    `).run()

    markHistoricalBootstrap(database, ['001'])

    const before = {
      files: database.prepare('SELECT * FROM files ORDER BY id').all(),
      tasks: database.prepare(`SELECT ${preservedTaskColumns} FROM tasks ORDER BY id`).all(),
      texts: database.prepare('SELECT * FROM document_texts').all(),
      chunks: database.prepare('SELECT id, file_id, page_number, chunk_index, content, token_count FROM text_chunks').all(),
      summaries: database.prepare('SELECT id, file_id, task_id, content FROM summaries ORDER BY id').all(),
    }

    runMigration(database)
    const first = database.prepare(`
      SELECT id, source_id, title, status FROM knowledge_items WHERE source_type = 'PDF' AND source_id = 'file_pdf'
    `).get() as { id: string; source_id: string; title: string; status: string }
    runMigration(database)
    const second = database.prepare(`
      SELECT id, source_id, title, status FROM knowledge_items WHERE source_type = 'PDF' AND source_id = 'file_pdf'
    `).get()

    expect(database.prepare('SELECT COUNT(*) AS count FROM knowledge_items').get()).toEqual({ count: 2 })
    expect(first).toMatchObject({ source_id: 'file_pdf', title: '计划书.pdf', status: 'ACTIVE' })
    expect(second).toEqual(first)
    expect(database.prepare(`SELECT status FROM knowledge_items WHERE source_id = 'file_deleted'`).get()).toEqual({ status: 'DELETED' })
    expect(database.prepare('SELECT summary_id FROM knowledge_item_summaries WHERE knowledge_item_id = ?').get(first.id)).toEqual({ summary_id: 'summary_new' })
    expect(database.prepare('SELECT COUNT(*) AS count FROM knowledge_item_summaries').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT * FROM files ORDER BY id').all()).toEqual(before.files)
    expect(database.prepare(`SELECT ${preservedTaskColumns} FROM tasks ORDER BY id`).all()).toEqual(before.tasks)
    expect(database.prepare('SELECT COUNT(*) AS count FROM tasks WHERE recording_id IS NOT NULL OR note_id IS NOT NULL').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT * FROM document_texts').all()).toEqual(before.texts)
    expect(database.prepare('SELECT id, file_id, page_number, chunk_index, content, token_count FROM text_chunks').all()).toEqual(before.chunks)
    expect(database.prepare('SELECT id, file_id, task_id, content FROM summaries ORDER BY id').all()).toEqual(before.summaries)
    expect(database.prepare('SELECT start_time, end_time, speaker_id, note_id FROM text_chunks WHERE id = ?').get('chunk_pdf')).toEqual({
      start_time: null,
      end_time: null,
      speaker_id: null,
      note_id: null,
    })
    const summaryForeignKeys = database.prepare('PRAGMA foreign_key_list(summaries)').all() as Array<{ table: string; from: string }>
    expect(summaryForeignKeys.map((key) => `${key.from}->${key.table}`).sort()).toEqual(['file_id->files', 'recording_id->recordings', 'task_id->tasks'])
  })

  it('enforces source identity, summary pointer, time fields, and foreign keys', async () => {
    const database = await openDatabase()
    runMigration(database)
    database.prepare(`
      INSERT INTO files (id, file_name, file_type, file_size, storage_path)
      VALUES ('file_001', 'one.pdf', 'application/pdf', 10, 'uploads/file_001.pdf')
    `).run()
    database.prepare(`INSERT INTO tasks (id, file_id, request_id) VALUES ('task_001', 'file_001', 'request_001')`).run()
    database.prepare(`
      INSERT INTO summaries (id, file_id, task_id, content, model_name, prompt_version)
      VALUES ('summary_001', 'file_001', 'task_001', '摘要', 'qwen-plus', 'summary-v4')
    `).run()
    database.prepare(`
      INSERT INTO text_chunks (id, file_id, page_number, chunk_index, content)
      VALUES ('chunk_001', 'file_001', 2, 0, '页内容')
    `).run()

    const repository = new KnowledgeItemRepository(database)
    const service = new KnowledgeItemService({ database })
    const created = service.create({ id: 'item_pdf', sourceType: 'PDF', sourceId: 'file_001', title: 'one.pdf' })
    expect(service.getById('item_pdf')).toMatchObject(created)
    expect(service.getBySource('PDF', 'file_001')?.id).toBe('item_pdf')
    expect(service.getSource('item_pdf')).toMatchObject({ sourceType: 'PDF', sourceId: 'file_001', file: { id: 'file_001' } })
    expect(() => service.create({ id: 'item_pdf_2', sourceType: 'PDF', sourceId: 'file_001', title: 'again.pdf' })).toThrow(/already exists/)
    expect(() => repository.create({ id: 'item_missing', sourceType: 'PDF', sourceId: 'missing', title: 'missing.pdf' })).toThrow(/PDF source file not found/)
    expect(() => database.prepare(`
      INSERT INTO knowledge_items (id, source_type, source_id, title) VALUES ('item_bad', 'VIDEO', 'source_001', '无效')
    `).run()).toThrow()

    const recording = service.create({ id: 'item_recording', sourceType: 'RECORDING', sourceId: 'recording_001', title: '录音' })
    database.prepare(`INSERT INTO notes (id, title) VALUES ('note_001', '随心记')`).run()
    const note = service.create({ id: 'item_note', sourceType: 'NOTE', sourceId: 'note_001', title: '随心记' })
    expect(recording.sourceType).toBe('RECORDING')
    expect(note.sourceType).toBe('NOTE')
    expect(service.getSource('item_note').file).toBeNull()

    expect(service.getCurrentSummary('item_pdf')).toBeNull()
    expect(service.replaceCurrentSummary('item_pdf', 'summary_001').id).toBe('summary_001')
    expect(service.getCurrentSummary('item_pdf')?.content).toBe('摘要')
    database.prepare(`INSERT INTO tasks (id, file_id, request_id, status) VALUES ('task_002', 'file_001', 'request_002', 'FAILED')`).run()
    database.prepare(`
      INSERT INTO summaries (id, file_id, task_id, content, model_name, prompt_version)
      VALUES ('summary_002', 'file_001', 'task_002', '替换摘要', 'qwen-plus', 'summary-v4')
    `).run()
    service.replaceCurrentSummary('item_pdf', 'summary_002')
    expect(service.getCurrentSummary('item_pdf')?.id).toBe('summary_002')
    expect(database.prepare('SELECT COUNT(*) AS count FROM summaries').get()).toEqual({ count: 2 })
    expect(() => repository.replaceCurrentSummary('item_pdf', 'missing_summary')).toThrow()
    expect(() => database.prepare(`
      INSERT INTO knowledge_item_summaries (knowledge_item_id, summary_id) VALUES ('missing_item', 'summary_001')
    `).run()).toThrow()

    database.prepare(`UPDATE text_chunks SET start_time = 1000, end_time = 2500, speaker_id = 'speaker_a', note_id = 'note_001' WHERE id = 'chunk_001'`).run()
    expect(database.prepare('SELECT page_number, content, start_time, end_time, speaker_id, note_id FROM text_chunks WHERE id = ?').get('chunk_001')).toEqual({
      page_number: 2,
      content: '页内容',
      start_time: 1000,
      end_time: 2500,
      speaker_id: 'speaker_a',
      note_id: 'note_001',
    })
    expect(() => database.prepare(`UPDATE text_chunks SET start_time = -1 WHERE id = 'chunk_001'`).run()).toThrow()
    expect(() => database.prepare(`UPDATE text_chunks SET end_time = 10 WHERE id = 'chunk_001'`).run()).toThrow()
    expect(() => database.prepare(`UPDATE text_chunks SET speaker_id = '   ' WHERE id = 'chunk_001'`).run()).toThrow()

    database.prepare('DELETE FROM knowledge_items WHERE id = ?').run('item_pdf')
    expect(database.prepare('SELECT COUNT(*) AS count FROM knowledge_item_summaries').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM summaries').get()).toEqual({ count: 2 })
  })

  it('creates one PDF knowledge item on upload and marks it deleted with the file', async () => {
    const database = await openDatabase()
    runMigration(database)
    const uploadDirectory = await mkdtemp(join(tmpdir(), 'xiaodou-knowledge-upload-'))
    try {
      const service = new FileService({ database, uploadDir: uploadDirectory })
      const temporaryPath = join(uploadDirectory, 'incoming.pdf')
      await copyFile(resolve('tests/fixtures/minimal.pdf'), temporaryPath)
      const uploaded = await service.upload({
        temporaryPath,
        originalName: '计划书.pdf',
        mimeType: 'application/pdf',
        size: 10,
        requestId: 'request_upload',
      })
      const knowledgeItems = new KnowledgeItemService({ database })
      const item = knowledgeItems.getBySource('PDF', uploaded.file.id)
      expect(uploaded.file).toMatchObject({ fileName: '计划书.pdf', status: 'UPLOADED' })
      expect(uploaded.task.fileId).toBe(uploaded.file.id)
      expect(item).toMatchObject({ sourceType: 'PDF', sourceId: uploaded.file.id, title: '计划书.pdf', status: 'ACTIVE' })
      expect(database.prepare('SELECT COUNT(*) AS count FROM knowledge_items').get()).toEqual({ count: 1 })

      await service.delete(uploaded.file.id, 'request_delete')
      expect(knowledgeItems.getById(item?.id ?? '')?.status).toBe('DELETED')
      expect(database.prepare('SELECT status FROM files WHERE id = ?').get(uploaded.file.id)).toEqual({ status: 'DELETED' })
    } finally {
      await rm(uploadDirectory, { recursive: true, force: true })
    }
  })
})
