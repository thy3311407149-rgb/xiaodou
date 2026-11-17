import type { NoteRecord, NoteTagCode } from '../api/notes.ts'
import { NOTE_TAG_CODES } from '../api/notes.ts'
import { formatRecordedAt } from '../recording/clock.ts'

export const NOTE_UI_TAGS = ['待办', '灵感', '工作'] as const
export type NoteUiTag = (typeof NOTE_UI_TAGS)[number]

const UI_BY_CODE: Record<NoteTagCode, NoteUiTag> = {
  TODO: '待办',
  IDEA: '灵感',
  WORK: '工作',
}

const CODE_BY_UI: Record<NoteUiTag, NoteTagCode> = {
  待办: 'TODO',
  灵感: 'IDEA',
  工作: 'WORK',
}

export type NoteLibraryItem = {
  id: string
  type: 'note'
  status: 'done'
  title: string
  desc: string
  time: string
  body: string
  tags: string[]
  html: string
  createdAt: string
  updatedAt: string
  persisted: true
  draft: false
  serverTags: NoteTagCode[]
  knowledgeItemId: string | null
}

const ATTACHMENT_CARRIER = /<div\b[^>]*\sdata-nc-files\s*=\s*(["'])[\s\S]*?\1[^>]*>\s*<\/div>/gi
const UNSAFE_URL_ATTRIBUTE = /\s(?:src|href)\s*=\s*(["'])(?:blob:|data:)[\s\S]*?\1/gi

export function htmlForApi(value: string): string {
  return value.replace(ATTACHMENT_CARRIER, '').replace(UNSAFE_URL_ATTRIBUTE, '')
}

export function uiTagToCode(tag: NoteUiTag): NoteTagCode {
  return CODE_BY_UI[tag]
}

export function uiTagsFromCodes(tags: readonly string[]): NoteUiTag[] {
  return NOTE_TAG_CODES.filter((code) => tags.includes(code)).map((code) => UI_BY_CODE[code])
}

export function selectedUiTags(tags: readonly string[]): NoteUiTag[] {
  return NOTE_TAG_CODES.filter((code) => tags.includes(code) || tags.includes(UI_BY_CODE[code])).map((code) => UI_BY_CODE[code])
}

export function codesFromUiTags(tags: readonly string[]): NoteTagCode[] {
  return selectedUiTags(tags).map((tag) => CODE_BY_UI[tag])
}

export function sameUiTags(left: readonly string[], right: readonly string[]): boolean {
  const first = codesFromUiTags(left)
  const second = codesFromUiTags(right)
  return first.length === second.length && first.every((tag, index) => tag === second[index])
}

export function bodyHtmlForApi(value: string): string {
  const stripped = htmlForApi(value)
  if (!stripped.trim()) return ''
  const text = stripped.replace(/<[^>]+>/g, '').replace(/\u200b/g, '').trim()
  if (text || /<img\b/i.test(stripped)) return stripped
  return ''
}

export function primaryUiTag(tags: readonly string[]): NoteUiTag {
  return uiTagsFromCodes(tags)[0] ?? NOTE_UI_TAGS.find((tag) => tags.includes(tag)) ?? '待办'
}

export function libraryItemFromNote(note: NoteRecord): NoteLibraryItem {
  const tags = uiTagsFromCodes(note.tags)
  return {
    id: note.noteId,
    type: 'note',
    status: 'done',
    title: note.title,
    desc: note.bodyText,
    time: formatRecordedAt(note.updatedAt),
    body: note.bodyText,
    tags,
    html: note.bodyHtml,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    persisted: true,
    draft: false,
    serverTags: note.tags,
    knowledgeItemId: note.knowledgeItemId,
  }
}

export function noteCreatePayload(input: { title: string; tags: readonly string[]; html: string }): { title: string; tags: NoteTagCode[]; bodyHtml: string } {
  return {
    title: input.title.trim(),
    tags: codesFromUiTags(input.tags),
    bodyHtml: bodyHtmlForApi(input.html),
  }
}

export function notePatchPayload(input: {
  title: string
  originalTitle: string
  tags: readonly string[]
  originalTags: readonly string[]
  html: string
  originalHtml: string
}): { title?: string; tags?: NoteTagCode[]; bodyHtml?: string } {
  const patch: { title?: string; tags?: NoteTagCode[]; bodyHtml?: string } = {}
  const title = input.title.trim()
  if (title !== input.originalTitle.trim()) patch.title = title
  if (!sameUiTags(input.tags, input.originalTags)) patch.tags = codesFromUiTags(input.tags)
  const bodyHtml = bodyHtmlForApi(input.html)
  if (bodyHtml !== bodyHtmlForApi(input.originalHtml)) patch.bodyHtml = bodyHtml
  return patch
}

export function isNoteDirty(input: { note: string; original: string; title?: string; originalTitle?: string; tagChanged: boolean }): boolean {
  return input.tagChanged || input.note !== input.original || (input.title ?? '').trim() !== (input.originalTitle ?? '').trim()
}

export function shouldApplyNoteList(requestEpoch: number, currentEpoch: number): boolean {
  return requestEpoch === currentEpoch
}

export function applySavedNote(input: {
  local: { title: string; html: string; tags: readonly string[] } | null
  saved: NoteRecord
  sameRevision: boolean
}): { noteId: string; knowledgeItemId: string | null; title: string; html: string; tags: string[]; overwriteContent: boolean } {
  if (!input.sameRevision && input.local) {
    return {
      noteId: input.saved.noteId,
      knowledgeItemId: input.saved.knowledgeItemId,
      title: input.local.title,
      html: input.local.html,
      tags: [...input.local.tags],
      overwriteContent: false,
    }
  }
  return {
    noteId: input.saved.noteId,
    knowledgeItemId: input.saved.knowledgeItemId,
    title: input.saved.title,
    html: input.saved.bodyHtml,
    tags: uiTagsFromCodes(input.saved.tags),
    overwriteContent: true,
  }
}

type OrderedNote = { id: string; draft?: boolean; updatedAt?: string }

export function orderNotes<T extends OrderedNote>(notes: readonly T[]): T[] {
  const drafts = notes.filter((note) => note.draft)
  const saved = notes.filter((note) => !note.draft).sort((left, right) => {
    const byTime = (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')
    return byTime || right.id.localeCompare(left.id)
  })
  return [...drafts, ...saved]
}

export function mergeNotePages<T extends OrderedNote>(
  current: readonly T[],
  incoming: readonly T[],
  page: number,
  dirtyIds: ReadonlySet<string> = new Set(),
): T[] {
  const drafts = current.filter((note) => note.draft)
  if (page > 1) {
    const saved = new Map(current.filter((note) => !note.draft).map((note) => [note.id, note]))
    for (const note of incoming) {
      if (dirtyIds.has(note.id) && saved.has(note.id)) continue
      if (!saved.has(note.id)) saved.set(note.id, note)
    }
    return orderNotes([...drafts, ...saved.values()])
  }
  const merged = incoming.map((note) => {
    if (!dirtyIds.has(note.id)) return note
    return current.find((entry) => entry.id === note.id) ?? note
  })
  const incomingIds = new Set(incoming.map((note) => note.id))
  const kept = current.filter((note) => !note.draft && !incomingIds.has(note.id) && dirtyIds.has(note.id))
  const keptDrafts = drafts.filter((note) => !incomingIds.has(note.id))
  return orderNotes([...keptDrafts, ...kept, ...merged])
}

export function upsertNote<T extends OrderedNote>(current: readonly T[], item: T): T[] {
  return orderNotes([...current.filter((note) => note.id !== item.id), item])
}

export function composeLibrary<T extends { id: string; type: string }>(
  recordings: readonly T[],
  items: readonly T[],
  notes: readonly T[],
  notesReady: boolean,
): T[] {
  const recordingIds = new Set(recordings.map((item) => item.id))
  const base = items.filter((item) => !recordingIds.has(item.id))
  if (!notesReady) return [...recordings, ...base]
  const head: T[] = []
  const tail: T[] = []
  let passedNote = false
  for (const item of base) {
    if (item.type === 'note' || item.id === 'n1') {
      passedNote = true
      continue
    }
    if (passedNote) tail.push(item)
    else head.push(item)
  }
  return [...recordings, ...head, ...notes.filter((note) => note.id !== 'n1'), ...tail]
}
