import type Database from 'better-sqlite3'
import { getDatabaseConnection } from '../db/connection.js'
import type { Citation, CreateSummaryInput, Summary, SummaryKeyPoint } from '../models/summary.js'

type SummaryRow = { id: string; file_id: string; task_id: string; content: string; key_points: string; citations: string; model_name: string; prompt_version: string; input_tokens: number; output_tokens: number; created_at: string; updated_at: string }

export class SummaryRepository {
  constructor(private readonly database: Database.Database = getDatabaseConnection()) {}

  create(input: CreateSummaryInput): Summary { this.database.prepare('INSERT INTO summaries (id, file_id, task_id, content, key_points, citations, model_name, prompt_version, input_tokens, output_tokens) VALUES (@id, @fileId, @taskId, @content, @keyPoints, @citations, @modelName, @promptVersion, @inputTokens, @outputTokens)').run({ id: input.id, fileId: input.fileId, taskId: input.taskId, content: input.content, keyPoints: JSON.stringify(input.keyPoints), citations: JSON.stringify(input.citations), modelName: input.modelName, promptVersion: input.promptVersion, inputTokens: input.inputTokens ?? 0, outputTokens: input.outputTokens ?? 0 }); return this.findById(input.id) as Summary }
  findById(id: string): Summary | null { const row = this.database.prepare('SELECT * FROM summaries WHERE id = ?').get(id) as SummaryRow | undefined; return row ? this.toModel(row) : null }
  findByTaskId(taskId: string): Summary | null { const row = this.database.prepare('SELECT * FROM summaries WHERE task_id = ?').get(taskId) as SummaryRow | undefined; return row ? this.toModel(row) : null }
  findLatestByFileId(fileId: string): Summary | null { const row = this.database.prepare('SELECT * FROM summaries WHERE file_id = ? ORDER BY created_at DESC LIMIT 1').get(fileId) as SummaryRow | undefined; return row ? this.toModel(row) : null }
  listByFileId(fileId: string): Summary[] { return (this.database.prepare('SELECT * FROM summaries WHERE file_id = ? ORDER BY created_at DESC').all(fileId) as SummaryRow[]).map((row) => this.toModel(row)) }

  replaceForTask(input: CreateSummaryInput): Summary {
    const replace = this.database.transaction(() => {
      this.database.prepare('DELETE FROM summaries WHERE task_id = ?').run(input.taskId)
      return this.create(input)
    })
    return replace()
  }

  private toModel(row: SummaryRow): Summary { return { id: row.id, fileId: row.file_id, taskId: row.task_id, content: row.content, keyPoints: this.parseJson<SummaryKeyPoint[]>(row.key_points, 'key_points', row.id), citations: this.parseJson<Citation[]>(row.citations, 'citations', row.id), modelName: row.model_name, promptVersion: row.prompt_version, inputTokens: row.input_tokens, outputTokens: row.output_tokens, createdAt: row.created_at, updatedAt: row.updated_at } }
  private parseJson<T>(value: string, field: string, summaryId: string): T { try { return JSON.parse(value) as T } catch (error: unknown) { throw new Error(`Invalid JSON in summaries.${field} for summary ${summaryId}`, { cause: error }) } }
}
