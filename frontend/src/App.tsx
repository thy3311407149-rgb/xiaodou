import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClipboardEvent, PointerEvent, ReactNode } from 'react'
import type { ChangeEvent } from 'react'
import { ApiError, REQUEST_FAILED_MESSAGE } from './api/http.ts'
import { fetchStoredFiles, uploadPdf } from './api/files.ts'
import { commitPendingNote, createNote, createSaveGate, deleteNote as deleteStoredNote, fetchNoteList, sameNoteBody, updateNote } from './api/notes.ts'
import type { NoteDraftBody, NoteTagCode, PendingNoteCreate } from './api/notes.ts'
import { fetchRecordingList } from './api/recordings.ts'
import { fetchTask } from './api/tasks.ts'
import { DocumentTextViewer } from './components/DocumentTextViewer.tsx'
import { PdfViewer } from './components/PdfViewer.tsx'
import { RecordingDetail, RecordingSheet } from './components/RecordingSheet.tsx'
import { KnowledgePanorama } from './components/KnowledgePanorama.tsx'
import { FileSummary } from './components/SummaryCard.tsx'
import { avatarLetter, nickname } from './profile/display-name.ts'
import { applySavedNote, composeLibrary, isNoteDirty, libraryItemFromNote, mergeNotePages, noteCreatePayload, notePatchPayload, sameUiTags, selectedUiTags, shouldApplyNoteList, upsertNote } from './notes/library-item.ts'
import { libraryItemFromRecording, mergeRecordingItems } from './recording/library-item.ts'
import { recordingStepText } from './recording/task-label.ts'
import type { RecordingView } from './recording/session.ts'
import { libraryItemFromStoredFile, libraryItemFromUpload, mergeStoredFiles, withTask } from './upload/library-item.ts'
import { createUploadSession } from './upload/upload-session.ts'
import './App.css'

type Tab = 'library' | 'ask' | 'files' | 'search' | 'me'
type ItemType = 'voice' | 'note' | 'doc'
type ItemStatus = 'done' | 'inbox'
type LibraryItem = {
  id: string
  type: ItemType
  status: ItemStatus
  title: string
  desc: string
  time: string
  body: string
  tags: string[]
  html?: string
  ready?: boolean
  pct?: number
  duration?: number
  createdAt?: string
  updatedAt?: string
  persisted?: boolean
  draft?: boolean
  serverTags?: readonly NoteTagCode[]
  knowledgeItemId?: string | null
  pages?: number
  fmt?: string
  upload?: {
    fileId: string
    taskId: string | null
    phase: 'processing' | 'succeeded' | 'failed'
    label: string
    detail: string | null
    progress: number | null
  }
  recording?: {
    id: string
    phase: 'processing' | 'succeeded' | 'failed'
    label: string
    detail: string | null
    progress: number | null
  }
}

const initialItems: LibraryItem[] = [
  { id: 'v1', type: 'voice', status: 'done', title: '组织行为学 · 第3讲', desc: '专家权比职位权更稳。知识外化后不依赖当场表现。', time: '今天 08:12', body: '今天讲到专家权：当你把知识外化成可检索的笔记，影响力不依赖当场表现。建议把认知负荷和组块写进第二大脑。', tags: ['组织行为学', '专家权'], duration: 186 },
  { id: 'n1', type: 'note', status: 'inbox', title: '小记', desc: '下周小组作业要用到社会认同实验。', time: '今天 08:40', body: '下周小组作业要用到社会认同实验。需要从第3讲录音里补一条证据。', tags: ['待办'] },
  { id: 'd1', type: 'doc', status: 'done', title: '认知负荷理论_Sweller.pdf', desc: '', time: '昨天', body: '', tags: ['学习科学'], ready: true, pages: 18, fmt: 'PDF' },
  { id: 'd2', type: 'doc', status: 'inbox', title: '实习周报_第4周.docx', desc: '', time: '昨天', body: '', tags: ['工作'], ready: false, pct: 55, fmt: 'Word' },
]

const NOTE_TAGS = ['待办', '灵感', '工作'] as const
type NoteTag = (typeof NOTE_TAGS)[number]
type NoteFile = { id: string; name: string; kind: 'image' | 'file'; url: string }
type OpenNote = {
  id: string
  note: string
  title: string
  tags: NoteTag[]
  original: string
  originalTags: NoteTag[]
  tagChanged: boolean
  originalTitle: string
  serverTags: readonly NoteTagCode[]
  knowledgeItemId: string | null
  persisted: boolean
}

function filesFromNote(value: string): NoteFile[] {
  if (!value) return []
  const node = new DOMParser().parseFromString(value, 'text/html').querySelector('[data-nc-files]')
  const raw = node?.getAttribute('data-nc-files')
  if (!raw) return []
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const file = item as Partial<NoteFile>
      if (typeof file.name !== 'string' || (file.kind !== 'image' && file.kind !== 'file')) return []
      return [{
        id: typeof file.id === 'string' ? file.id : `${file.kind}-${file.name}`,
        name: file.name,
        kind: file.kind,
        url: typeof file.url === 'string' ? file.url : '',
      }]
    })
  } catch {
    return []
  }
}

function editorHtmlFromNote(value: string) {
  if (!value) return ''
  const doc = new DOMParser().parseFromString(value, 'text/html')
  doc.querySelectorAll('[data-nc-files]').forEach((node) => node.remove())
  return doc.body.innerHTML
}

function packNote(html: string, files: NoteFile[]) {
  const clean = editorHtmlFromNote(html)
  if (!files.length) return clean
  const payload = encodeURIComponent(JSON.stringify(files))
  return `${clean}<div data-nc-files="${payload}"></div>`
}

function noteSeed(item: LibraryItem) {
  if (item.html) return item.html
  const holder = document.createElement('div')
  holder.textContent = item.body
  return holder.innerHTML.replace(/\n/g, '<br>')
}

function isEditorEmpty(editor: HTMLElement) {
  if (editor.querySelector('.nc-todo')) return false
  return (editor.textContent ?? '').replace(/\u200b/g, '').trim().length === 0
}

const filters = [
  ['all', '全部'],
  ['note', '笔记'],
  ['voice', '录音'],
  ['doc', '文档'],
] as const

const insightScenes = {
  discover: {
    tag: '● AI 交叉关联发现 · 刚刚',
    title: '「认知负荷」与上周录音形成互证',
    body: '你刚上传的《认知负荷》与「组织行为学录音」在“工作记忆瓶颈”上观点高度吻合。',
    cta: '查看全景',
  },
  review: {
    tag: '● 遗忘曲线提醒 · 7 天前',
    title: '重温 7 天前的思考',
    body: '你在 9月19日 记录的关于“专家权与知识外化”的随笔，最近被引用了 3 次。',
    cta: '立即重温',
  },
} as const

function formatTime(seconds: number) {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function itemMeta(item: LibraryItem) {
  if (item.type === 'doc') {
    const fmt = item.fmt ?? (/\.pdf$/i.test(item.title) ? 'PDF' : /\.docx?$/i.test(item.title) ? 'Word' : '文档')
    return [fmt, item.pages ? `${item.pages} 页` : '', item.time].filter(Boolean).join(' · ')
  }
  if (item.type === 'voice') return ['录音', item.duration != null ? formatTime(item.duration) : '', item.time].filter(Boolean).join(' · ')
  return ['笔记', item.time].filter(Boolean).join(' · ')
}

function App() {
  const fileRef = useRef<HTMLInputElement>(null)
  const sessionRef = useRef<ReturnType<typeof createUploadSession> | null>(null)
  const [tab, setTab] = useState<Tab>('library')
  const [items, setItems] = useState(initialItems)
  const [recordings, setRecordings] = useState<LibraryItem[]>([])
  const [recordingPages, setRecordingPages] = useState({ page: 0, pageSize: 20, total: 0, loading: false })
  const [recordOpen, setRecordOpen] = useState(false)
  const [recordStudio, setRecordStudio] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [note, setNote] = useState('')
  const [noteTitle, setNoteTitle] = useState('')
  const [noteTags, setNoteTags] = useState<NoteTag[]>([])
  const [serverNotes, setServerNotes] = useState<LibraryItem[]>([])
  const [notesReady, setNotesReady] = useState(false)
  const [notePages, setNotePages] = useState({ page: 0, pageSize: 20, total: 0, loading: false })
  const [editing, setEditing] = useState<OpenNote | null>(null)
  const [filter, setFilter] = useState<(typeof filters)[number][0]>('all')
  const [selected, setSelected] = useState<LibraryItem | null>(null)
  const [messages, setMessages] = useState<{ role: 'user' | 'bot'; text: string }[]>([])
  const [toast, setToast] = useState('')
  const [scene, setScene] = useState<keyof typeof insightScenes>('discover')
  const [addOpen, setAddOpen] = useState(false)
  const [citeOpen, setCiteOpen] = useState(false)
  const [cited, setCited] = useState<LibraryItem | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const noteRef = useRef(note)
  const noteTitleRef = useRef(noteTitle)
  const noteTagsRef = useRef(noteTags)
  const noteOpenRef = useRef(noteOpen)
  const editingRef = useRef(editing)
  const noteRev = useRef(0)
  const editRev = useRef(0)
  const saveGateRef = useRef(createSaveGate())
  const pendingCreateRef = useRef<PendingNoteCreate | null>(null)
  const noteEpoch = useRef(0)
  const noteFilesRef = useRef(new Map<string, NoteFile[]>())
  noteRef.current = note
  noteTitleRef.current = noteTitle
  noteTagsRef.current = noteTags
  noteOpenRef.current = noteOpen
  editingRef.current = editing

  const loadRecordings = useCallback((page: number) => {
    return fetchRecordingList(page, 20).then(
      (listed) => {
        setRecordings((current) => mergeRecordingItems(current, listed.items.map((item) => libraryItemFromRecording(item)), page))
        setRecordingPages({ page: listed.page, pageSize: listed.pageSize, total: listed.total, loading: false })
      },
      (error: unknown) => {
        setRecordingPages((current) => ({ ...current, loading: false }))
        setToast(error instanceof ApiError ? error.message : REQUEST_FAILED_MESSAGE)
      },
    )
  }, [])

  const loadNotes = useCallback((page: number, silent = false) => {
    const epoch = noteEpoch.current
    return fetchNoteList(page, 20).then(
      (listed) => {
        if (!shouldApplyNoteList(epoch, noteEpoch.current)) {
          setNotePages((current) => ({ ...current, loading: false }))
          return
        }
        const dirtyId = dirtyNoteId()
        setServerNotes((current) => mergeNotePages(current, listed.items.map((item) => libraryItemFromNote(item)), page, dirtyId ? new Set([dirtyId]) : undefined))
        setNotePages({ page: listed.page, pageSize: listed.pageSize, total: listed.total, loading: false })
        setNotesReady(true)
      },
      (error: unknown) => {
        setNotePages((current) => ({ ...current, loading: false }))
        setNotesReady(true)
        if (!silent) setToast(error instanceof ApiError ? error.message : '随笔加载失败')
      },
    )
  }, [])

  useEffect(() => {
    let active = true
    void fetchStoredFiles().then(
      (files) => {
        if (!active) return
        setItems((current) => mergeStoredFiles(current, files.map((file) => libraryItemFromStoredFile(file))))
      },
      (error: unknown) => {
        if (!active) return
        setToast(error instanceof ApiError ? error.message : REQUEST_FAILED_MESSAGE)
      },
    )
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    void loadRecordings(1)
  }, [loadRecordings])

  useEffect(() => {
    void loadNotes(1)
  }, [loadNotes])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 1800)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const session = createUploadSession({
      upload: uploadPdf,
      getTask: fetchTask,
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (id) => window.clearTimeout(id),
      listener: {
        onRejected: (message) => setToast(message),
        onUploadFailed: (message) => setToast(message),
        onAccepted: (uploaded) => {
          setItems((current) => [libraryItemFromUpload(uploaded), ...current.filter((item) => item.id !== uploaded.fileId)])
          setTab('library')
          setAddOpen(false)
        },
        onTask: (task) => {
          setItems((current) => current.map((item) => item.upload?.taskId === task.id ? withTask(item, task) : item))
        },
        onPollFailed: (message, taskId) => {
          setToast(message)
          setItems((current) => current.map((item) => item.upload?.taskId === taskId
            ? { ...item, desc: message, upload: { ...item.upload, phase: 'failed', label: '失败', detail: message } }
            : item))
        },
      },
    })
    sessionRef.current = session
    return () => {
      session.dispose()
      sessionRef.current = null
    }
  }, [])

  const libraryItems = useMemo(
    () => composeLibrary(recordings, items, serverNotes, notesReady),
    [items, notesReady, recordings, serverNotes],
  )
  const filteredItems = useMemo(() => libraryItems.filter((item) => filter === 'all' || item.type === filter), [filter, libraryItems])
  const searchHits = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return []
    return libraryItems.filter((item) => `${item.title}${item.desc}${item.body}${item.tags.join('')}`.toLowerCase().includes(query))
  }, [libraryItems, searchQuery])
  const mainTab = tab === 'library' || tab === 'ask' || tab === 'files' ? tab : null
  const letter = avatarLetter(nickname)
  const hasMoreRecordings = recordingPages.page > 0 && recordingPages.page * recordingPages.pageSize < recordingPages.total
  const hasMoreNotes = notePages.page > 0 && notePages.page * notePages.pageSize < notePages.total
  const brief = insightScenes[scene]

  function dirtyNoteId() {
    const current = editingRef.current
    if (!current?.persisted || !isNoteDirty({ note: current.note, original: current.original, title: current.title, originalTitle: current.originalTitle, tagChanged: current.tagChanged })) return null
    return current.id
  }

  const noteIsDirty = () => {
    const current = editingRef.current
    if (current) return isNoteDirty({ note: current.note, original: current.original, title: current.title, originalTitle: current.originalTitle, tagChanged: current.tagChanged })
    if (!noteOpenRef.current) return false
    return isNoteDirty({ note: noteRef.current, original: '', title: noteTitleRef.current, originalTitle: '', tagChanged: noteTagsRef.current.length > 0 })
  }

  const rememberNoteFiles = (id: string, files: NoteFile[]) => {
    noteFilesRef.current.set(id, files)
  }

  const releaseNoteFiles = (html: string, kept: ReadonlySet<string>) => {
    filesFromNote(html).forEach((file) => {
      if (file.url.startsWith('blob:') && !kept.has(file.url)) URL.revokeObjectURL(file.url)
    })
  }

  const finishSavedNote = (saved: ReturnType<typeof libraryItemFromNote>, files: NoteFile[], sameRevision: boolean, localHtml: string) => {
    const applied = applySavedNote({
      local: sameRevision ? null : { title: saved.title, html: localHtml, tags: saved.tags },
      saved: {
        noteId: saved.id,
        title: saved.title,
        tags: saved.serverTags,
        bodyHtml: saved.html,
        bodyText: saved.body,
        status: 'CREATED',
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
        knowledgeItemId: saved.knowledgeItemId,
      },
      sameRevision,
    })
    noteEpoch.current += 1
    setServerNotes((current) => upsertNote(current, saved))
    setNotesReady(true)
    rememberNoteFiles(saved.id, files)
    if (notePages.page <= 1) void loadNotes(1, true)
    return applied
  }

  function readLatestBody(): NoteDraftBody {
    const currentEditing = editingRef.current
    return noteCreatePayload({
      title: currentEditing ? currentEditing.title : noteTitleRef.current,
      tags: currentEditing ? currentEditing.tags : noteTagsRef.current,
      html: currentEditing ? currentEditing.note : noteRef.current,
    })
  }

  function ensurePending(): PendingNoteCreate {
    if (!pendingCreateRef.current) {
      pendingCreateRef.current = { idempotencyKey: crypto.randomUUID(), snapshot: null, noteId: null, created: null }
    }
    return pendingCreateRef.current
  }

  const clearComposer = () => {
    noteRef.current = ''
    setNote('')
    noteTitleRef.current = ''
    setNoteTitle('')
    noteTagsRef.current = []
    setNoteTags([])
    noteOpenRef.current = false
    setNoteOpen(false)
  }

  const keepRecoveredDraft = (fallbackHtml: string) => {
    const pending = pendingCreateRef.current
    if (!pending?.noteId || !pending.snapshot) return
    const latestHtml = (editingRef.current?.note ?? noteRef.current) || fallbackHtml
    const tags = editingRef.current?.tags ?? noteTagsRef.current
    const title = editingRef.current?.title ?? noteTitleRef.current
    const files = filesFromNote(latestHtml)
    const snapshotTags = selectedUiTags(pending.snapshot.tags)
    const next: OpenNote = {
      id: pending.noteId,
      note: latestHtml,
      title,
      tags: [...tags],
      original: packNote(pending.snapshot.bodyHtml, files),
      originalTags: snapshotTags,
      tagChanged: !sameUiTags(tags, snapshotTags),
      originalTitle: pending.snapshot.title,
      serverTags: pending.snapshot.tags,
      knowledgeItemId: pending.created?.knowledgeItemId ?? null,
      persisted: true,
    }
    editRev.current = 1
    editingRef.current = next
    setEditing(next)
    clearComposer()
    const created = pending.created
    if (created) {
      noteEpoch.current += 1
      setServerNotes((current) => upsertNote(current, libraryItemFromNote(created)))
      setNotesReady(true)
      rememberNoteFiles(pending.noteId, files)
    }
  }

  const saveNote = () => {
    if (saveGateRef.current.isSaving()) return
    const currentEditing = editingRef.current
    const draft = currentEditing ? currentEditing.note : noteRef.current
    const title = (currentEditing ? currentEditing.title : noteTitleRef.current).trim()
    if (!title) { setToast('先填写标题'); return }
    const files = filesFromNote(draft)
    if (currentEditing?.persisted) {
      const patch = notePatchPayload({
        title: currentEditing.title,
        originalTitle: currentEditing.originalTitle,
        tags: currentEditing.tags,
        originalTags: currentEditing.originalTags,
        html: draft,
        originalHtml: currentEditing.original,
      })
      const revision = editRev.current
      const id = currentEditing.id
      if (Object.keys(patch).length === 0) {
        releaseNoteFiles(currentEditing.original, new Set(files.map((file) => file.url)))
        rememberNoteFiles(id, files)
        if (pendingCreateRef.current?.noteId === id) pendingCreateRef.current = null
        editingRef.current = null
        setEditing(null)
        setToast('已更新')
        return
      }
      const ticket = saveGateRef.current.begin()
      if (ticket == null) return
      void updateNote(id, patch).then(
        (saved) => {
          if (!saveGateRef.current.end(ticket)) return
          if (pendingCreateRef.current?.noteId === id) pendingCreateRef.current = null
          const item = libraryItemFromNote(saved)
          const same = editRev.current === revision
          const latestHtml = editingRef.current?.note ?? draft
          releaseNoteFiles(currentEditing.original, new Set(filesFromNote(latestHtml).map((file) => file.url)))
          finishSavedNote(item, filesFromNote(latestHtml), same, latestHtml)
          if (!same) {
            setToast('已更新')
            return
          }
          editingRef.current = null
          setEditing(null)
          setToast('已更新')
        },
        (error: unknown) => {
          if (!saveGateRef.current.end(ticket)) return
          setToast(error instanceof ApiError ? error.message : REQUEST_FAILED_MESSAGE)
        },
      )
      return
    }
    const ticket = saveGateRef.current.begin()
    if (ticket == null) return
    const pending = ensurePending()
    void commitPendingNote({
      pending,
      readLatest: readLatestBody,
      post: (snapshot, key) => createNote({ idempotencyKey: key, title: snapshot.title, tags: snapshot.tags, bodyHtml: snapshot.bodyHtml }),
      patch: (noteId, body) => updateNote(noteId, body),
    }).then(
      (result) => {
        if (!saveGateRef.current.end(ticket)) return
        const latestHtml = editingRef.current?.note ?? noteRef.current
        const latest = readLatestBody()
        const same = sameNoteBody(latest, result.sent)
        const latestFiles = filesFromNote(latestHtml)
        const item = libraryItemFromNote(result.note)
        if (!same) {
          const nextTags = editingRef.current?.tags ?? noteTagsRef.current
          const sentTags = selectedUiTags(result.sent.tags)
          const next: OpenNote = {
            id: result.note.noteId,
            note: latestHtml,
            title: editingRef.current?.title ?? noteTitleRef.current,
            tags: [...nextTags],
            original: packNote(result.sent.bodyHtml, latestFiles),
            originalTags: sentTags,
            tagChanged: !sameUiTags(nextTags, sentTags),
            originalTitle: result.sent.title,
            serverTags: result.sent.tags,
            knowledgeItemId: result.note.knowledgeItemId,
            persisted: true,
          }
          editRev.current = 1
          editingRef.current = next
          setEditing(next)
        } else {
          editingRef.current = null
          setEditing(null)
          setAddOpen(false)
          setTab('library')
        }
        pendingCreateRef.current = null
        clearComposer()
        finishSavedNote(item, latestFiles, same, latestHtml)
        setToast('已保存')
      },
      (error: unknown) => {
        if (!saveGateRef.current.end(ticket)) return
        if (pending.noteId) keepRecoveredDraft(draft)
        setToast(error instanceof ApiError ? error.message : REQUEST_FAILED_MESSAGE)
      },
    )
  }

  const openSavedNote = (item: LibraryItem) => {
    if (editingRef.current?.id === item.id) return
    if (noteIsDirty()) { setToast('先保存当前随笔'); return }
    if (editingRef.current) cancelEdit()
    const files = noteFilesRef.current.get(item.id) ?? []
    const base = item.html ? editorHtmlFromNote(item.html) : noteSeed(item)
    const seed = packNote(base, files)
    const tags = selectedUiTags(item.serverTags ?? item.tags)
    const next: OpenNote = {
      id: item.id,
      note: seed,
      title: item.title,
      tags,
      original: seed,
      originalTags: tags,
      tagChanged: false,
      originalTitle: item.title,
      serverTags: item.serverTags ?? [],
      knowledgeItemId: item.knowledgeItemId ?? null,
      persisted: item.persisted === true,
    }
    editRev.current = 0
    editingRef.current = next
    noteOpenRef.current = false
    setNoteOpen(false)
    setEditing(next)
  }

  const openNewNote = () => {
    if (noteIsDirty()) { setToast('先保存当前随笔'); return }
    if (editingRef.current) cancelEdit()
    setAddOpen(false)
    noteOpenRef.current = true
    setNoteOpen(true)
  }

  const openItem = (item: LibraryItem) => {
    if (item.type !== 'note') { setSelected(item); return }
    openSavedNote(item)
  }

  const cancelEdit = () => {
    const current = editingRef.current
    if (!current) return
    const kept = new Set(filesFromNote(current.original).map((file) => file.url))
    filesFromNote(current.note).forEach((file) => {
      if (file.url.startsWith('blob:') && !kept.has(file.url)) URL.revokeObjectURL(file.url)
    })
    if (pendingCreateRef.current?.noteId === current.id) pendingCreateRef.current = null
    editingRef.current = null
    setEditing(null)
  }

  const removeNoteLocally = (item: LibraryItem) => {
    const urls = new Set<string>()
    const collect = (html: string) => {
      filesFromNote(html).forEach((file) => {
        if (file.url.startsWith('blob:')) urls.add(file.url)
      })
    }
    collect(item.html ?? '')
    const current = editingRef.current
    if (current?.id === item.id) collect(current.note)
    urls.forEach((url) => URL.revokeObjectURL(url))
    noteFilesRef.current.delete(item.id)
    if (current?.id === item.id) {
      editingRef.current = null
      setEditing(null)
    }
    if (cited?.id === item.id) setCited(null)
    if (selected?.id === item.id) setSelected(null)
    noteEpoch.current += 1
    setServerNotes((notes) => notes.filter((entry) => entry.id !== item.id))
    setItems((entries) => entries.filter((entry) => entry.id !== item.id))
    setToast('已删除')
  }

  const deleteNote = (item: LibraryItem) => {
    if (item.type !== 'note' || saveGateRef.current.isSaving()) return
    if (item.persisted !== true) {
      removeNoteLocally(item)
      return
    }
    void deleteStoredNote(item.id).then(
      () => removeNoteLocally(item),
      (error: unknown) => {
        if (error instanceof ApiError && (error.status === 404 || error.code === 'NOTE_NOT_FOUND')) {
          removeNoteLocally(item)
          return
        }
        setToast(error instanceof ApiError ? error.message : '删除失败')
      },
    )
  }

  const startRecording = () => {
    setTab('library')
    setRecordOpen(true)
    setAddOpen(false)
  }

  const rememberRecording = useCallback((view: RecordingView) => {
    const recording = view.recording
    if (!recording) return
    const phase = view.phase === 'done' || view.task?.status === 'SUCCEEDED'
      ? 'succeeded'
      : view.phase === 'failed' || view.task?.status === 'FAILED'
        ? 'failed'
        : 'processing'
    const transcript = view.segments.map((segment) => segment.content).filter((content) => content.length > 0).join('\n')
    const detail = view.message ?? (phase === 'failed' ? '转写和 AI 处理暂不可用' : view.task ? recordingStepText(view.task.currentStep) : null)
    const item: LibraryItem = {
      id: recording.id,
      type: 'voice',
      status: phase === 'succeeded' ? 'done' : 'inbox',
      title: recording.title,
      desc: transcript.slice(0, 34) || (view.audioSaved ? '音频已保存' : ''),
      time: '刚刚',
      body: transcript,
      tags: [],
      duration: view.startedAtMs == null ? undefined : Math.max(0, Math.floor((Date.now() - view.startedAtMs) / 1000)),
      createdAt: recording.createdAt,
      recording: {
        id: recording.id,
        phase,
        label: phase === 'succeeded' ? '处理完成' : phase === 'failed' ? '失败' : '处理中',
        detail,
        progress: view.task?.progress ?? null,
      },
    }
    setRecordings((current) => mergeRecordingItems(current, [item], 1))
  }, [])

  const addFile = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0]
    if (!selected) return
    const name = selected.name
    const type = selected.type
    const lastModified = selected.lastModified
    void selected.arrayBuffer().then((bytes) => {
      event.target.value = ''
      const file = new File([bytes], name, { type, lastModified })
      return sessionRef.current?.submit(file)
    })
  }

  const ask = (text: string) => {
    const question = text.trim()
    if (!question) return
    const source = cited ? cited.title : question.includes('总结') ? '组织行为学 · 第3讲' : '认知负荷理论_Sweller.pdf'
    const answer = question.includes('总结')
      ? `今天第3讲核心：专家权 + 知识外化。把认知写成可检索笔记，影响力就不依赖当场表现。\n来源 · ${source}`
      : `有关。Sweller 讲外部存储能降低内在负荷；你第3讲录音把「知识外化」和专家权连在一起，可以互相引用。\n来源 · ${source}`
    setMessages((current) => [...current, { role: 'user', text: question }, { role: 'bot', text: answer }])
    setCited(null)
  }

  const openBriefAction = () => {
    if (scene === 'discover') {
      setTab('files')
      return
    }
    const noteItem = libraryItems.find((item) => item.type === 'note' && item.persisted === true && item.id !== 'n1')
    if (noteItem) openItem(noteItem)
    else setToast('暂无可重温的笔记')
  }

  return (
    <div className={`app tab-${tab}${recordStudio ? ' voice-open' : ''}${selected?.recording ? ' detail-voice' : ''}`}>
      <header className="showcase">
        <div className="showcase-top">
          <h1>
            {tab === 'library' && <>Hi, {nickname}<span className="live-dot" aria-hidden="true" /></>}
            {tab === 'ask' && '问小豆'}
            {tab === 'files' && '文件库'}
            {tab === 'search' && '搜索'}
            {tab === 'me' && nickname}
          </h1>
          <button className="avatar-btn" type="button" aria-label="我的页面" onClick={() => setTab('me')}>
            <span className="avatar-face">{letter}</span>
          </button>
        </div>
      </header>
      {tab === 'search' && (
        <div className="search-bar">
          <SearchIcon />
          <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} type="search" placeholder="搜索笔记、录音、文档要点" aria-label="搜索笔记、录音、文档要点" />
        </div>
      )}
      <main className="pages">
        {tab === 'library' && (
          <section className="page with-dock">
            <div className="insight-card" onClick={() => setScene((current) => current === 'discover' ? 'review' : 'discover')}>
              <span className="insight-tag">{brief.tag}</span>
              <span className="insight-title">{brief.title}</span>
              <span className="insight-body">{brief.body}</span>
              <span className="insight-foot">
                <span className="insight-dots">
                  {(Object.keys(insightScenes) as Array<keyof typeof insightScenes>).map((key) => (
                    <button className={`insight-dot ${scene === key ? 'on' : ''}`} key={key} type="button" aria-label={key === 'discover' ? '新关联发现' : '温故反刍'} onClick={(event) => { event.stopPropagation(); setScene(key) }} />
                  ))}
                </span>
                <button className="insight-cta" type="button" onClick={(event) => { event.stopPropagation(); openBriefAction() }}>{brief.cta} →</button>
              </span>
            </div>
            <div className="filter-row">
              {filters.map(([value, label]) => (
                <button className={`chip ${filter === value ? 'on' : ''}`} key={value} type="button" onClick={() => setFilter(value)}>{label}</button>
              ))}
            </div>
            <div className="lib-list">
              {filteredItems.length === 0 && <div className="empty">没有符合筛选的内容</div>}
              {filteredItems.map((item) => <ItemRow item={item} key={item.id} onSelect={openItem} onDelete={deleteNote} />)}
              {((filter === 'all' || filter === 'voice') && hasMoreRecordings || (filter === 'all' || filter === 'note') && hasMoreNotes) && (
                <div className="chips">
                  <button className="chip" type="button" disabled={recordingPages.loading || notePages.loading} onClick={() => {
                    if ((filter === 'all' || filter === 'voice') && hasMoreRecordings) {
                      setRecordingPages((current) => ({ ...current, loading: true }))
                      void loadRecordings(recordingPages.page + 1)
                    }
                    if ((filter === 'all' || filter === 'note') && hasMoreNotes) {
                      setNotePages((current) => ({ ...current, loading: true }))
                      void loadNotes(notePages.page + 1)
                    }
                  }}>
                    {recordingPages.loading || notePages.loading ? '正在加载' : '加载更多'}
                  </button>
                </div>
              )}
            </div>
          </section>
        )}
        {tab === 'ask' && (
          <AskPage
            messages={messages}
            cited={cited}
            citeOpen={citeOpen}
            onAsk={ask}
            onToggleCite={() => setCiteOpen((open) => !open)}
            onCite={(item) => { setCited(item); setCiteOpen(false) }}
            onClearCite={() => setCited(null)}
            onLimited={() => setToast('本版仅支持文字提问')}
            items={libraryItems}
          />
        )}
        {tab === 'search' && (
          <section className="page">
            {searchQuery.trim() ? (
              <div className="lib-list">
                {searchHits.length === 0 && <div className="empty">没有找到相关内容</div>}
                {searchHits.map((item) => <ItemRow item={item} key={item.id} onSelect={openItem} onDelete={deleteNote} />)}
              </div>
            ) : <div className="empty">输入关键词，同时搜笔记、转写和文档要点</div>}
          </section>
        )}
        {tab === 'me' && (
          <MePage
            nickname={nickname}
            letter={letter}
            nodes={libraryItems.length}
            docs={libraryItems.filter((item) => item.type === 'doc').length}
            notes={libraryItems.filter((item) => item.type !== 'doc').length}
            onMenu={(message) => setToast(message)}
          />
        )}
        {tab === 'files' && (
          <>
            <KnowledgePanorama onSource={setToast} />
            <div className="files-add">
              <button className="files-add-btn" type="button" onClick={() => setAddOpen((open) => !open)}>+ 添加知识</button>
              {addOpen && (
                <div className="add-menu" role="menu" aria-label="添加知识">
                  <button type="button" onClick={startRecording}>录音</button>
                  <button type="button" onClick={openNewNote}>随笔</button>
                  <button type="button" onClick={() => { setAddOpen(false); fileRef.current?.click() }}>文件解析</button>
                </div>
              )}
            </div>
          </>
        )}
      </main>
      {tab === 'library' && !selected && !noteOpen && !editing && !recordOpen && (
        <div className="capture-dock" aria-label="即刻捕捉">
          <button className="dock-input" type="button" aria-label="闪念笔记" onClick={openNewNote}>
            <PenIcon />
            <span>写下闪念，或开始录音...</span>
          </button>
          <div className="dock-actions">
            <button className="dock-btn dock-mic" type="button" aria-label="语音速记" onClick={startRecording}><MicIcon /></button>
            <button className="dock-btn" type="button" aria-label="解析文档" onClick={() => fileRef.current?.click()}><ClipIcon /></button>
          </div>
        </div>
      )}
      <nav className="tabbar" aria-label="底部导航">
        <div className="tabbar-dock">
          <div className="tabbar-pill" role="tablist">
            <span className={`tab-indicator ${mainTab ?? 'idle'}`} aria-hidden="true" />
            <TabButton active={tab === 'library'} label="知识库" onClick={() => setTab('library')}><BookIcon /></TabButton>
            <TabButton active={tab === 'ask'} label="问小豆" onClick={() => setTab('ask')}><AskIcon /></TabButton>
            <TabButton active={tab === 'files'} label="文件库" onClick={() => setTab('files')}><GlobeIcon /></TabButton>
          </div>
          <button className={`tabbar-search ${tab === 'search' ? 'is-on' : ''}`} type="button" aria-label="搜索" onClick={() => setTab((current) => current === 'search' ? 'library' : 'search')}>
            <SearchIcon />
          </button>
        </div>
      </nav>
      <input ref={fileRef} type="file" accept=".pdf,application/pdf" hidden onChange={addFile} />
      {editing ? (
        <NoteSheet
          key={editing.id}
          note={editing.note}
          title={editing.title}
          tags={editing.tags}
          pinnedUrls={filesFromNote(editing.original).map((file) => file.url)}
          onChange={(value) => {
            editRev.current += 1
            setEditing((current) => {
              if (!current) return current
              const next = { ...current, note: value }
              editingRef.current = next
              return next
            })
          }}
          onTitle={(title) => {
            editRev.current += 1
            setEditing((current) => {
              if (!current) return current
              const next = { ...current, title }
              editingRef.current = next
              return next
            })
          }}
          onTags={(tags) => {
            editRev.current += 1
            setEditing((current) => {
              if (!current) return current
              const next = { ...current, tags, tagChanged: !sameUiTags(tags, current.originalTags) }
              editingRef.current = next
              return next
            })
          }}
          onClose={cancelEdit}
          onSave={saveNote}
        />
      ) : noteOpen && <NoteSheet key="new" note={note} title={noteTitle} tags={noteTags} onChange={(value) => { noteRev.current += 1; noteRef.current = value; setNote(value) }} onTitle={(value) => { noteRev.current += 1; noteTitleRef.current = value; setNoteTitle(value) }} onTags={(tags) => { noteRev.current += 1; noteTagsRef.current = tags; setNoteTags(tags) }} onClose={() => { noteOpenRef.current = false; setNoteOpen(false) }} onSave={saveNote} />}
      {recordOpen && (
        <RecordingSheet
          onClose={() => { setRecordOpen(false); setRecordStudio(false) }}
          onStudio={setRecordStudio}
          onUpdate={rememberRecording}
        />
      )}
      {selected && <DetailSheet item={selected} onClose={() => setSelected(null)} onToast={setToast} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function TabButton({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button className={`tab ${active ? 'on' : ''}`} type="button" role="tab" aria-selected={active} onClick={onClick}>
      {children}
      <span className="tab-label">{label}</span>
    </button>
  )
}

function ItemBody({ item }: { item: LibraryItem }) {
  const upload = item.upload
  const recording = item.recording
  const badge = upload ?? recording
  const processing = badge ? badge.phase === 'processing' : item.type === 'doc' && item.ready === false
  const progress = badge ? badge.progress : item.pct ?? 40
  return (
    <>
      <span className="item-type-ico" aria-hidden="true">{item.type === 'voice' ? <MicIcon /> : item.type === 'note' ? <PenIcon /> : <DocIcon />}</span>
      <span className="item-copy">
        <h4>
          {item.title}
          {badge && <span className={`micro-tag ${badge.phase === 'succeeded' ? 'ok' : badge.phase === 'failed' ? 'bad' : 'run'}`}>{badge.label}</span>}
          {!badge && processing && <span className="micro-tag run">解析中</span>}
          {!badge && item.type === 'doc' && item.ready !== false && <span className="micro-tag ok">已拆解</span>}
          {!badge && item.type !== 'doc' && item.type !== 'note' && item.status === 'inbox' && <span className="micro-tag">待处理</span>}
        </h4>
        <p className="point">{itemMeta(item)}</p>
        {badge?.detail && <span className="upload-detail">{badge.detail}</span>}
        {processing && progress != null && (
          <span className="progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${progress}%` }} />
          </span>
        )}
      </span>
    </>
  )
}

const NOTE_SWIPE_DELETE = 76
const NOTE_SWIPE_CONFIRM = 118

function ItemRow({ item, onSelect, onDelete }: { item: LibraryItem; onSelect: (item: LibraryItem) => void; onDelete?: (item: LibraryItem) => void }) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ x: number; y: number; origin: number; moved: boolean; id: number } | null>(null)
  const offsetRef = useRef(0)
  const suppressClick = useRef(false)

  if (item.type !== 'note' || !onDelete) {
    return (
      <button className="item" type="button" onClick={() => onSelect(item)}>
        <ItemBody item={item} />
      </button>
    )
  }

  const slide = (value: number) => {
    offsetRef.current = value
    setOffset(value)
  }

  const close = () => {
    setOpen(false)
    setConfirming(false)
    slide(0)
  }

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    suppressClick.current = false
    drag.current = { x: event.clientX, y: event.clientY, origin: offsetRef.current, moved: false, id: event.pointerId }
  }

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const state = drag.current
    if (!state || state.id !== event.pointerId) return
    const dx = event.clientX - state.x
    const dy = event.clientY - state.y
    if (!state.moved) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      if (Math.abs(dy) > Math.abs(dx)) {
        drag.current = null
        return
      }
      state.moved = true
      setDragging(true)
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // The pointer can already be gone when the gesture ends mid-move.
      }
    }
    const limit = confirming ? NOTE_SWIPE_CONFIRM : NOTE_SWIPE_DELETE
    slide(Math.min(0, Math.max(-limit - 28, state.origin + dx)))
  }

  const finishDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const state = drag.current
    if (!state || state.id !== event.pointerId) return
    drag.current = null
    setDragging(false)
    if (!state.moved) return
    suppressClick.current = true
    const shouldOpen = offsetRef.current < -NOTE_SWIPE_DELETE / 2
    setOpen(shouldOpen)
    setConfirming(false)
    slide(shouldOpen ? -NOTE_SWIPE_DELETE : 0)
  }

  return (
    <div className={`item-swipe${dragging ? ' is-dragging' : ''}`}>
      <button
        className={`item-delete${confirming ? ' is-confirm' : ''}`}
        type="button"
        tabIndex={open ? 0 : -1}
        aria-hidden={!open}
        onClick={() => {
          if (!confirming) {
            setConfirming(true)
            setOpen(true)
            slide(-NOTE_SWIPE_CONFIRM)
            return
          }
          onDelete(item)
        }}
      >
        {confirming ? '确认删除' : '删除'}
      </button>
      <button
        className="item"
        type="button"
        style={{ transform: `translateX(${offset}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false
            return
          }
          if (open || confirming) {
            close()
            return
          }
          onSelect(item)
        }}
      >
        <ItemBody item={item} />
      </button>
    </div>
  )
}

function AskPage({ messages, cited, citeOpen, items, onAsk, onToggleCite, onCite, onClearCite, onLimited }: {
  messages: { role: 'user' | 'bot'; text: string }[]
  cited: LibraryItem | null
  citeOpen: boolean
  items: LibraryItem[]
  onAsk: (text: string) => void
  onToggleCite: () => void
  onCite: (item: LibraryItem) => void
  onClearCite: () => void
  onLimited: () => void
}) {
  const [input, setInput] = useState('')
  const send = (text = input) => { onAsk(text); setInput('') }
  return (
    <section className="page ask-page">
      <div className="chat">
        {!messages.length && (
          <>
            <div className="ask-greet"><h2>Hi, {nickname}</h2><p>我是小豆，聊天、写作、搜索都在行，助你灵感无限</p></div>
            <div className="suggests">
              {['认知负荷和我的录音有什么关系？', '帮我列小组作业要用的三点', '总结今天的课堂录音'].map((suggestion) => (
                <button className="chip" type="button" key={suggestion} onClick={() => send(suggestion)}>{suggestion}</button>
              ))}
            </div>
          </>
        )}
        {messages.map((message, index) => <Bubble key={`${message.role}-${index}`} role={message.role} text={message.text} />)}
      </div>
      {cited && <button className="cite-chip" type="button" onClick={onClearCite}>引用 · {cited.title}</button>}
      <div className="composer">
        <div className="input-pill">
          <button className="cam-btn" type="button" aria-label="拍照" onClick={onLimited}><CamIcon /></button>
          <input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && send()} placeholder="发消息或按住说话…" />
          <div className="icon-tools">
            <button type="button" aria-label="语音" onClick={onLimited}><MicIcon /></button>
            <button type="button" aria-label="引用知识库" aria-expanded={citeOpen} onClick={onToggleCite}><MoreIcon /></button>
          </div>
        </div>
        <button className="send-btn" type="button" aria-label="发送" onClick={() => send()}><SendIcon /></button>
      </div>
      {citeOpen && (
        <div className="cite-menu" role="menu" aria-label="选择知识库内容">
          {items.slice(0, 4).map((item) => (
            <button type="button" key={item.id} role="menuitem" onClick={() => onCite(item)}>{item.type === 'voice' ? '录音' : item.type === 'note' ? '随笔' : '文件解析'} · {item.title}</button>
          ))}
        </div>
      )}
    </section>
  )
}

function Bubble({ role, text }: { role: 'user' | 'bot'; text: string }) {
  const [body, source] = text.split('\n来源 · ')
  return (
    <div className={`bubble ${role}`}>
      {body}
      {source && <span className="src">来源 · {source}</span>}
    </div>
  )
}

type NoteEditorApi = {
  publish: () => void
  applyHighlight: () => void
  toggleTodo: (target: EventTarget | null) => boolean
  paste: (event: ClipboardEvent<HTMLDivElement>) => void
}

const NoteEditor = memo(function NoteEditor({
  seedHtml,
  initiallyEmpty,
  editorRef,
  api,
}: {
  seedHtml: string
  initiallyEmpty: boolean
  editorRef: { current: HTMLDivElement | null }
  api: { current: NoteEditorApi }
}) {
  const html = useRef({ __html: seedHtml })
  return (
    <div
      ref={(node) => { editorRef.current = node }}
      className={`nc-editor${initiallyEmpty ? ' is-empty' : ''}`}
      contentEditable
      role="textbox"
      aria-multiline="true"
      aria-label="笔记正文"
      data-placeholder="记录这一刻的顿悟、课堂要点或火花..."
      suppressContentEditableWarning
      dangerouslySetInnerHTML={html.current}
      onInput={() => api.current.publish()}
      onMouseDown={(event) => { if (api.current.toggleTodo(event.target)) event.preventDefault() }}
      onMouseUp={() => api.current.applyHighlight()}
      onKeyUp={(event) => { if (!event.nativeEvent.isComposing) api.current.applyHighlight() }}
      onPaste={(event) => api.current.paste(event)}
    />
  )
}, () => true)

function NoteSheet({ note, title, tags, pinnedUrls = [], onChange, onTitle, onTags, onClose, onSave }: {
  note: string
  title: string
  tags: readonly NoteTag[]
  pinnedUrls?: readonly string[]
  onChange: (value: string) => void
  onTitle: (value: string) => void
  onTags: (value: NoteTag[]) => void
  onClose: () => void
  onSave: () => void
}) {
  const editorRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const api = useRef<NoteEditorApi>({
    publish: () => {},
    applyHighlight: () => {},
    toggleTodo: () => false,
    paste: () => {},
  })
  const seedHtml = useRef(editorHtmlFromNote(note))
  const initiallyEmpty = useRef((() => {
    const holder = document.createElement('div')
    holder.innerHTML = seedHtml.current
    return isEditorEmpty(holder)
  })())
  const [attachOpen, setAttachOpen] = useState(false)
  const [highlightOn, setHighlightOn] = useState(false)
  const highlightRef = useRef(false)
  const attachments = filesFromNote(note)
  const selectedTags = new Set(tags)
  const toggleTag = (tag: NoteTag) => {
    onTags(NOTE_TAGS.filter((item) => (item === tag ? !selectedTags.has(item) : selectedTags.has(item))))
  }

  const publish = (files?: NoteFile[]) => {
    const editor = editorRef.current
    if (!editor) return
    editor.classList.toggle('is-empty', isEditorEmpty(editor))
    onChange(packNote(editor.innerHTML, files ?? filesFromNote(note)))
  }

  const applyHighlight = (force = false) => {
    if (!force && !highlightRef.current) return
    const editor = editorRef.current
    const selection = window.getSelection()
    if (!editor || !selection || selection.isCollapsed || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    if (!editor.contains(range.commonAncestorContainer) || !range.toString().replace(/\u200b/g, '').trim()) return
    if (range.cloneContents().querySelector('[data-todo-box]')) return
    const mark = document.createElement('mark')
    mark.className = 'nc-hl'
    try {
      range.surroundContents(mark)
    } catch {
      const fragment = range.extractContents()
      mark.appendChild(fragment)
      range.insertNode(mark)
    }
    selection.removeAllRanges()
    publish()
  }

  const insertTodo = () => {
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    const todo = document.createElement('div')
    todo.className = 'nc-todo'
    todo.dataset.done = 'false'
    const box = document.createElement('span')
    box.className = 'nc-box'
    box.dataset.todoBox = '1'
    box.contentEditable = 'false'
    box.setAttribute('role', 'checkbox')
    box.setAttribute('aria-checked', 'false')
    box.setAttribute('aria-label', '待办完成')
    const label = document.createElement('span')
    label.className = 'nc-todo-label'
    label.textContent = '\u200b'
    todo.append(box, label)
    const selection = window.getSelection()
    if (isEditorEmpty(editor)) {
      editor.replaceChildren(todo)
    } else if (selection && selection.rangeCount > 0 && editor.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0)
      range.collapse(false)
      const host = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
      const currentTodo = host?.closest('.nc-todo')
      if (currentTodo && editor.contains(currentTodo)) currentTodo.after(todo)
      else range.insertNode(todo)
    } else {
      editor.appendChild(todo)
    }
    const caret = document.createRange()
    caret.selectNodeContents(label)
    caret.collapse(false)
    selection?.removeAllRanges()
    selection?.addRange(caret)
    publish()
  }

  const toggleTodo = (target: EventTarget | null) => {
    const element = target instanceof Element ? target : null
    const box = element?.closest('[data-todo-box]')
    const line = box?.closest('.nc-todo')
    if (!box || !line) return false
    const done = line.getAttribute('data-done') !== 'true'
    line.setAttribute('data-done', done ? 'true' : 'false')
    box.setAttribute('aria-checked', done ? 'true' : 'false')
    publish()
    return true
  }

  const addAttachments = (list: FileList | null, source: 'image' | 'file') => {
    if (!list?.length) return
    const next = [...filesFromNote(note)]
    Array.from(list).forEach((file) => {
      const image = file.type.startsWith('image/')
      next.push({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name || (source === 'image' ? '图片' : '文件'),
        kind: image ? 'image' : 'file',
        url: image ? URL.createObjectURL(file) : '',
      })
    })
    publish(next)
    setAttachOpen(false)
  }

  const removeAttachment = (id: string) => {
    const current = filesFromNote(note)
    const target = current.find((file) => file.id === id)
    if (!target) return
    const next = current.filter((file) => file.id !== id)
    publish(next)
    if (!editorRef.current) return
    if (target.url.startsWith('blob:') && !pinnedUrls.includes(target.url) && !next.some((file) => file.url === target.url)) {
      URL.revokeObjectURL(target.url)
    }
  }

  const paste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault()
    const text = event.clipboardData.getData('text/plain')
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    range.deleteContents()
    const node = document.createTextNode(text)
    range.insertNode(node)
    range.setStartAfter(node)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    publish()
  }

  api.current = { publish, applyHighlight, toggleTodo, paste }

  return (
    <div className="overlay note-sheet">
      <div className="sheet">
        <div className="nc-bar">
          <button type="button" onClick={onClose}>取消</button>
          <span className="nc-title">闪念笔记</span>
          <button className="nc-done" type="button" onClick={onSave}>保存</button>
        </div>
        <input className="nc-title-input" aria-label="笔记标题" placeholder="标题" value={title} onChange={(event) => onTitle(event.target.value)} />
        <div className="chips">{NOTE_TAGS.map((tag) => <button className={`chip ${selectedTags.has(tag) ? 'on' : ''}`} key={tag} type="button" aria-pressed={selectedTags.has(tag)} onClick={() => toggleTag(tag)}>{tag}</button>)}</div>
        <div className="nc-body">
          <NoteEditor seedHtml={seedHtml.current} initiallyEmpty={initiallyEmpty.current} editorRef={editorRef} api={api} />
          {attachments.length > 0 && (
            <div className="nc-attachments">
              {attachments.map((file) => (
                <figure className={`nc-attachment ${file.kind === 'image' ? 'is-image' : 'is-file'}`} key={file.id}>
                  {file.kind === 'image' && file.url && <img src={file.url} alt="" />}
                  <figcaption>{file.name}</figcaption>
                  <button type="button" className="nc-attachment-x" aria-label={`移除附件 ${file.name}`} onClick={() => removeAttachment(file.id)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                      <path d="M6 6l12 12M18 6 6 18" />
                    </svg>
                  </button>
                </figure>
              ))}
            </div>
          )}
        </div>
        <div className="nc-compose">
          {attachOpen && (
            <div className="nc-upload" role="group" aria-label="上传">
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { if (imageRef.current) imageRef.current.value = ''; imageRef.current?.click() }}>上传图片</button>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { if (fileRef.current) fileRef.current.value = ''; fileRef.current?.click() }}>上传文件</button>
            </div>
          )}
          <div className="nc-toolbar" role="toolbar" aria-label="笔记工具">
            <button type="button" aria-label="插入待办" onMouseDown={(event) => event.preventDefault()} onClick={insertTodo}><TodoIcon /></button>
            <button type="button" aria-label="添加附件" aria-expanded={attachOpen} className={attachOpen ? 'on' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => setAttachOpen((open) => !open)}><ClipIcon /></button>
            <button type="button" aria-label="高亮" aria-pressed={highlightOn} className={highlightOn ? 'on' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => {
              const next = !highlightRef.current
              highlightRef.current = next
              editorRef.current?.classList.toggle('hl-on', next)
              setHighlightOn(next)
              if (next) window.requestAnimationFrame(() => applyHighlight(true))
            }}><PenMarkIcon /></button>
          </div>
        </div>
        <input ref={imageRef} type="file" accept="image/*" hidden onChange={(event) => addAttachments(event.target.files, 'image')} />
        <input ref={fileRef} type="file" hidden onChange={(event) => addAttachments(event.target.files, 'file')} />
      </div>
    </div>
  )
}

function isPdfItem(item: LibraryItem) {
  return item.type === 'doc' && (item.fmt === 'PDF' || /\.pdf$/i.test(item.title) || Boolean(item.upload))
}

function DetailSheet({ item, onClose, onToast }: { item: LibraryItem; onClose: () => void; onToast: (message: string) => void }) {
  const pdf = isPdfItem(item)
  const fileId = item.upload?.fileId ?? null
  const [panel, setPanel] = useState<'pdf' | 'text' | null>(null)
  if (item.recording) return <RecordingDetail recordingId={item.recording.id} onClose={onClose} />
  return (
    <>
      <div className="overlay detail-overlay" onClick={onClose}>
        <div className="sheet" onClick={(event) => event.stopPropagation()}>
          <button className="back-row" type="button" onClick={onClose}>‹ 知识库</button>
          <div className="detail-card">
            <h2>{item.title}</h2>
            <p className="meta">{itemMeta(item)}{item.tags.length ? ` · ${item.tags.join(' / ')}` : ''}</p>
            {item.body && <div className="detail-body">{item.body}</div>}
            {item.upload && <p className="detail-body">{[item.upload.label, item.upload.detail].filter(Boolean).join(' · ')}</p>}
            {item.type !== 'note' && item.status === 'inbox' && item.type !== 'doc' && <button className="btn btn-primary btn-block" type="button" onClick={() => { onToast('已整理'); onClose() }}>标为已整理</button>}
          </div>
          {pdf && (
            <div className="detail-actions">
              <button className="btn btn-primary" type="button" onClick={() => setPanel('pdf')}>打开PDF</button>
              <button className="btn btn-ghost" type="button" onClick={() => setPanel('text')}>打开完整解析</button>
            </div>
          )}
          {pdf && (
            <div className="detail-scroll">
              <FileSummary fileId={fileId} fileName={item.title} />
            </div>
          )}
        </div>
      </div>
      {panel === 'pdf' && <PdfViewer fileId={fileId} onClose={() => setPanel(null)} />}
      {panel === 'text' && <DocumentTextViewer fileId={fileId} onClose={() => setPanel(null)} />}
    </>
  )
}

function MePage({ nickname: name, letter, nodes, docs, notes, onMenu }: {
  nickname: string
  letter: string
  nodes: number
  docs: number
  notes: number
  onMenu: (message: string) => void
}) {
  const menus = [
    ['偏好设置', '偏好设置 · 即将开放'],
    ['同步与备份', '同步与备份 · 即将开放'],
    ['隐私与数据', '隐私与数据 · 即将开放'],
    ['关于小豆', '小豆 · 原型 v0.1'],
  ] as const
  return (
    <section className="page">
      <div className="me-profile">
        <div className="me-hero">
          <div className="me-avatar" aria-hidden="true">{letter}</div>
          <div className="me-meta">
            <b>{name}</b>
            <span>小豆 · 学习中</span>
          </div>
        </div>
        <div className="me-stats">
          <div className="me-stat"><b>{nodes}</b><span>知识节点</span></div>
          <div className="me-stat"><b>{docs}</b><span>文档</span></div>
          <div className="me-stat"><b>{notes}</b><span>笔记 / 录音</span></div>
        </div>
        <div className="me-menu">
          {menus.map(([label, message]) => (
            <button type="button" key={label} onClick={() => onMenu(message)}>
              {label}
              <span className="go">›</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

function TodoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3.5" width="7.2" height="7.2" rx="1.6" />
      <path d="m4.7 7.1 1.6 1.6 2.8-3.1" />
      <circle cx="6.6" cy="17.2" r="2.15" />
      <path d="M13 7h8M13 17.2h8" />
    </svg>
  )
}
function PenMarkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.2" />
      <path d="m14.7 7.6 1.7 1.7-6.2 6.2-2.2.6.5-2.3 6.2-6.2z" />
    </svg>
  )
}
function PenIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.45 3.55a2.1 2.1 0 0 1 3 3L7.5 18.5 3 20l1.5-4.5L16.45 3.55z" /></svg>
}
function MicIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M12 2.8a2.8 2.8 0 0 0-2.8 2.8v5.6a2.8 2.8 0 0 0 5.6 0V5.6A2.8 2.8 0 0 0 12 2.8Z" /><path d="M6.5 10.2a5.5 5.5 0 0 0 11 0" /><path d="M12 15.7v3.5" /></svg>
}
function ClipIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
}
function DocIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>
}
function BookIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M5 5.2h5.2a2 2 0 0 1 2 2v11.2c0-.8-.7-1.4-1.5-1.4H5V5.2z" /><path d="M19 5.2h-5.2a2 2 0 0 0-2 2v11.2c0-.8.7-1.4 1.5-1.4H19V5.2z" /></svg>
}
function AskIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="7.2" /><circle cx="12" cy="12" r="2.2" /></svg>
}
function GlobeIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="8" /><path d="M12 4v16M4 12h16" /><ellipse cx="12" cy="12" rx="3.4" ry="8" /></svg>
}
function SearchIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-3.2-3.2" /></svg>
}
function CamIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3.5" /></svg>
}
function MoreIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="6" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="18" cy="12" r="1.4" /></svg>
}
function SendIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 2 11 13" /><path d="m22 2-7 20-4-9-9-4 20-7z" /></svg>
}

export function GraphPage({ items }: { items: LibraryItem[] }) {
  return (
    <section className="page active graph-page">
      <div className="stat-grid">
        <div className="stat"><b>{items.length + 10}</b><span>知识节点</span></div>
        <div className="stat"><b>18</b><span>关联链接</span></div>
        <div className="stat"><b>{new Set(items.flatMap((item) => item.tags)).size + 2}</b><span>主题领域</span></div>
      </div>
      <div className="graph-canvas">
        <svg viewBox="0 0 390 380" aria-label="知识关系图">
          <g stroke="#ddd7ce" strokeWidth="1.5"><path d="M190 190L75 92M190 190L312 90M190 190L74 286M190 190L318 286M190 190L190 54" /></g>
          <circle cx="190" cy="190" r="38" fill="#3a3530" />
          <text x="190" y="194" fill="white" textAnchor="middle">认知负荷</text>
        </svg>
        <div className="graph-legend"><span>核心概念</span><span>技术方法</span><span>资料来源</span></div>
        <small className="graph-hint">拖拽节点 · 点击查看</small>
      </div>
    </section>
  )
}

export default App
