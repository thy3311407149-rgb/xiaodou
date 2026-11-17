import type { RecordingListItem, RecordingStatus, RecordingTaskStatus } from '../api/recordings.ts'
import { formatRecordedAt } from './clock.ts'

export type RecordingLibraryItem = {
  id: string
  type: 'voice'
  status: 'done' | 'inbox'
  title: string
  desc: string
  time: string
  body: string
  tags: string[]
  duration?: number
  createdAt: string
  recording: {
    id: string
    phase: 'processing' | 'succeeded' | 'failed'
    label: string
    detail: string | null
    progress: number | null
  }
}

export function libraryItemFromRecording(item: RecordingListItem): RecordingLibraryItem {
  const badge = recordingBadge(item.status, item.processingStatus)
  return {
    id: item.recordingId,
    type: 'voice',
    status: badge.phase === 'succeeded' ? 'done' : 'inbox',
    title: item.title || '录音',
    desc: '',
    time: formatRecordedAt(item.createdAt),
    body: '',
    tags: [],
    duration: item.durationMs == null ? undefined : Math.max(0, Math.round(item.durationMs / 1000)),
    createdAt: item.createdAt,
    recording: {
      id: item.recordingId,
      phase: badge.phase,
      label: badge.label,
      detail: null,
      progress: null,
    },
  }
}

export function mergeRecordingItems<T extends { id: string; createdAt?: string }>(current: T[], incoming: T[], page: number): T[] {
  const byId = new Map<string, T>()
  if (page <= 1) {
    for (const item of incoming) byId.set(item.id, item)
    for (const item of current) if (!byId.has(item.id)) byId.set(item.id, item)
  } else {
    for (const item of current) byId.set(item.id, item)
    for (const item of incoming) if (!byId.has(item.id)) byId.set(item.id, item)
  }
  return [...byId.values()].sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''))
}

function recordingBadge(status: RecordingStatus, processingStatus: RecordingTaskStatus | null): { phase: 'processing' | 'succeeded' | 'failed'; label: string } {
  if (processingStatus === 'FAILED' || status === 'INTERRUPTED') return { phase: 'failed', label: processingStatus === 'FAILED' ? '失败' : '已中断' }
  if (processingStatus === 'QUEUED' || processingStatus === 'RUNNING') return { phase: 'processing', label: '处理中' }
  if (processingStatus === 'SUCCEEDED') return { phase: 'succeeded', label: '处理完成' }
  if (status === 'RECORDING') return { phase: 'processing', label: '录音中' }
  if (status === 'PAUSED') return { phase: 'processing', label: '已暂停' }
  if (status === 'CREATED') return { phase: 'processing', label: '未开始' }
  return { phase: 'succeeded', label: '已结束' }
}
