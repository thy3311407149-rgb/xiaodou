import type Database from 'better-sqlite3'
import { getDatabaseConnection } from '../db/connection.js'
import type { CreateFileInput, File, UpdateFileInput } from '../models/file.js'

type FileRow = {
  id: string
  user_id: string
  file_name: string
  file_type: 'application/pdf'
  file_size: number
  storage_path: string
  status: File['status']
  error_code: string | null
  error_message: string | null
  idempotency_key: string | null
  created_at: string
  updated_at: string
}

export class FileRepository {
  constructor(private readonly database: Database.Database = getDatabaseConnection()) {}

  create(input: CreateFileInput): File {
    this.database.prepare(`
      INSERT INTO files (id, user_id, file_name, file_type, file_size, storage_path, status, idempotency_key)
      VALUES (@id, @userId, @fileName, @fileType, @fileSize, @storagePath, @status, @idempotencyKey)
    `).run({
      id: input.id,
      userId: input.userId ?? 'demo-user',
      fileName: input.fileName,
      fileType: input.fileType,
      fileSize: input.fileSize,
      storagePath: input.storagePath,
      status: input.status ?? 'CREATED',
      idempotencyKey: input.idempotencyKey ?? null,
    })
    return this.findById(input.id) as File
  }

  findById(id: string): File | null {
    const row = this.database.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined
    return row ? this.toModel(row) : null
  }

  findByIdempotencyKey(idempotencyKey: string): File | null {
    const row = this.database.prepare('SELECT * FROM files WHERE idempotency_key = ?').get(idempotencyKey) as FileRow | undefined
    return row ? this.toModel(row) : null
  }

  listByUser(userId: string, limit: number, offset: number): File[] {
    const rows = this.database.prepare(`
      SELECT * FROM files WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(userId, limit, offset) as FileRow[]
    return rows.map((row) => this.toModel(row))
  }

  update(id: string, input: UpdateFileInput): File | null {
    const updates: string[] = []
    const parameters: Record<string, unknown> = { id }
    if (input.status !== undefined) { updates.push('status = @status'); parameters.status = input.status }
    if (input.errorCode !== undefined) { updates.push('error_code = @errorCode'); parameters.errorCode = input.errorCode }
    if (input.errorMessage !== undefined) { updates.push('error_message = @errorMessage'); parameters.errorMessage = input.errorMessage }
    if (input.updatedAt !== undefined) { updates.push('updated_at = @updatedAt'); parameters.updatedAt = input.updatedAt }
    if (updates.length === 0) return this.findById(id)
    this.database.prepare(`UPDATE files SET ${updates.join(', ')} WHERE id = @id`).run(parameters)
    return this.findById(id)
  }

  private toModel(row: FileRow): File {
    return { id: row.id, userId: row.user_id, fileName: row.file_name, fileType: row.file_type, fileSize: row.file_size, storagePath: row.storage_path, status: row.status, errorCode: row.error_code, errorMessage: row.error_message, idempotencyKey: row.idempotency_key, createdAt: row.created_at, updatedAt: row.updated_at }
  }
}
