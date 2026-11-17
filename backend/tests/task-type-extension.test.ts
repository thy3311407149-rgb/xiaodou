import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDatabaseConnection, createDatabaseConnection } from '../app/db/connection.js'
import { runMigration } from '../app/db/migration-runner.js'
import { markHistoricalBootstrap } from './migration-state-helper.js'
import { ApplicationError } from '../app/core/errors/application-error.js'
import type { TaskType } from '../app/models/task.js'
import { FileRepository } from '../app/repositories/file-repository.js'
import { TaskRepository } from '../app/repositories/task-repository.js'
import type { LlmClient } from '../app/services/llm/llm-client.js'
import { TaskExecutor } from '../app/services/task-executor.js'
import { NoteTaskHandler } from '../app/services/task/note-task-handler.js'
import { RecordingTaskHandler } from '../app/services/task/recording-task-handler.js'
import { TaskHandlerRegistry } from '../app/services/task/task-handler-registry.js'
import type { TaskHandler } from '../app/services/task/task-handler.js'
import { closeRepositoryTestDatabase, insertTestFile, openRepositoryTestDatabase } from './repository-test-helper.js'

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
    VALUES (?, ?, 'application/pdf', 20, ?, 'UPLOADED')
  `).run(id, `${id}.pdf`, `uploads/${id}.pdf`)
}

describe('task type migration', () => {
  it('applies 001, 002, and 003 on a new database and preserves PDF tasks on upgrade', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xiaodou-task-type-'))
    const database = createDatabaseConnection(join(directory, 'tasks.db'))
    database.exec(readFileSync(resolve('app/db/migrations/001_initial_schema.sql'), 'utf8'))
    database.exec(readFileSync(resolve('app/db/migrations/002_unified_knowledge_items.sql'), 'utf8'))
    insertFile(database, 'file_pdf')
    database.prepare(`
      INSERT INTO tasks (
        id, file_id, task_type, status, current_step, progress, retry_count, request_id, idempotency_key,
        error_code, error_message, started_at, finished_at, created_at, updated_at
      ) VALUES (
        'task_pdf', 'file_pdf', 'PROCESS_PDF', 'FAILED', 'GENERATE_SUMMARY', 70, 0, 'request_pdf', 'idem_pdf',
        'LLM_INVALID_RESPONSE', 'AI 服务返回结果无效',
        '2026-10-01T00:00:00.000Z', '2026-10-01T00:01:00.000Z',
        '2026-10-01T00:00:00.000Z', '2026-10-01T00:01:00.000Z'
      )
    `).run()
    database.prepare(`
      INSERT INTO summaries (id, file_id, task_id, content, model_name, prompt_version)
      VALUES ('summary_pdf', 'file_pdf', 'task_pdf', '旧摘要', 'qwen-plus', 'summary-v4')
    `).run()
    database.prepare(`
      INSERT INTO operation_logs (id, request_id, task_id, file_id, operation, status)
      VALUES ('log_pdf', 'request_pdf', 'task_pdf', 'file_pdf', 'TASK_FAILED', 'FAILED')
    `).run()
    const preservedTaskColumns = 'id, file_id, task_type, status, current_step, progress, retry_count, request_id, idempotency_key, error_code, error_message, started_at, finished_at, created_at, updated_at'
    const before = database.prepare(`SELECT ${preservedTaskColumns} FROM tasks`).all()
    markHistoricalBootstrap(database, ['001', '002'])

    runMigration(database)
    runMigration(database)

    expect(database.prepare(`SELECT ${preservedTaskColumns} FROM tasks`).all()).toEqual(before)
    expect(database.prepare(`SELECT file_id, recording_id, note_id FROM tasks WHERE id = 'task_pdf'`).get()).toEqual({
      file_id: 'file_pdf',
      recording_id: null,
      note_id: null,
    })
    expect(database.prepare('SELECT task_id, content FROM summaries').get()).toEqual({ task_id: 'task_pdf', content: '旧摘要' })
    expect(database.prepare('SELECT task_id FROM operation_logs').get()).toEqual({ task_id: 'task_pdf' })
    expect(database.prepare(`SELECT name FROM sqlite_master WHERE name = 'tasks_new'`).get()).toBeUndefined()
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    const taskForeignKeys = database.prepare('PRAGMA foreign_key_list(tasks)').all() as Array<{ table: string; from: string; on_delete: string }>
    expect(taskForeignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'files', from: 'file_id', on_delete: 'CASCADE' }),
    ]))
    expect(database.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all().map((row) => (row as { name: string }).name)).toEqual(expect.arrayContaining([
      'ux_tasks_one_active_per_file',
      'ux_tasks_idempotency_key',
      'ix_tasks_file_created',
      'ix_tasks_request_id',
      'ix_tasks_status_updated',
    ]))

    database.prepare(`INSERT INTO recordings (id) VALUES ('recording_001')`).run()
    database.prepare(`INSERT INTO notes (id, title) VALUES ('note_001', '随笔')`).run()
    database.prepare(`INSERT INTO tasks (id, recording_id, task_type, current_step, request_id) VALUES ('task_recording', 'recording_001', 'PROCESS_RECORDING', 'PERSIST_AUDIO', 'request_recording')`).run()
    database.prepare(`INSERT INTO tasks (id, note_id, task_type, current_step, request_id) VALUES ('task_note', 'note_001', 'PROCESS_NOTE', 'GENERATE_SUMMARY', 'request_note')`).run()
    database.prepare(`INSERT INTO tasks (id, recording_id, task_type, current_step, status, request_id) VALUES ('task_recording_summary', 'recording_001', 'PROCESS_RECORDING', 'GENERATE_SUMMARY', 'FAILED', 'request_recording_summary')`).run()

    expect(() => database.prepare(`INSERT INTO tasks (id, file_id, task_type, request_id) VALUES ('task_bad_type', 'file_pdf', 'PROCESS_VIDEO', 'request_bad_type')`).run()).toThrow(/CHECK constraint failed/)
    expect(() => database.prepare(`INSERT INTO tasks (id, file_id, current_step, request_id) VALUES ('task_bad_step', 'file_pdf', 'NOT_A_STEP', 'request_bad_step')`).run()).toThrow(/CHECK constraint failed/)
    expect(() => database.prepare(`INSERT INTO tasks (id, file_id, task_type, current_step, status, request_id) VALUES ('task_pdf_audio', 'file_pdf', 'PROCESS_PDF', 'PERSIST_AUDIO', 'FAILED', 'request_pdf_audio')`).run()).toThrow(/task step is not valid for task type/)
    expect(() => database.prepare(`INSERT INTO tasks (id, recording_id, task_type, current_step, status, request_id) VALUES ('task_recording_extract', 'recording_001', 'PROCESS_RECORDING', 'EXTRACT_TEXT', 'FAILED', 'request_recording_extract')`).run()).toThrow(/task step is not valid for task type/)
    expect(() => database.prepare(`INSERT INTO tasks (id, note_id, task_type, current_step, status, request_id) VALUES ('task_note_audio', 'note_001', 'PROCESS_NOTE', 'PERSIST_AUDIO', 'FAILED', 'request_note_audio')`).run()).toThrow(/task step is not valid for task type/)

    database.prepare(`DELETE FROM notes WHERE id = 'note_001'`).run()
    expect(database.prepare(`SELECT id FROM tasks WHERE note_id = 'note_001'`).all()).toEqual([])
    expect(database.prepare(`SELECT id FROM tasks WHERE id = 'task_pdf'`).get()).toEqual({ id: 'task_pdf' })
  })
})

describe('task handler registry', () => {
  it('dispatches each task type once and does not rerun a finished task', async () => {
    const opened = await openRepositoryTestDatabase()
    directory = opened.directory
    const taskRepository = new TaskRepository(opened.database)
    const calls: TaskType[] = []
    const handlers: TaskHandler[] = (['PROCESS_PDF', 'PROCESS_RECORDING', 'PROCESS_NOTE'] as const).map((taskType) => ({
      taskType,
      async execute() {
        calls.push(taskType)
        return { finished: true }
      },
    }))
    insertTestFile(opened.database, 'file_pdf')
    opened.database.prepare(`INSERT INTO recordings (id) VALUES ('recording_001')`).run()
    opened.database.prepare(`INSERT INTO notes (id, title) VALUES ('note_001', '随笔')`).run()
    taskRepository.create({ id: 'task_pdf', fileId: 'file_pdf', requestId: 'request_pdf', taskType: 'PROCESS_PDF' })
    taskRepository.create({ id: 'task_recording', recordingId: 'recording_001', requestId: 'request_recording', taskType: 'PROCESS_RECORDING' })
    taskRepository.create({ id: 'task_note', noteId: 'note_001', requestId: 'request_note', taskType: 'PROCESS_NOTE' })
    opened.database.prepare(`UPDATE tasks SET created_at = '2026-10-01T00:00:01.000Z' WHERE id = 'task_pdf'`).run()
    opened.database.prepare(`UPDATE tasks SET created_at = '2026-10-01T00:00:02.000Z' WHERE id = 'task_recording'`).run()
    opened.database.prepare(`UPDATE tasks SET created_at = '2026-10-01T00:00:03.000Z' WHERE id = 'task_note'`).run()
    expect(taskRepository.findById('task_pdf')?.currentStep).toBe('EXTRACT_TEXT')
    expect(taskRepository.findById('task_recording')?.currentStep).toBe('PERSIST_AUDIO')
    expect(taskRepository.findById('task_note')?.currentStep).toBe('GENERATE_SUMMARY')

    const executor = new TaskExecutor({ taskRepository, handlers, pollIntervalMs: 20 })
    await executor.processAvailableTasks()
    await executor.processAvailableTasks()

    expect(calls).toEqual(['PROCESS_PDF', 'PROCESS_RECORDING', 'PROCESS_NOTE'])
    for (const id of ['task_pdf', 'task_recording', 'task_note']) {
      expect(taskRepository.findById(id)).toMatchObject({
        status: 'SUCCEEDED',
        currentStep: 'COMPLETED',
        progress: 100,
        retryCount: 0,
        errorCode: null,
      })
      expect(taskRepository.findById(id)?.finishedAt).toEqual(expect.any(String))
    }
    expect(taskRepository.claimQueued('task_pdf')).toBe(0)
  })

  it('fails an unimplemented handler and an unknown task type without a fake success', async () => {
    const opened = await openRepositoryTestDatabase()
    directory = opened.directory
    const taskRepository = new TaskRepository(opened.database)
    const fileRepository = new FileRepository(opened.database)
    opened.database.prepare(`INSERT INTO recordings (id) VALUES ('recording_001')`).run()
    opened.database.prepare(`INSERT INTO notes (id, title) VALUES ('note_001', '随笔')`).run()
    insertTestFile(opened.database, 'file_pdf')
    taskRepository.create({ id: 'task_recording', recordingId: 'recording_001', requestId: 'request_recording', taskType: 'PROCESS_RECORDING' })
    taskRepository.create({ id: 'task_note', noteId: 'note_001', requestId: 'request_note', taskType: 'PROCESS_NOTE' })
    taskRepository.create({ id: 'task_pdf', fileId: 'file_pdf', requestId: 'request_pdf', taskType: 'PROCESS_PDF' })

    const executor = new TaskExecutor({ taskRepository, fileRepository, pollIntervalMs: 20 })
    await executor.processAvailableTasks()

    expect(taskRepository.findById('task_recording')).toMatchObject({
      status: 'FAILED',
      currentStep: 'PERSIST_AUDIO',
      retryCount: 0,
      errorCode: 'TASK_EXECUTION_FAILED',
      errorMessage: '录音没有可处理的音频',
    })
    expect(taskRepository.findById('task_note')).toMatchObject({
      status: 'FAILED',
      currentStep: 'GENERATE_SUMMARY',
      retryCount: 0,
      errorCode: 'TASK_EXECUTION_FAILED',
      errorMessage: '笔记任务尚未实现',
    })
    expect(taskRepository.findById('task_recording')).toMatchObject({ fileId: null, recordingId: 'recording_001', noteId: null })
    expect(taskRepository.findById('task_note')).toMatchObject({ fileId: null, recordingId: null, noteId: 'note_001' })
    expect(opened.database.prepare(`SELECT file_id FROM operation_logs WHERE task_id = 'task_recording' AND operation = 'TASK_FAILED'`).get()).toEqual({ file_id: null })
    expect(opened.database.prepare('SELECT COUNT(*) AS count FROM summaries').get()).toEqual({ count: 0 })
    expect(taskRepository.findById('task_recording')?.finishedAt).toEqual(expect.any(String))

    const registry = new TaskHandlerRegistry([new RecordingTaskHandler(), new NoteTaskHandler()])
    expect(registry.resolve('PROCESS_RECORDING')).toBeInstanceOf(RecordingTaskHandler)
    expect(registry.resolve('PROCESS_NOTE')).toBeInstanceOf(NoteTaskHandler)
    expect(() => registry.resolve('PROCESS_PDF')).toThrow(ApplicationError)
    expect(() => registry.resolve('PROCESS_UNKNOWN' as TaskType)).toThrow(/不支持的任务类型/)

    const unknownExecutor = new TaskExecutor({
      taskRepository,
      fileRepository,
      handlers: [new RecordingTaskHandler(), new NoteTaskHandler()],
      pollIntervalMs: 20,
    })
    opened.database.prepare(`UPDATE tasks SET status = 'QUEUED', finished_at = NULL WHERE id = 'task_pdf'`).run()
    await unknownExecutor.processAvailableTasks()
    expect(taskRepository.findById('task_pdf')).toMatchObject({
      status: 'FAILED',
      retryCount: 0,
      errorCode: 'TASK_EXECUTION_FAILED',
      errorMessage: '不支持的任务类型',
    })
    expect(taskRepository.findById('task_pdf')?.status).not.toBe('SUCCEEDED')
  })

  it('keeps the PDF success and failure lifecycle', async () => {
    const opened = await openRepositoryTestDatabase()
    directory = opened.directory
    const taskRepository = new TaskRepository(opened.database)
    const fileRepository = new FileRepository(opened.database)
    const llmClient: LlmClient = {
      async complete() {
        return {
          content: JSON.stringify({
            title: '标题',
            summary: '这是一段摘要。',
            keyPoints: [{ content: '要点', sourceChunkIndexes: [0] }],
            citations: [],
          }),
          modelName: 'test-model',
          inputTokens: 3,
          outputTokens: 4,
        }
      },
    }
    insertTestFile(opened.database, 'file_ok')
    insertTestFile(opened.database, 'file_bad')
    insertTestFile(opened.database, 'file_empty')
    taskRepository.create({ id: 'task_ok', fileId: 'file_ok', requestId: 'request_ok' })
    taskRepository.create({ id: 'task_bad', fileId: 'file_bad', requestId: 'request_bad' })
    taskRepository.create({ id: 'task_empty', fileId: 'file_empty', requestId: 'request_empty' })

    const executor = new TaskExecutor({
      taskRepository,
      fileRepository,
      llmClient,
      extractPdfPages: async (absolutePath) => {
        if (absolutePath.includes('file_bad')) throw new Error('unreadable')
        if (absolutePath.includes('file_empty')) return [{ pageNumber: 1, content: '   ' }]
        return [{ pageNumber: 1, content: 'alpha page one' }]
      },
      pollIntervalMs: 20,
    })
    insertTestFile(opened.database, 'file_interrupted')
    opened.database.prepare(`
      INSERT INTO tasks (id, file_id, task_type, status, current_step, retry_count, request_id)
      VALUES ('task_interrupted', 'file_interrupted', 'PROCESS_PDF', 'RUNNING', 'EXTRACT_TEXT', 0, 'request_interrupted')
    `).run()
    expect(executor.recoverInterruptedTasks()).toBe(1)
    expect(taskRepository.findById('task_interrupted')).toMatchObject({
      status: 'FAILED',
      errorCode: 'TASK_EXECUTION_FAILED',
      errorMessage: '任务在进程重启时中断',
      retryCount: 0,
    })

    await executor.processAvailableTasks()
    await executor.processAvailableTasks()

    expect(taskRepository.findById('task_ok')).toMatchObject({
      status: 'SUCCEEDED',
      currentStep: 'COMPLETED',
      progress: 100,
      retryCount: 0,
    })
    expect(fileRepository.findById('file_ok')?.status).toBe('COMPLETED')
    expect(opened.database.prepare(`SELECT content FROM summaries WHERE task_id = 'task_ok'`).get()).toEqual({ content: '这是一段摘要。' })
    expect(taskRepository.findById('task_bad')).toMatchObject({
      status: 'FAILED',
      errorCode: 'PDF_EXTRACTION_FAILED',
      retryCount: 0,
    })
    expect(fileRepository.findById('file_bad')?.status).toBe('EXTRACTION_FAILED')
    expect(taskRepository.findById('task_empty')).toMatchObject({
      status: 'FAILED',
      currentStep: 'GENERATE_SUMMARY',
      errorCode: 'SUMMARY_GENERATION_FAILED',
      errorMessage: '没有可摘要的文本',
      retryCount: 0,
    })
    expect(fileRepository.findById('file_empty')?.status).toBe('SUMMARY_FAILED')
    expect(taskRepository.findById('task_interrupted')?.errorMessage).toBe('任务在进程重启时中断')
  })
})
