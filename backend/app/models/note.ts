import type { KnowledgeItem } from './knowledge-item.js'

export const NOTE_TAG_CODES = ['TODO', 'IDEA', 'WORK'] as const

export type NoteTagCode = (typeof NOTE_TAG_CODES)[number]

export type NoteStatus = 'CREATED' | 'DELETED'

export type Note = {
  id: string
  title: string
  tags: NoteTagCode[]
  bodyHtml: string
  bodyText: string
  status: NoteStatus
  createdAt: string
  updatedAt: string
  createRequestId: string | null
  createRequestHash: string | null
}

export type NoteWithKnowledge = Note & {
  knowledgeItem: KnowledgeItem | null
}

export type CreateNoteRecord = {
  id: string
  title: string
  tags: readonly NoteTagCode[]
  bodyHtml: string
  bodyText: string
  createRequestId: string
  createRequestHash: string
}

export type UpdateNoteRecord = {
  title?: string
  tags?: readonly NoteTagCode[]
  bodyHtml?: string
  bodyText?: string
}
