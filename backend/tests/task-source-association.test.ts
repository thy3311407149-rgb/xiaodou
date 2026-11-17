import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDatabaseConnection, createDatabaseConnection } from '../app/db/connection.js'
import { runMigration } from '../app/db/migration-runner.js'
import { markHistoricalBootstrap } from './migration-state-helper.js'
import { ApplicationError } from '../app/core/errors/application-error.js'
import { TaskRepository } from '../app/repositories/task-repository.js'
import { TaskExecutor } from '../app/services/task-executor.js'
import { closeRepositoryTestDatabase, insertTestFile, openRepositoryTestDatabase } from './repository-test-helper.js'

const preservedTaskColumns = 'id, file_id, task_type, status, current_step, progress, retry_count, request_id, idempotency_key, error_code, error_message, started_at, finished_at, created_at, updated_at'

let directory = ''

afterEach(async () => {
  if (directory) {
    await closeRepositoryTestDatabase(directory)
    directory = ''
  }
  closeDatabaseConnection()
})

function insertFile(database: ReturnType<typeof createDatabaseConnection>, id: string): void {
  database.prepare(`
    INSERT INTO files (id, file_name, file_type, file_size, storage_path, status)
    VALUES (?, ?, 'application/pdf', 20, ?, 'COMPLETED')
  `).run(id, `${id}.pdf`, `uploads/${id}.pdf`)
}

describe('task source association', () => {
  it('upgrades a 003 database, keeps PDF tasks, and accepts one source per task type', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xiaodou-task-source-'))
    const database = createDatabaseConnection(join(directory, 'tasks.db'))
    database.exec(readFileSync(resolve('app/db/migrations/001_initial_schema.sql'), 'utf8'))
    database.exec(readFileSync(resolve('app/db/migrations/002_unified_knowledge_items.sql'), 'utf8'))
    database.exec(readFileSync(resolve('app/db/migrations/003_task_type_extension.sql'), 'utf8'))
    insertFile(database, 'file_pdf')
    database.prepare(`
      INSERT INTO tasks (
        id, file_id, task_type, status, current_step, progress, retry_count, request_id, idempotency_key,
        error_code, error_message, started_at, finished_at, created_at, updated_at
      ) VALUES (
        'task_pdf', 'file_pdf', 'PROCESS_PDF', 'FAILED', 'GENERATE_SUMMARY', 70, 2, 'request_pdf', 'idem_pdf',
        'LLM_INVALID_RESPONSE', 'AI 服务返回结果无效',
        '2026-10-01T00:00:00.000Z', '2026-10-01T00:01:00.000Z',
        '2026-10-01T00:00:00.000Z', '2026-10-01T00:01:00.000Z'
      )
    `).run()
    const before = database.prepare(`SELECT ${preservedTaskColumns} FROM tasks`).all()
    markHistoricalBootstrap(database, ['001', '002', '003'])

    runMigration(database)
    const fileColumn = database.prepare(`PRAGMA table_info(tasks)`).all().find((column) => (column as { name: string }).name === 'file_id') as { notnull: number }
    expect(fileColumn.notnull).toBe(0)
    expect(database.prepare(`SELECT ${preservedTaskColumns} FROM tasks`).all()).toEqual(before)
    expect(database.prepare(`SELECT file_id, recording_id, note_id FROM tasks WHERE id = 'task_pdf'`).get()).toEqual({
      file_id: 'file_pdf',
      recording_id: null,
      note_id: null,
    })

    database.prepare(`INSERT INTO recordings (id) VALUES ('recording_001')`).run()
    database.prepare(`INSERT INTO recordings (id) VALUES ('recording_002')`).run()
    database.prepare(`INSERT INTO notes (id, title) VALUES ('note_001', '随笔')`).run()
    database.prepare(`INSERT INTO notes (id, title) VALUES ('note_002', '随笔')`).run()
    database.prepare(`INSERT INTO tasks (id, recording_id, task_type, current_step, request_id) VALUES ('task_recording', 'recording_001', 'PROCESS_RECORDING', 'PERSIST_AUDIO', 'request_recording')`).run()
    database.prepare(`INSERT INTO tasks (id, note_id, task_type, current_step, request_id) VALUES ('task_note', 'note_001', 'PROCESS_NOTE', 'GENERATE_SUMMARY', 'request_note')`).run()
    database.prepare(`INSERT INTO tasks (id, file_id, task_type, current_step, request_id) VALUES ('task_pdf_active', 'file_pdf', 'PROCESS_PDF', 'EXTRACT_TEXT', 'request_pdf_active')`).run()

    expect(() => database.prepare(`INSERT INTO tasks (id, file_id, recording_id, task_type, current_step, request_id) VALUES ('task_both', 'file_pdf', 'recording_001', 'PROCESS_PDF', 'EXTRACT_TEXT', 'request_both')`).run()).toThrow(/CHECK constraint failed/)
    expect(() => database.prepare(`INSERT INTO tasks (id, task_type, current_step, request_id) VALUES ('task_none', 'PROCESS_RECORDING', 'PERSIST_AUDIO', 'request_none')`).run()).toThrow(/CHECK constraint failed/)
    expect(() => database.prepare(`INSERT INTO tasks (id, file_id, task_type, current_step, request_id) VALUES ('task_recording_file', 'file_pdf', 'PROCESS_RECORDING', 'PERSIST_AUDIO', 'request_recording_file')`).run()).toThrow(/CHECK constraint failed/)
    expect(() => database.prepare(`INSERT INTO tasks (id, recording_id, task_type, current_step, request_id) VALUES ('task_recording_again', 'recording_001', 'PROCESS_RECORDING', 'PERSIST_AUDIO', 'request_recording_again')`).run()).toThrow(/UNIQUE constraint failed: tasks\.recording_id/)
    expect(() => database.prepare(`INSERT INTO tasks (id, note_id, task_type, current_step, request_id) VALUES ('task_note_again', 'note_001', 'PROCESS_NOTE', 'GENERATE_SUMMARY', 'request_note_again')`).run()).toThrow(/UNIQUE constraint failed: tasks\.note_id/)
    database.prepare(`INSERT INTO tasks (id, recording_id, task_type, current_step, status, request_id) VALUES ('task_recording_done', 'recording_001', 'PROCESS_RECORDING', 'COMPLETED', 'SUCCEEDED', 'request_recording_done')`).run()
    database.prepare(`INSERT INTO tasks (id, recording_id, task_type, current_step, request_id) VALUES ('task_recording_other', 'recording_002', 'PROCESS_RECORDING', 'PERSIST_AUDIO', 'request_recording_other')`).run()
    database.prepare(`INSERT INTO tasks (id, note_id, task_type, current_step, request_id) VALUES ('task_note_other', 'note_002', 'PROCESS_NOTE', 'GENERATE_SUMMARY', 'request_note_other')`).run()

    runMigration(database)
    expect(database.prepare(`SELECT file_id, recording_id, note_id, retry_count FROM tasks WHERE id = 'task_pdf'`).get()).toEqual({
      file_id: 'file_pdf',
      recording_id: null,
      note_id: null,
      retry_count: 2,
    })
    expect(database.prepare(`SELECT recording_id, file_id FROM tasks WHERE id = 'task_recording'`).get()).toEqual({
      recording_id: 'recording_001',
      file_id: null,
    })
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1)
    database.prepare(`DELETE FROM recordings WHERE id = 'recording_002'`).run()
    expect(database.prepare(`SELECT id FROM tasks WHERE recording_id = 'recording_002'`).all()).toEqual([])
    expect(database.prepare(`SELECT id FROM tasks WHERE id = 'task_pdf'`).get()).toEqual({ id: 'task_pdf' })
  })

  it('rejects mismatched sources in the repository and fails recording or note tasks without a file', async () => {
    const opened = await openRepositoryTestDatabase()
    directory = opened.directory
    const taskRepository = new TaskRepository(opened.database)
    insertTestFile(opened.database, 'file_pdf')
    opened.database.prepare(`INSERT INTO recordings (id) VALUES ('recording_001')`).run()
    opened.database.prepare(`INSERT INTO notes (id, title) VALUES ('note_001', '随笔')`).run()

    expect(taskRepository.create({ id: 'task_pdf', fileId: 'file_pdf', requestId: 'request_pdf' })).toMatchObject({
      taskType: 'PROCESS_PDF',
      fileId: 'file_pdf',
      recordingId: null,
      noteId: null,
      currentStep: 'EXTRACT_TEXT',
    })
    expect(taskRepository.create({ id: 'task_recording', recordingId: 'recording_001', requestId: 'request_recording', taskType: 'PROCESS_RECORDING' })).toMatchObject({
      fileId: null,
      recordingId: 'recording_001',
      noteId: null,
      currentStep: 'PERSIST_AUDIO',
    })
    expect(taskRepository.create({ id: 'task_note', noteId: 'note_001', requestId: 'request_note', taskType: 'PROCESS_NOTE' })).toMatchObject({
      fileId: null,
      recordingId: null,
      noteId: 'note_001',
      currentStep: 'GENERATE_SUMMARY',
    })
    expect(() => taskRepository.create({ id: 'task_bad_pdf', requestId: 'request_bad_pdf', taskType: 'PROCESS_PDF' })).toThrow(ApplicationError)
    expect(() => taskRepository.create({ id: 'task_bad_recording', fileId: 'file_pdf', requestId: 'request_bad_recording', taskType: 'PROCESS_RECORDING' })).toThrow(/任务来源与任务类型不匹配/)
    expect(opened.database.prepare('SELECT COUNT(*) AS count FROM files').get()).toEqual({ count: 1 })

    opened.database.prepare(`UPDATE tasks SET status = 'SUCCEEDED', current_step = 'COMPLETED' WHERE id = 'task_pdf'`).run()
    const executor = new TaskExecutor({ taskRepository, pollIntervalMs: 20 })
    await executor.processAvailableTasks()
    expect(taskRepository.findById('task_recording')).toMatchObject({
      status: 'FAILED',
      errorCode: 'TASK_EXECUTION_FAILED',
      errorMessage: '录音没有可处理的音频',
      retryCount: 0,
    })
    expect(taskRepository.findById('task_note')).toMatchObject({
      status: 'FAILED',
      errorCode: 'TASK_EXECUTION_FAILED',
      errorMessage: '笔记任务尚未实现',
      retryCount: 0,
    })
    expect(opened.database.prepare(`SELECT file_id, operation FROM operation_logs WHERE task_id = 'task_recording'`).get()).toEqual({
      file_id: null,
      operation: 'TASK_FAILED',
    })
    expect(opened.database.prepare('SELECT COUNT(*) AS count FROM files').get()).toEqual({ count: 1 })
    expect(opened.database.prepare('SELECT COUNT(*) AS count FROM summaries').get()).toEqual({ count: 0 })
  })
})
