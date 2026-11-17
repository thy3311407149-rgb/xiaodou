import type { File } from './file.js'

export type KnowledgeSourceType = 'PDF' | 'RECORDING' | 'NOTE'

export type KnowledgeItemStatus = 'ACTIVE' | 'DELETED'

export type KnowledgeItem = {
  id: string
  sourceType: KnowledgeSourceType
  sourceId: string
  title: string
  status: KnowledgeItemStatus
  createdAt: string
  updatedAt: string
}

export type CreateKnowledgeItemInput = {
  id: string
  sourceType: KnowledgeSourceType
  sourceId: string
  title: string
  status?: KnowledgeItemStatus
}

export type KnowledgeItemSource = {
  sourceType: KnowledgeSourceType
  sourceId: string
  file: File | null
}
