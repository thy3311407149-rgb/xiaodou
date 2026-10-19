import type { TaskSnapshot, UploadedPdf } from './task.ts'
import { mapTaskView, type UploadPhase } from './task-view.ts'

export type LibraryUpload = {
  fileId: string
  taskId: string
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
