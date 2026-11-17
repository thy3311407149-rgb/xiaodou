import { describe, expect, it } from 'vitest'
import type { RecordingListItem } from '../api/recordings.ts'
import { libraryItemFromRecording, mergeRecordingItems } from './library-item.ts'

function item(overrides: Partial<RecordingListItem>): RecordingListItem {
  return {
    recordingId: 'rec_1',
    title: '课堂录音',
    createdAt: '2026-11-08T03:00:00.000Z',
    durationMs: 12_500,
    status: 'ENDED',
    processingStatus: 'SUCCEEDED',
    summaryGenerated: true,
    ...overrides,
  }
}

describe('recording library items', () => {
  it('keeps server order by creation time and does not invent a transcript', () => {
    const newer = libraryItemFromRecording(item({ recordingId: 'new', createdAt: '2026-11-08T03:00:00.000Z' }))
    const older = libraryItemFromRecording(item({ recordingId: 'old', title: '旧录音', createdAt: '2026-11-08T01:00:00.000Z', processingStatus: null, status: 'CREATED', summaryGenerated: false, durationMs: null }))
    const merged = mergeRecordingItems([older], [newer, older], 1)
    expect(merged.map((entry) => entry.id)).toEqual(['new', 'old'])
    expect(newer.desc).toBe('')
    expect(newer.body).toBe('')
    expect(newer.recording).toMatchObject({ phase: 'succeeded', label: '处理完成' })
    expect(older.recording).toMatchObject({ phase: 'processing', label: '未开始' })
    expect(newer.duration).toBe(13)
  })

  it('shows processing and failure without marking them complete', () => {
    expect(libraryItemFromRecording(item({ processingStatus: 'RUNNING', summaryGenerated: false })).recording).toMatchObject({ phase: 'processing', label: '处理中' })
    expect(libraryItemFromRecording(item({ processingStatus: 'FAILED', summaryGenerated: false })).recording).toMatchObject({ phase: 'failed', label: '失败' })
    expect(libraryItemFromRecording(item({ status: 'INTERRUPTED', processingStatus: null, summaryGenerated: false })).recording.label).toBe('已中断')
  })

  it('appends the next page without duplicating a recording already shown', () => {
    const first = libraryItemFromRecording(item({ recordingId: 'new' }))
    const second = libraryItemFromRecording(item({ recordingId: 'old', createdAt: '2026-11-08T01:00:00.000Z' }))
    const merged = mergeRecordingItems([first], [first, second], 2)
    expect(merged.map((entry) => entry.id)).toEqual(['new', 'old'])
  })
})