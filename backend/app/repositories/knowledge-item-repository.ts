import type Database from 'better-sqlite3'
import { getDatabaseConnection } from '../db/connection.js'
import type { CreateKnowledgeItemInput, KnowledgeItem, KnowledgeItemStatus, KnowledgeSourceType } from '../models/knowledge-item.js'

type KnowledgeItemRow = {
  id: string
  source_type: KnowledgeSourceType
  source_id: string
  title: string
  status: KnowledgeItemStatus
  created_at: string
  updated_at: string
}

export class KnowledgeItemRepository {
  constructor(private readonly database: Database.Database = getDatabaseConnection()) {}

  create(input: CreateKnowledgeItemInput): KnowledgeItem {
    this.database.prepare(`
      INSERT INTO knowledge_items (id, source_type, source_id, title, status)
      VALUES (@id, @sourceType, @sourceId, @title, @status)
    `).run({
      id: input.id,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      title: input.title,
      status: input.status ?? 'ACTIVE',
    })
    return this.findById(input.id) as KnowledgeItem
  }

  findById(id: string): KnowledgeItem | null {
    const row = this.database.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(id) as KnowledgeItemRow | undefined
    return row ? this.toModel(row) : null
  }

  findBySource(sourceType: KnowledgeSourceType, sourceId: string): KnowledgeItem | null {
    const row = this.database.prepare(`
      SELECT * FROM knowledge_items WHERE source_type = ? AND source_id = ?
    `).get(sourceType, sourceId) as KnowledgeItemRow | undefined
    return row ? this.toModel(row) : null
  }

  findCurrentSummaryId(knowledgeItemId: string): string | null {
    const row = this.database.prepare(`
      SELECT summary_id FROM knowledge_item_summaries WHERE knowledge_item_id = ?
    `).get(knowledgeItemId) as { summary_id: string } | undefined
    return row?.summary_id ?? null
  }

  replaceCurrentSummary(knowledgeItemId: string, summaryId: string): void {
    const replace = this.database.transaction(() => {
      this.database.prepare('DELETE FROM knowledge_item_summaries WHERE knowledge_item_id = ?').run(knowledgeItemId)
      this.database.prepare(`
        INSERT INTO knowledge_item_summaries (knowledge_item_id, summary_id)
        VALUES (?, ?)
      `).run(knowledgeItemId, summaryId)
    })
    replace()
  }

  updateStatus(id: string, status: KnowledgeItemStatus): KnowledgeItem | null {
    this.database.prepare(`
      UPDATE knowledge_items
      SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(status, id)
    return this.findById(id)
  }

  private toModel(row: KnowledgeItemRow): KnowledgeItem {
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
}
