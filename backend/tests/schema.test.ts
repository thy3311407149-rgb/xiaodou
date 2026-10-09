import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  closeDatabaseConnection,
  createDatabaseConnection,
} from '../app/db/connection.js'
import { runMigration } from '../app/db/migration-runner.js'

let temporaryDirectory: string | undefined

afterEach(async () => {
  closeDatabaseConnection()

  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = undefined
  }
})

describe('initial database schema', () => {
  it('creates the six business tables, indexes, constraints, and is repeatable', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'xiaodou-schema-'))
    const database = createDatabaseConnection(join(temporaryDirectory, 'schema.db'))

    runMigration(database)
    runMigration(database)

    const tables = database.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => (row as { name: string }).name)

    expect(tables).toEqual([
      'document_texts',
      'files',
      'operation_logs',
      'summaries',
      'tasks',
      'text_chunks',
    ])

    const indexes = database.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index' AND name IS NOT NULL
    `).all().map((row) => (row as { name: string }).name)

    expect(indexes).toEqual(expect.arrayContaining([
      'ux_files_idempotency_key',
      'ux_tasks_one_active_per_file',
      'ux_tasks_idempotency_key',
      'ix_text_chunks_file_page',
      'ix_summaries_file_created',
      'ix_files_user_created',
      'ix_files_status',
      'ix_tasks_file_created',
      'ix_tasks_request_id',
      'ix_tasks_status_updated',
      'ix_operation_logs_request_id',
      'ix_operation_logs_file_created',
      'ix_operation_logs_task_created',
      'ix_operation_logs_operation_status',
    ]))

    expect(database.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('rejects an invalid file status and duplicate active tasks for one file', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'xiaodou-schema-'))
    const database = createDatabaseConnection(join(temporaryDirectory, 'constraints.db'))

    runMigration(database)
    database.prepare(`
      INSERT INTO files (id, file_name, file_type, file_size, storage_path)
      VALUES (?, ?, ?, ?, ?)
    `).run('file_001', 'sample.pdf', 'application/pdf', 10, 'uploads/file_001.pdf')

    expect(() => database.prepare(`
      UPDATE files SET status = 'INVALID_STATUS' WHERE id = ?
    `).run('file_001')).toThrow()

    const insertTask = database.prepare(`
      INSERT INTO tasks (id, file_id, request_id)
      VALUES (?, ?, ?)
    `)

    insertTask.run('task_001', 'file_001', 'request_001')

    expect(() => insertTask.run('task_002', 'file_001', 'request_002')).toThrow()
  })
})
