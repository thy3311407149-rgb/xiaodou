import type Database from 'better-sqlite3'
import { ApplicationError } from '../core/errors/application-error.js'
import { getDatabaseConnection } from '../db/connection.js'
import type { CreateTaskInput, Task, TaskStep, TaskType, UpdateTaskInput } from '../models/task.js'

function initialStep(taskType: TaskType): TaskStep {
  if (taskType === 'PROCESS_RECORDING') return 'PERSIST_AUDIO'
  if (taskType === 'PROCESS_NOTE') return 'GENERATE_SUMMARY'
  return 'EXTRACT_TEXT'
}

function sourceId(value: string | null | undefined): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function assertTaskSource(taskType: TaskType, fileId: string | null, recordingId: string | null, noteId: string | null): void {
  const matchesPdf = taskType === 'PROCESS_PDF' && fileId !== null && recordingId === null && noteId === null
  const matchesRecording = taskType === 'PROCESS_RECORDING' && fileId === null && recordingId !== null && noteId === null
  const matchesNote = taskType === 'PROCESS_NOTE' && fileId === null && recordingId === null && noteId !== null
  if (!matchesPdf && !matchesRecording && !matchesNote) {
    throw new ApplicationError('INVALID_REQUEST', { message: '任务来源与任务类型不匹配' })
  }
}

type TaskRow = { id: string; file_id: string | null; recording_id: string | null; note_id: string | null; task_type: Task['taskType']; status: Task['status']; current_step: Task['currentStep']; progress: number; retry_count: number; request_id: string; idempotency_key: string | null; error_code: string | null; error_message: string | null; started_at: string | null; finished_at: string | null; created_at: string; updated_at: string }

export class TaskRepository {
  constructor(private readonly database: Database.Database = getDatabaseConnection()) {}

  create(input: CreateTaskInput): Task {
    const taskType = input.taskType ?? 'PROCESS_PDF'
    const fileId = sourceId(input.fileId)
    const recordingId = sourceId(input.recordingId)
    const noteId = sourceId(input.noteId)
    assertTaskSource(taskType, fileId, recordingId, noteId)
    this.database.prepare(`INSERT INTO tasks (id, file_id, recording_id, note_id, task_type, status, current_step, progress, retry_count, request_id, idempotency_key) VALUES (@id, @fileId, @recordingId, @noteId, @taskType, @status, @currentStep, @progress, @retryCount, @requestId, @idempotencyKey)`).run({ id: input.id, fileId, recordingId, noteId, taskType, status: input.status ?? 'QUEUED', currentStep: input.currentStep ?? initialStep(taskType), progress: input.progress ?? 0, retryCount: input.retryCount ?? 0, requestId: input.requestId, idempotencyKey: input.idempotencyKey ?? null })
    return this.findById(input.id) as Task
  }

  findById(id: string): Task | null { const row = this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined; return row ? this.toModel(row) : null }
  findByIdempotencyKey(idempotencyKey: string): Task | null { const row = this.database.prepare('SELECT * FROM tasks WHERE idempotency_key = ?').get(idempotencyKey) as TaskRow | undefined; return row ? this.toModel(row) : null }
  findActiveByFileId(fileId: string): Task | null { const row = this.database.prepare("SELECT * FROM tasks WHERE file_id = ? AND status IN ('QUEUED', 'RUNNING') ORDER BY created_at DESC LIMIT 1").get(fileId) as TaskRow | undefined; return row ? this.toModel(row) : null }
  findActiveByRecordingId(recordingId: string): Task | null { const row = this.database.prepare("SELECT * FROM tasks WHERE recording_id = ? AND status IN ('QUEUED', 'RUNNING') ORDER BY created_at DESC LIMIT 1").get(recordingId) as TaskRow | undefined; return row ? this.toModel(row) : null }
  findLatestByRecordingId(recordingId: string): Task | null { const row = this.database.prepare('SELECT * FROM tasks WHERE recording_id = ? ORDER BY created_at DESC LIMIT 1').get(recordingId) as TaskRow | undefined; return row ? this.toModel(row) : null }
  listByFileId(fileId: string): Task[] { return (this.database.prepare('SELECT * FROM tasks WHERE file_id = ? ORDER BY created_at DESC').all(fileId) as TaskRow[]).map((row) => this.toModel(row)) }

  update(id: string, input: UpdateTaskInput): Task | null {
    const updates: string[] = []
    const parameters: Record<string, unknown> = { id }
    const fields: [keyof UpdateTaskInput, string][] = [['status', 'status'], ['currentStep', 'current_step'], ['progress', 'progress'], ['retryCount', 'retry_count'], ['errorCode', 'error_code'], ['errorMessage', 'error_message'], ['startedAt', 'started_at'], ['finishedAt', 'finished_at'], ['updatedAt', 'updated_at']]
    for (const [property, column] of fields) { if (input[property] !== undefined) { const parameter = property; updates.push(`${column} = @${parameter}`); parameters[parameter] = input[property] } }
    if (updates.length === 0) return this.findById(id)
    this.database.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = @id`).run(parameters)
    return this.findById(id)
  }

  findLatestByFileId(fileId: string): Task | null {
    const row = this.database.prepare(
      'SELECT * FROM tasks WHERE file_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(fileId) as TaskRow | undefined
    return row ? this.toModel(row) : null
  }

  listIdsByStatus(status: Task['status'], limit: number): string[] {
    const rows = this.database.prepare(
      'SELECT id FROM tasks WHERE status = ? ORDER BY created_at ASC LIMIT ?',
    ).all(status, limit) as { id: string }[]
    return rows.map((row) => row.id)
  }

  claimQueued(id: string): number {
    const now = new Date().toISOString()
    const result = this.database.prepare(`
      UPDATE tasks
      SET status = 'RUNNING', started_at = @startedAt, updated_at = @updatedAt
      WHERE id = @id AND status = 'QUEUED'
    `).run({ id, startedAt: now, updatedAt: now })
    return result.changes
  }

  updateRunning(id: string, currentStep: Task['currentStep'], progress: number): number {
    const now = new Date().toISOString()
    const result = this.database.prepare(`
      UPDATE tasks
      SET current_step = @currentStep, progress = @progress, updated_at = @updatedAt
      WHERE id = @id AND status = 'RUNNING'
    `).run({ id, currentStep, progress, updatedAt: now })
    return result.changes
  }

  markSucceeded(id: string, currentStep: Task['currentStep'], progress: number): number {
    const now = new Date().toISOString()
    const result = this.database.prepare(`
      UPDATE tasks
      SET status = 'SUCCEEDED',
          current_step = @currentStep,
          progress = @progress,
          error_code = NULL,
          error_message = NULL,
          finished_at = @finishedAt,
          updated_at = @updatedAt
      WHERE id = @id AND status = 'RUNNING'
    `).run({ id, currentStep, progress, finishedAt: now, updatedAt: now })
    return result.changes
  }

  markFailed(id: string, expectedStatus: 'RUNNING', errorCode: string, errorMessage: string): number {
    const now = new Date().toISOString()
    const result = this.database.prepare(`
      UPDATE tasks
      SET status = 'FAILED',
          error_code = @errorCode,
          error_message = @errorMessage,
          finished_at = @finishedAt,
          updated_at = @updatedAt
      WHERE id = @id AND status = @expectedStatus
    `).run({ id, expectedStatus, errorCode, errorMessage, finishedAt: now, updatedAt: now })
    return result.changes
  }

  private toModel(row: TaskRow): Task { return { id: row.id, fileId: row.file_id, recordingId: row.recording_id, noteId: row.note_id, taskType: row.task_type, status: row.status, currentStep: row.current_step, progress: row.progress, retryCount: row.retry_count, requestId: row.request_id, idempotencyKey: row.idempotency_key, errorCode: row.error_code, errorMessage: row.error_message, startedAt: row.started_at, finishedAt: row.finished_at, createdAt: row.created_at, updatedAt: row.updated_at } }
}
