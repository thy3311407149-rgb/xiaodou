import type Database from 'better-sqlite3'
import { getDatabaseConnection } from '../db/connection.js'
import type { CreateOperationLogInput, OperationLog } from '../models/operation-log.js'

type OperationLogRow = { id: string; request_id: string; task_id: string | null; file_id: string | null; operation: OperationLog['operation']; status: OperationLog['status']; duration_ms: number | null; error_message: string | null; created_at: string }

export class OperationLogRepository {
  constructor(private readonly database: Database.Database = getDatabaseConnection()) {}

  create(input: CreateOperationLogInput): OperationLog { this.database.prepare('INSERT INTO operation_logs (id, request_id, task_id, file_id, operation, status, duration_ms, error_message) VALUES (@id, @requestId, @taskId, @fileId, @operation, @status, @durationMs, @errorMessage)').run({ id: input.id, requestId: input.requestId, taskId: input.taskId ?? null, fileId: input.fileId ?? null, operation: input.operation, status: input.status, durationMs: input.durationMs ?? null, errorMessage: input.errorMessage ?? null }); return this.findById(input.id) as OperationLog }
  findByRequestId(requestId: string): OperationLog[] { return (this.database.prepare('SELECT * FROM operation_logs WHERE request_id = ? ORDER BY created_at ASC').all(requestId) as OperationLogRow[]).map((row) => this.toModel(row)) }
  listByFileId(fileId: string): OperationLog[] { return (this.database.prepare('SELECT * FROM operation_logs WHERE file_id = ? ORDER BY created_at ASC').all(fileId) as OperationLogRow[]).map((row) => this.toModel(row)) }
  listByTaskId(taskId: string): OperationLog[] { return (this.database.prepare('SELECT * FROM operation_logs WHERE task_id = ? ORDER BY created_at ASC').all(taskId) as OperationLogRow[]).map((row) => this.toModel(row)) }
  private findById(id: string): OperationLog | null { const row = this.database.prepare('SELECT * FROM operation_logs WHERE id = ?').get(id) as OperationLogRow | undefined; return row ? this.toModel(row) : null }
  private toModel(row: OperationLogRow): OperationLog { return { id: row.id, requestId: row.request_id, taskId: row.task_id, fileId: row.file_id, operation: row.operation, status: row.status, durationMs: row.duration_ms, errorMessage: row.error_message, createdAt: row.created_at } }
}
