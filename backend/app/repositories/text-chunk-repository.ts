import type Database from 'better-sqlite3'
import { getDatabaseConnection } from '../db/connection.js'
import type { CreateTextChunkInput, TextChunk } from '../models/text-chunk.js'

type TextChunkRow = { id: string; file_id: string; page_number: number | null; chunk_index: number; content: string; token_count: number; embedding_status: TextChunk['embeddingStatus']; created_at: string }

export class TextChunkRepository {
  constructor(private readonly database: Database.Database = getDatabaseConnection()) {}

  create(input: CreateTextChunkInput): TextChunk { this.database.prepare('INSERT INTO text_chunks (id, file_id, page_number, chunk_index, content, token_count, embedding_status) VALUES (@id, @fileId, @pageNumber, @chunkIndex, @content, @tokenCount, @embeddingStatus)').run({ id: input.id, fileId: input.fileId, pageNumber: input.pageNumber ?? null, chunkIndex: input.chunkIndex, content: input.content, tokenCount: input.tokenCount ?? 0, embeddingStatus: input.embeddingStatus ?? 'NOT_READY' }); return this.findById(input.id) as TextChunk }
  createMany(inputs: CreateTextChunkInput[]): TextChunk[] { const insert = this.database.prepare('INSERT INTO text_chunks (id, file_id, page_number, chunk_index, content, token_count, embedding_status) VALUES (@id, @fileId, @pageNumber, @chunkIndex, @content, @tokenCount, @embeddingStatus)'); const insertMany = this.database.transaction((rows: CreateTextChunkInput[]) => { for (const input of rows) insert.run({ id: input.id, fileId: input.fileId, pageNumber: input.pageNumber ?? null, chunkIndex: input.chunkIndex, content: input.content, tokenCount: input.tokenCount ?? 0, embeddingStatus: input.embeddingStatus ?? 'NOT_READY' }) }); insertMany(inputs); return inputs.map((input) => this.findById(input.id) as TextChunk) }
  findByFileId(fileId: string): TextChunk[] {
    return this.selectAvailable('text_chunks.file_id = ?', [fileId], 'text_chunks.chunk_index ASC')
  }

  findByIds(ids: readonly string[]): TextChunk[] {
    const uniqueIds = [...new Set(ids)]
    if (uniqueIds.length === 0) return []
    const placeholders = uniqueIds.map(() => '?').join(', ')
    const chunks = this.selectAvailable(`text_chunks.id IN (${placeholders})`, uniqueIds, 'text_chunks.chunk_index ASC')
    const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]))
    return uniqueIds.flatMap((id) => {
      const chunk = chunksById.get(id)
      return chunk ? [chunk] : []
    })
  }

  searchByKeyword(keyword: string, limit: number): TextChunk[] {
    const normalized = keyword.trim()
    const resultLimit = Math.floor(limit)
    if (normalized.length === 0 || resultLimit <= 0) return []
    return this.selectAvailable(
      `text_chunks.content LIKE ? ESCAPE '\\'`,
      [`%${escapeLike(normalized)}%`],
      'text_chunks.created_at ASC, text_chunks.chunk_index ASC',
      resultLimit,
    )
  }

  listAvailableChunks(): TextChunk[] {
    return this.selectAvailable('1 = 1', [], 'text_chunks.file_id ASC, text_chunks.chunk_index ASC')
  }

  deleteByFileId(fileId: string): number { return this.database.prepare('DELETE FROM text_chunks WHERE file_id = ?').run(fileId).changes }

  createChunks(fileId: string, inputs: CreateTextChunkInput[]): TextChunk[] {
    const replace = this.database.transaction(() => {
      this.deleteByFileId(fileId)
      if (inputs.length === 0) return []
      return this.createMany(inputs)
    })
    return replace()
  }
  private selectAvailable(condition: string, parameters: readonly unknown[], orderBy: string, limit?: number): TextChunk[] {
    const limitSql = limit === undefined ? '' : ' LIMIT ?'
    const bound = limit === undefined ? parameters : [...parameters, limit]
    const rows = this.database.prepare(`
      SELECT text_chunks.*
      FROM text_chunks
      INNER JOIN files ON files.id = text_chunks.file_id
      WHERE files.status != 'DELETED'
        AND length(trim(text_chunks.content)) > 0
        AND ${condition}
      ORDER BY ${orderBy}${limitSql}
    `).all(...bound) as TextChunkRow[]
    return rows.map((row) => this.toModel(row))
  }

  private findById(id: string): TextChunk | null { const row = this.database.prepare('SELECT * FROM text_chunks WHERE id = ?').get(id) as TextChunkRow | undefined; return row ? this.toModel(row) : null }
  private toModel(row: TextChunkRow): TextChunk { return { id: row.id, fileId: row.file_id, pageNumber: row.page_number, chunkIndex: row.chunk_index, content: row.content, tokenCount: row.token_count, embeddingStatus: row.embedding_status, createdAt: row.created_at } }
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}
