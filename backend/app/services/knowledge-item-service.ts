import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDatabaseConnection } from '../db/connection.js'
import type { File } from '../models/file.js'
import type { CreateKnowledgeItemInput, KnowledgeItem, KnowledgeItemSource, KnowledgeSourceType } from '../models/knowledge-item.js'
import type { Summary } from '../models/summary.js'
import { FileRepository } from '../repositories/file-repository.js'
import { KnowledgeItemRepository } from '../repositories/knowledge-item-repository.js'
import { SummaryRepository } from '../repositories/summary-repository.js'

export type KnowledgeItemServiceDependencies = {
  database?: Database.Database
  knowledgeItemRepository?: KnowledgeItemRepository
  fileRepository?: FileRepository
  summaryRepository?: SummaryRepository
}

export class KnowledgeItemService {
  private readonly knowledgeItems: KnowledgeItemRepository
  private readonly files: FileRepository
  private readonly summaries: SummaryRepository

  constructor(dependencies: KnowledgeItemServiceDependencies = {}) {
    const database = dependencies.database ?? getDatabaseConnection()
    this.knowledgeItems = dependencies.knowledgeItemRepository ?? new KnowledgeItemRepository(database)
    this.files = dependencies.fileRepository ?? new FileRepository(database)
    this.summaries = dependencies.summaryRepository ?? new SummaryRepository(database)
  }

  create(input: CreateKnowledgeItemInput): KnowledgeItem {
    this.assertSourceAvailable(input.sourceType, input.sourceId)
    const existing = this.knowledgeItems.findBySource(input.sourceType, input.sourceId)
    if (existing) {
      throw new Error('knowledge item already exists for source')
    }
    if (input.sourceType === 'PDF' && !this.files.findById(input.sourceId)) {
      throw new Error('PDF source file not found')
    }
    return this.knowledgeItems.create(input)
  }

  ensureForSource(input: Omit<CreateKnowledgeItemInput, 'id'> & { id?: string }): KnowledgeItem {
    const existing = this.knowledgeItems.findBySource(input.sourceType, input.sourceId)
    if (existing) return existing
    return this.create({ ...input, id: input.id ?? randomUUID() })
  }

  getById(id: string): KnowledgeItem | null {
    return this.knowledgeItems.findById(id)
  }

  getBySource(sourceType: KnowledgeSourceType, sourceId: string): KnowledgeItem | null {
    return this.knowledgeItems.findBySource(sourceType, sourceId)
  }

  getSource(id: string): KnowledgeItemSource {
    const item = this.requireItem(id)
    const file: File | null = item.sourceType === 'PDF' ? this.files.findById(item.sourceId) : null
    return { sourceType: item.sourceType, sourceId: item.sourceId, file }
  }

  getCurrentSummary(id: string): Summary | null {
    const item = this.requireItem(id)
    const summaryId = this.knowledgeItems.findCurrentSummaryId(item.id)
    return summaryId ? this.summaries.findById(summaryId) : null
  }

  replaceCurrentSummary(id: string, summaryId: string): Summary {
    this.requireItem(id)
    const summary = this.summaries.findById(summaryId)
    if (!summary) throw new Error('summary not found')
    this.knowledgeItems.replaceCurrentSummary(id, summaryId)
    return summary
  }

  markSourceDeleted(sourceType: KnowledgeSourceType, sourceId: string): KnowledgeItem | null {
    const item = this.knowledgeItems.findBySource(sourceType, sourceId)
    if (!item || item.status === 'DELETED') return item
    return this.knowledgeItems.updateStatus(item.id, 'DELETED')
  }

  private requireItem(id: string): KnowledgeItem {
    const item = this.knowledgeItems.findById(id)
    if (!item) throw new Error('knowledge item not found')
    return item
  }

  private assertSourceAvailable(sourceType: KnowledgeSourceType, sourceId: string): void {
    if (sourceType !== 'PDF' && sourceType !== 'RECORDING' && sourceType !== 'NOTE') {
      throw new Error('unsupported knowledge source type')
    }
    if (sourceId.trim().length === 0) throw new Error('source id is required')
  }
}
