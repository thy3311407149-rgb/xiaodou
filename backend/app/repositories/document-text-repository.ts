import type Database from 'better-sqlite3'
import { getDatabaseConnection } from '../db/connection.js'
import type { CreateDocumentTextInput, DocumentText } from '../models/document-text.js'

type DocumentTextRow = { id: string; file_id: string; page_number: number; content: string; created_at: string }

export class DocumentTextRepository {
  constructor(private readonly database: Database.Database = getDatabaseConnection()) {}

  create(input: CreateDocumentTextInput): DocumentText { this.database.prepare('INSERT INTO document_texts (id, file_id, page_number, content) VALUES (@id, @fileId, @pageNumber, @content)').run({ id: input.id, fileId: input.fileId, pageNumber: input.pageNumber, content: input.content }); return this.findById(input.id) as DocumentText }
  createMany(inputs: CreateDocumentTextInput[]): DocumentText[] { const insert = this.database.prepare('INSERT INTO document_texts (id, file_id, page_number, content) VALUES (@id, @fileId, @pageNumber, @content)'); const insertMany = this.database.transaction((rows: CreateDocumentTextInput[]) => { for (const input of rows) insert.run({ id: input.id, fileId: input.fileId, pageNumber: input.pageNumber, content: input.content }) }); insertMany(inputs); return inputs.map((input) => this.findById(input.id) as DocumentText) }
  findByFileId(fileId: string): DocumentText[] { return (this.database.prepare('SELECT * FROM document_texts WHERE file_id = ? ORDER BY page_number ASC').all(fileId) as DocumentTextRow[]).map((row) => this.toModel(row)) }
  deleteByFileId(fileId: string): number { return this.database.prepare('DELETE FROM document_texts WHERE file_id = ?').run(fileId).changes }

  replaceForFile(fileId: string, inputs: CreateDocumentTextInput[]): DocumentText[] {
    const replace = this.database.transaction(() => {
      this.deleteByFileId(fileId)
      if (inputs.length === 0) return []
      return this.createMany(inputs)
    })
    return replace()
  }
  private findById(id: string): DocumentText | null { const row = this.database.prepare('SELECT * FROM document_texts WHERE id = ?').get(id) as DocumentTextRow | undefined; return row ? this.toModel(row) : null }
  private toModel(row: DocumentTextRow): DocumentText { return { id: row.id, fileId: row.file_id, pageNumber: row.page_number, content: row.content, createdAt: row.created_at } }
}
