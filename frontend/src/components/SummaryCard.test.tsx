/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileDetail } from '../api/files.ts'
import type { FileSummary } from '../api/summaries.ts'
import { FileSummary as FileSummaryPanel } from './SummaryCard.tsx'

const summary: FileSummary = {
  id: 'summary_1',
  fileId: 'file_1',
  taskId: 'task_1',
  content: '工作记忆容量有限。',
  keyPoints: ['外在负荷可以降低', '组块能省容量'],
  citations: [
    { chunkId: 'chunk_1', pageNumber: 1, quote: '第一处' },
    { chunkId: 'chunk_3', pageNumber: 3, quote: '第三处' },
  ],
}

function detail(summaryValue: FileSummary | null, status = 'UPLOADED'): FileDetail {
  return { file: { id: 'file_1', fileName: '认知负荷.pdf', status }, task: null, summary: summaryValue }
}

afterEach(() => cleanup())

describe('FileSummary', () => {
  it('shows the returned summary, at most six key points, and citation quotes', async () => {
    const points = ['外在负荷可以降低', '组块能省容量', '三点', '四点', '五点', '六点', '七点不展示']
    const load = vi.fn(async () => detail({ ...summary, keyPoints: points }))
    render(<FileSummaryPanel fileId="file_1" fileName="本地名称.pdf" load={load} />)
    expect(await screen.findByText('工作记忆容量有限。')).toBeTruthy()
    expect(screen.getByText('认知负荷.pdf')).toBeTruthy()
    expect(screen.getByText('外在负荷可以降低')).toBeTruthy()
    expect(screen.getByText('六点')).toBeTruthy()
    expect(screen.queryByText('七点不展示')).toBeNull()
    expect(screen.getByText('第1页')).toBeTruthy()
    expect(screen.getByText('第一处')).toBeTruthy()
    expect(screen.getByText('第3页')).toBeTruthy()
    expect(screen.getByText('第三处')).toBeTruthy()
    expect(screen.queryByText('第2页')).toBeNull()
    expect(load).toHaveBeenCalledWith('file_1')
  })

  it('shows the understanding state when summary is null', async () => {
    const load = vi.fn(async () => detail(null))
    render(<FileSummaryPanel fileId="file_1" fileName="认知负荷.pdf" load={load} />)
    expect(await screen.findByText('AI正在理解文档...')).toBeTruthy()
    expect(screen.queryByText('第1页')).toBeNull()
  })

  it('shows the failure state when the detail request fails', async () => {
    const load = vi.fn(async () => Promise.reject(new Error('offline')))
    render(<FileSummaryPanel fileId="file_1" fileName="认知负荷.pdf" load={load} />)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '文档理解失败，请重试')
    expect(screen.getByText('认知负荷.pdf')).toBeTruthy()
  })
})
