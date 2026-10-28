import type { TaskSnapshot, UploadedPdf } from './task.ts'
import { mapTaskView, type UploadPhase } from './task-view.ts'

export type LibraryUpload = {
  fileId: string
  taskId: string | null
  phase: UploadPhase
  label: string
  detail: string | null
  progress: number | null
}

export type UploadedLibraryItem = {
  id: string
  type: 'doc'
  status: 'done' | 'inbox'
  title: string
  desc: string
  time: string
  body: string
  tags: string[]
  ready: boolean
  fmt: 'PDF'
  upload: LibraryUpload
}

export function libraryItemFromUpload(uploaded: UploadedPdf): UploadedLibraryItem {
  const view = mapTaskView(uploaded.task)
  return {
    id: uploaded.fileId,
    type: 'doc',
    status: view.phase === 'succeeded' ? 'done' : 'inbox',
    title: uploaded.fileName,
    desc: view.detail ?? '',
    time: '刚刚',
    body: '',
    tags: [],
    ready: view.phase === 'succeeded',
    fmt: 'PDF',
    upload: {
      fileId: uploaded.fileId,
      taskId: uploaded.task.id,
      phase: view.phase,
      label: view.label,
      detail: view.detail,
      progress: view.progress,
    },
  }
}

const failedFileStatuses = new Set(['UPLOAD_FAILED', 'EXTRACTION_FAILED', 'SUMMARY_FAILED'])

export function formatLibraryTime(createdAt: string, now = new Date()): string {
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return ''
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000)
  if (date >= startOfToday) return `今天 ${clock}`
  if (date >= startOfYesterday) return `昨天 ${clock}`
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

export function libraryItemFromStoredFile(file: { id: string; fileName: string; status: string; errorMessage: string | null; createdAt: string }, now = new Date()): UploadedLibraryItem {
  const failed = failedFileStatuses.has(file.status)
  const done = file.status === 'COMPLETED'
  const detail = failed ? file.errorMessage?.trim() || '文件处理失败' : null
  return {
    id: file.id,
    type: 'doc',
    status: done ? 'done' : 'inbox',
    title: file.fileName,
    desc: detail ?? '',
    time: formatLibraryTime(file.createdAt, now),
    body: '',
    tags: [],
    ready: done,
    fmt: 'PDF',
    upload: {
      fileId: file.id,
      taskId: null,
      phase: failed ? 'failed' : done ? 'succeeded' : 'processing',
      label: failed ? '失败' : done ? '处理完成' : '处理中',
      detail,
      progress: null,
    },
  }
}

export function mergeStoredFiles<T extends { id: string; upload?: { taskId?: string | null } }>(current: readonly T[], stored: readonly T[]): T[] {
  const currentById = new Map(current.map((item) => [item.id, item]))
  const storedIds = new Set(stored.map((item) => item.id))
  const leading = stored.map((item) => {
    const existing = currentById.get(item.id)
    return existing?.upload?.taskId ? existing : item
  })
  return [...leading, ...current.filter((item) => !storedIds.has(item.id))]
}

export function withTask<T extends { title: string; desc: string; status: 'done' | 'inbox'; ready?: boolean; upload?: LibraryUpload }>(item: T, task: TaskSnapshot): T {
  const view = mapTaskView(task)
  return {
    ...item,
    status: view.phase === 'succeeded' ? 'done' : 'inbox',
    ready: view.phase === 'succeeded',
    desc: view.detail ?? '',
    upload: item.upload
      ? { ...item.upload, phase: view.phase, label: view.label, detail: view.detail, progress: view.progress }
      : item.upload,
  }
}
