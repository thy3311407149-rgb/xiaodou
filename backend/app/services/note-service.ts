import { createHash, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { getDatabaseConnection } from '../db/connection.js'
import { ApplicationError } from '../core/errors/application-error.js'
import type { CreateKnowledgeItemInput, KnowledgeItem } from '../models/knowledge-item.js'
import { NOTE_TAG_CODES, type Note, type NoteTagCode, type NoteWithKnowledge } from '../models/note.js'
import { KnowledgeItemRepository } from '../repositories/knowledge-item-repository.js'
import { NoteRepository } from '../repositories/note-repository.js'
import { extractNoteText } from './note/html-text-extractor.js'
import { sanitizeNoteHtml } from './note/html-sanitizer.js'

const MAX_PAGE_SIZE = 100

export type CreateNoteInput = {
  idempotencyKey: string
  title: string
  tags?: readonly string[]
  bodyHtml?: string
  id?: string
}

export type UpdateNoteInput = {
  title?: string
  tags?: readonly string[]
  bodyHtml?: string
}

export type CreateNoteOutcome = {
  note: NoteWithKnowledge
  created: boolean
}

export type NoteServiceDependencies = {
  database?: Database.Database
  noteRepository?: NoteRepository
  knowledgeItemRepository?: Pick<KnowledgeItemRepository, 'create'>
  sanitizeHtml?: (html: string) => string
  extractText?: (html: string) => string
}

type NormalizedNoteContent = {
  title: string
  tags: NoteTagCode[]
  bodyHtml: string
  bodyText: string
  hash: string
}

export function fingerprintNoteRequest(input: { title: string; tags: readonly NoteTagCode[]; bodyHtml: string }): string {
  return createHash('sha256').update(JSON.stringify({
    title: input.title,
    tags: input.tags,
    bodyHtml: input.bodyHtml,
  })).digest('hex')
}

export class NoteService {
  private readonly database: Database.Database
  private readonly notes: NoteRepository
  private readonly knowledgeItems: Pick<KnowledgeItemRepository, 'create'>
  private readonly sanitize: (html: string) => string
  private readonly extract: (html: string) => string

  constructor(dependencies: NoteServiceDependencies = {}) {
    this.database = dependencies.database ?? getDatabaseConnection()
    this.notes = dependencies.noteRepository ?? new NoteRepository(this.database)
    this.knowledgeItems = dependencies.knowledgeItemRepository ?? new KnowledgeItemRepository(this.database)
    this.sanitize = dependencies.sanitizeHtml ?? sanitizeNoteHtml
    this.extract = dependencies.extractText ?? extractNoteText
  }

  create(input: CreateNoteInput): NoteWithKnowledge {
    return this.createDetailed(input).note
  }

  createDetailed(input: CreateNoteInput): CreateNoteOutcome {
    const idempotencyKey = this.readIdempotencyKey(input.idempotencyKey)
    const content = this.normalizeContent({
      title: input.title,
      tags: input.tags,
      bodyHtml: input.bodyHtml,
    })
    const existing = this.notes.findByCreateRequestId(idempotencyKey)
    if (existing) return { note: this.replay(existing, content.hash), created: false }
    try {
      return {
        note: this.database.transaction(() => this.insertNote(input.id ?? randomUUID(), idempotencyKey, content))(),
        created: true,
      }
    } catch (error: unknown) {
      if (!isCreateRequestConflict(error)) throw error
      const raced = this.notes.findByCreateRequestId(idempotencyKey)
      if (!raced) throw new ApplicationError('DATABASE_ERROR', { message: '随笔创建冲突后没有找到原记录', cause: error })
      return { note: this.replay(raced, content.hash), created: false }
    }
  }

  get(id: string): NoteWithKnowledge {
    return this.requireWithKnowledge(id)
  }

  list(input: { page: number; pageSize: number }): { items: Note[]; page: number; pageSize: number; total: number } {
    if (!Number.isInteger(input.page) || input.page < 1 || !Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > MAX_PAGE_SIZE) {
      throw new ApplicationError('INVALID_REQUEST', { message: '分页参数无效' })
    }
    return {
      items: this.notes.listCreated(input.pageSize, (input.page - 1) * input.pageSize),
      page: input.page,
      pageSize: input.pageSize,
      total: this.notes.countCreated(),
    }
  }

  update(id: string, input: UpdateNoteInput): NoteWithKnowledge {
    const current = this.requireNote(id)
    if (current.status === 'DELETED') {
      throw new ApplicationError('INVALID_NOTE_STATE', { message: '已删除的随笔不能编辑' })
    }
    const patch = this.normalizeUpdate(input)
    if (!patch) return this.requireWithKnowledge(id)
    return this.database.transaction(() => {
      const note = this.notes.update(id, patch)
      if (!note) throw new ApplicationError('NOTE_NOT_FOUND')
      if (patch.title !== undefined && this.notes.updateKnowledgeItemTitle(id, patch.title) !== 1) {
        throw new ApplicationError('DATABASE_ERROR', { message: '随笔缺少对应的知识资料' })
      }
      return this.requireWithKnowledge(id)
    })()
  }

  delete(id: string): NoteWithKnowledge {
    const current = this.requireNote(id)
    if (current.status === 'DELETED') return this.requireWithKnowledge(id)
    return this.database.transaction(() => {
      const note = this.notes.markDeleted(id)
      if (!note || note.status !== 'DELETED') throw new ApplicationError('NOTE_NOT_FOUND')
      if (this.notes.markKnowledgeItemDeleted(id) !== 1) {
        throw new ApplicationError('DATABASE_ERROR', { message: '随笔缺少对应的知识资料' })
      }
      return this.requireWithKnowledge(id)
    })()
  }

  private insertNote(id: string, idempotencyKey: string, content: NormalizedNoteContent): NoteWithKnowledge {
    const note = this.notes.create({
      id,
      title: content.title,
      tags: content.tags,
      bodyHtml: content.bodyHtml,
      bodyText: content.bodyText,
      createRequestId: idempotencyKey,
      createRequestHash: content.hash,
    })
    const knowledgeItem = this.knowledgeItems.create({
      id: randomUUID(),
      sourceType: 'NOTE',
      sourceId: note.id,
      title: note.title,
      status: 'ACTIVE',
    } satisfies CreateKnowledgeItemInput)
    return { ...note, knowledgeItem }
  }

  private replay(note: Note, hash: string): NoteWithKnowledge {
    if (note.createRequestHash !== hash) {
      throw new ApplicationError('NOTE_IDEMPOTENCY_CONFLICT')
    }
    return this.requireWithKnowledge(note.id)
  }

  private normalizeUpdate(input: UpdateNoteInput): { title?: string; tags?: NoteTagCode[]; bodyHtml?: string; bodyText?: string } | null {
    const patch: { title?: string; tags?: NoteTagCode[]; bodyHtml?: string; bodyText?: string } = {}
    if (input.title !== undefined) patch.title = this.readTitle(input.title)
    if (input.tags !== undefined) patch.tags = normalizeTags(input.tags)
    if (input.bodyHtml !== undefined) {
      patch.bodyHtml = this.sanitize(this.readBody(input.bodyHtml))
      patch.bodyText = this.extract(patch.bodyHtml)
    }
    return Object.keys(patch).length === 0 ? null : patch
  }

  private normalizeContent(input: { title: string; tags?: readonly string[]; bodyHtml?: string }): NormalizedNoteContent {
    const title = this.readTitle(input.title)
    const tags = normalizeTags(input.tags ?? [])
    const bodyHtml = this.sanitize(this.readBody(input.bodyHtml ?? ''))
    const bodyText = this.extract(bodyHtml)
    return { title, tags, bodyHtml, bodyText, hash: fingerprintNoteRequest({ title, tags, bodyHtml }) }
  }

  private readIdempotencyKey(value: string): string {
    if (typeof value !== 'string') throw new ApplicationError('INVALID_REQUEST', { message: '缺少幂等键' })
    const key = value.trim()
    if (key.length === 0) throw new ApplicationError('INVALID_REQUEST', { message: '缺少幂等键' })
    return key
  }

  private readTitle(value: string): string {
    if (typeof value !== 'string') throw new ApplicationError('INVALID_REQUEST', { message: '标题不能为空' })
    const title = value.trim()
    if (title.length === 0) throw new ApplicationError('INVALID_REQUEST', { message: '标题不能为空' })
    return title
  }

  private readBody(value: string): string {
    if (typeof value !== 'string') throw new ApplicationError('INVALID_REQUEST', { message: '正文格式无效' })
    return value
  }

  private requireNote(id: string): Note {
    const note = this.notes.findById(id)
    if (!note) throw new ApplicationError('NOTE_NOT_FOUND')
    return note
  }

  private requireWithKnowledge(id: string): NoteWithKnowledge {
    const note = this.notes.findWithKnowledgeItem(id)
    if (!note) throw new ApplicationError('NOTE_NOT_FOUND')
    return note
  }
}

function normalizeTags(values: readonly string[]): NoteTagCode[] {
  if (!Array.isArray(values)) throw new ApplicationError('INVALID_REQUEST', { message: '标签格式无效' })
  const selected = new Set<NoteTagCode>()
  for (const value of values) {
    if (typeof value !== 'string' || !isNoteTag(value)) {
      throw new ApplicationError('INVALID_REQUEST', { message: '存在无法识别的标签' })
    }
    selected.add(value)
  }
  return NOTE_TAG_CODES.filter((tag) => selected.has(tag))
}

function isNoteTag(value: string): value is NoteTagCode {
  return (NOTE_TAG_CODES as readonly string[]).includes(value)
}

function isCreateRequestConflict(error: unknown): boolean {
  return error instanceof Database.SqliteError
    && error.code === 'SQLITE_CONSTRAINT_UNIQUE'
    && error.message.includes('notes.create_request_id')
}
