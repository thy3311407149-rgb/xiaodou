import type Database from 'better-sqlite3'
import { getDatabaseConnection } from '../db/connection.js'
import type { KnowledgeItem, KnowledgeItemStatus } from '../models/knowledge-item.js'
import type { CreateNoteRecord, Note, NoteStatus, NoteTagCode, NoteWithKnowledge, UpdateNoteRecord } from '../models/note.js'

type NoteRow = {
  id: string
  title: string
  tags_json: string
  body_html: string
  body_text: string
  status: NoteStatus
  created_at: string
  updated_at: string
  create_request_id: string | null
  create_request_hash: string | null
}

type KnowledgeItemRow = {
  id: string
  source_type: 'NOTE'
  source_id: string
  title: string
  status: KnowledgeItemStatus
  created_at: string
  updated_at: string
}

export class NoteRepository {
  constructor(private readonly database: Database.Database = getDatabaseConnection()) {}

  create(input: CreateNoteRecord): Note {
    this.database.prepare(`
      INSERT INTO notes (
        id, title, tags_json, body_html, body_text, status, create_request_id, create_request_hash
      ) VALUES (
        @id, @title, @tagsJson, @bodyHtml, @bodyText, 'CREATED', @createRequestId, @createRequestHash
      )
    `).run({
      id: input.id,
      title: input.title,
      tagsJson: JSON.stringify(input.tags),
      bodyHtml: input.bodyHtml,
      bodyText: input.bodyText,
      createRequestId: input.createRequestId,
      createRequestHash: input.createRequestHash,
    })
    return this.findById(input.id) as Note
  }

  findById(id: string): Note | null {
    const row = this.database.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined
    return row ? this.toNote(row) : null
  }

  findByCreateRequestId(createRequestId: string): Note | null {
    const row = this.database.prepare('SELECT * FROM notes WHERE create_request_id = ?').get(createRequestId) as NoteRow | undefined
    return row ? this.toNote(row) : null
  }

  findWithKnowledgeItem(id: string): NoteWithKnowledge | null {
    const note = this.findById(id)
    if (!note) return null
    return { ...note, knowledgeItem: this.findKnowledgeItem(id) }
  }

  listCreated(limit: number, offset: number): Note[] {
    const rows = this.database.prepare(`
      SELECT * FROM notes
      WHERE status = 'CREATED'
      ORDER BY updated_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as NoteRow[]
    return rows.map((row) => this.toNote(row))
  }

  countCreated(): number {
    const row = this.database.prepare(`SELECT COUNT(*) AS total FROM notes WHERE status = 'CREATED'`).get() as { total: number }
    return row.total
  }

  update(id: string, patch: UpdateNoteRecord): Note | null {
    const assignments: string[] = []
    const values: unknown[] = []
    if (patch.title !== undefined) {
      assignments.push('title = ?')
      values.push(patch.title)
    }
    if (patch.tags !== undefined) {
      assignments.push('tags_json = ?')
      values.push(JSON.stringify(patch.tags))
    }
    if (patch.bodyHtml !== undefined) {
      assignments.push('body_html = ?')
      values.push(patch.bodyHtml)
    }
    if (patch.bodyText !== undefined) {
      assignments.push('body_text = ?')
      values.push(patch.bodyText)
    }
    if (assignments.length === 0) return this.findById(id)
    assignments.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
    this.database.prepare(`UPDATE notes SET ${assignments.join(', ')} WHERE id = ?`).run(...values, id)
    return this.findById(id)
  }

  markDeleted(id: string): Note | null {
    this.database.prepare(`
      UPDATE notes
      SET status = 'DELETED', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND status != 'DELETED'
    `).run(id)
    return this.findById(id)
  }

  updateKnowledgeItemTitle(noteId: string, title: string): number {
    return this.database.prepare(`
      UPDATE knowledge_items
      SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE source_type = 'NOTE' AND source_id = ?
    `).run(title, noteId).changes
  }

  markKnowledgeItemDeleted(noteId: string): number {
    return this.database.prepare(`
      UPDATE knowledge_items
      SET status = 'DELETED', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE source_type = 'NOTE' AND source_id = ? AND status != 'DELETED'
    `).run(noteId).changes
  }

  private findKnowledgeItem(noteId: string): KnowledgeItem | null {
    const row = this.database.prepare(`
      SELECT * FROM knowledge_items WHERE source_type = 'NOTE' AND source_id = ?
    `).get(noteId) as KnowledgeItemRow | undefined
    if (!row) return null
    return {
      id: row.id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      title: row.title,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private toNote(row: NoteRow): Note {
    return {
      id: row.id,
      title: row.title,
      tags: parseTags(row.tags_json),
      bodyHtml: row.body_html,
      bodyText: row.body_text,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createRequestId: row.create_request_id,
      createRequestHash: row.create_request_hash,
    }
  }
}

function parseTags(value: string): NoteTagCode[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed)) return []
  return parsed.filter((tag): tag is NoteTagCode => tag === 'TODO' || tag === 'IDEA' || tag === 'WORK')
}
