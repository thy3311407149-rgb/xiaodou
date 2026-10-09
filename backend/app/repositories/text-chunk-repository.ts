import type Database from 'better-sqlite3'
import { getDatabaseConnection } from '../db/connection.js'
import type { CreateTextChunkInput, TextChunk } from '../models/text-chunk.js'

type TextChunkRow = { id: string; file_id: string; page_number: number | null; chunk_index: number; content: string; token_count: number; embedding_status: TextChunk['embeddingStatus']; created_at: string }

export class TextChunkRepository {
  constructor(private readonly database: Database.Database = getDatabaseConnection()) {}

  create(input: CreateTextChunkInput): TextChunk { this.database.prepare('INSERT INTO text_chunks (id, file_id, page_number, chunk_index, content, token_count, embedding_status) VALUES (@id, @fileId, @pageNumber, @chunkIndex, @content, @tokenCount, @embeddingStatus)').run({ id: input.id, fileId: input.fileId, pageNumber: input.pageNumber ?? null, chunkIndex: input.chunkIndex, content: input.content, tokenCount: input.tokenCount ?? 0, embeddingStatus: input.embeddingStatus ?? 'NOT_READY' }); return this.findById(input.id) as TextChunk }
  createMany(inputs: CreateTextChunkInput[]): TextChunk[] { const insert = this.database.prepare('INSERT INTO text_chunks (id, file_id, page_number, chunk_index, content, token_count, embedding_status) VALUES (@id, @fileId, @pageNumber, @chunkIndex, @content, @tokenCount, @embeddingStatus)'); const insertMany = this.database.transaction((rows: CreateTextChunkInput[]) => { for (const input of rows) insert.run({ id: input.id, fileId: input.fileId, pageNumber: input.pageNumber ?? null, chunkIndex: input.chunkIndex, content: input.content, tokenCount: input.tokenCount ?? 0, embeddingStatus: input.embeddingStatus ?? 'NOT_READY' }) }); insertMany(inputs); return inputs.map((input) => this.findById(input.id) as TextChunk) }
  findByFileId(fileId: string): TextChunk[] { return (this.database.prepare('SELECT * FROM text_chunks WHERE file_id = ? ORDER BY chunk_index ASC').all(fileId) as TextChunkRow[]).map((row) => this.toModel(row)) }
  deleteByFileId(fileId: string): number { return this.database.prepare('DELETE FROM text_chunks WHERE file_id = ?').run(fileId).changes }
  private findById(id: string): TextChunk | null { const row = this.database.prepare('SELECT * FROM text_chunks WHERE id = ?').get(id) as TextChunkRow | undefined; return row ? this.toModel(row) : null }
  private toModel(row: TextChunkRow): TextChunk { return { id: row.id, fileId: row.file_id, pageNumber: row.page_number, chunkIndex: row.chunk_index, content: row.content, tokenCount: row.token_count, embeddingStatus: row.embedding_status, createdAt: row.created_at } }
}
