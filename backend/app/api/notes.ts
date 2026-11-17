import { Router } from 'express'
import { ApplicationError } from '../core/errors/application-error.js'
import type { Note, NoteWithKnowledge } from '../models/note.js'
import { NoteService, type CreateNoteInput, type UpdateNoteInput } from '../services/note-service.js'

const MAX_PAGE_SIZE = 100
const CREATE_FIELDS = new Set(['title', 'tags', 'bodyHtml'])
const UPDATE_FIELDS = new Set(['title', 'tags', 'bodyHtml'])

type NoteRouterOptions = {
  noteService?: NoteService
}

type PublicNote = {
  noteId: string
  title: string
  tags: Note['tags']
  bodyHtml: string
  bodyText: string
  status: Note['status']
  createdAt: string
  updatedAt: string
  knowledgeItemId?: string | null
}

export function createNoteRouter(options: NoteRouterOptions = {}): Router {
  const router = Router()
  let service = options.noteService
  const getService = (): NoteService => {
    service ??= new NoteService()
    return service
  }

  router.post('/api/notes', (request, response, next) => {
    try {
      const body = readObject(request.body)
      assertFields(body, CREATE_FIELDS)
      const input: CreateNoteInput = {
        idempotencyKey: request.get('Idempotency-Key') ?? '',
        title: body.title as string,
        ...(body.tags !== undefined ? { tags: body.tags as string[] } : {}),
        ...(body.bodyHtml !== undefined ? { bodyHtml: body.bodyHtml as string } : {}),
      }
      const outcome = getService().createDetailed(input)
      response.status(outcome.created ? 201 : 200).json({
        requestId: request.requestId,
        data: toPublicNote(outcome.note, true),
      })
    } catch (error: unknown) {
      next(error)
    }
  })

  router.get('/api/notes', (request, response, next) => {
    try {
      const page = readPage(request.query.page, 1)
      const pageSize = readPage(request.query.pageSize, 20, MAX_PAGE_SIZE)
      const listed = getService().list({ page, pageSize })
      response.json({
        requestId: request.requestId,
        data: {
          items: listed.items.map((note) => toPublicNote(note, false)),
          total: listed.total,
          page: listed.page,
          pageSize: listed.pageSize,
        },
      })
    } catch (error: unknown) {
      next(error)
    }
  })

  router.get('/api/notes/:noteId', (request, response, next) => {
    try {
      const note = requireVisible(getService().get(pathParam(request.params.noteId)))
      response.json({ requestId: request.requestId, data: toPublicNote(note, true) })
    } catch (error: unknown) {
      next(error)
    }
  })

  router.patch('/api/notes/:noteId', (request, response, next) => {
    try {
      const body = readObject(request.body)
      assertFields(body, UPDATE_FIELDS)
      const noteId = pathParam(request.params.noteId)
      requireVisible(getService().get(noteId))
      const input: UpdateNoteInput = {
        ...(body.title !== undefined ? { title: body.title as string } : {}),
        ...(body.tags !== undefined ? { tags: body.tags as string[] } : {}),
        ...(body.bodyHtml !== undefined ? { bodyHtml: body.bodyHtml as string } : {}),
      }
      const updated = getService().update(noteId, input)
      response.json({ requestId: request.requestId, data: toPublicNote(updated, true) })
    } catch (error: unknown) {
      next(hideDeletedNote(error))
    }
  })

  router.delete('/api/notes/:noteId', (request, response, next) => {
    try {
      const noteId = pathParam(request.params.noteId)
      requireVisible(getService().get(noteId))
      const deleted = getService().delete(noteId)
      response.json({
        requestId: request.requestId,
        data: { noteId: deleted.id, status: deleted.status },
      })
    } catch (error: unknown) {
      next(error)
    }
  })

  return router
}

function toPublicNote(note: Note | NoteWithKnowledge, includeKnowledgeItem: boolean): PublicNote {
  const knowledgeItemId = 'knowledgeItem' in note ? note.knowledgeItem?.id ?? null : null
  return {
    noteId: note.id,
    title: note.title,
    tags: note.tags,
    bodyHtml: note.bodyHtml,
    bodyText: note.bodyText,
    status: note.status,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    ...(includeKnowledgeItem ? { knowledgeItemId } : {}),
  }
}

function requireVisible(note: NoteWithKnowledge): NoteWithKnowledge {
  if (note.status === 'DELETED') throw new ApplicationError('NOTE_NOT_FOUND')
  return note
}

function hideDeletedNote(error: unknown): unknown {
  if (error instanceof ApplicationError && error.code === 'INVALID_NOTE_STATE') {
    return new ApplicationError('NOTE_NOT_FOUND')
  }
  return error
}

function readObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApplicationError('INVALID_REQUEST', { message: '请求体格式无效' })
  }
  return body as Record<string, unknown>
}

function assertFields(body: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const unexpected = Object.keys(body).filter((key) => !allowed.has(key))
  if (unexpected.length > 0) {
    throw new ApplicationError('INVALID_REQUEST', { message: '请求包含无法接受的字段' })
  }
}

function readPage(value: unknown, fallback: number, max?: number): number {
  if (value === undefined) return fallback
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) {
    throw new ApplicationError('INVALID_REQUEST', { message: '分页参数无效' })
  }
  const parsed = Number(raw)
  if (max !== undefined && parsed > max) throw new ApplicationError('INVALID_REQUEST', { message: '分页参数无效' })
  return parsed
}

function pathParam(value: string | string[] | undefined): string {
  const param = Array.isArray(value) ? value[0] : value
  if (!param) throw new ApplicationError('INVALID_REQUEST')
  return param
}
