/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileDetail } from '../api/files.ts'
import type { FileSummary } from '../api/summaries.ts'
import { FileSummary as FileSummaryPanel, SummaryCard } from './SummaryCard.tsx'

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
    const paragraph = await screen.findByText('工作记忆容量有限。')
    expect(paragraph.tagName).toBe('P')
    expect(paragraph.closest('.summary-card')).toBeTruthy()
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
    expect(document.querySelector('.summary-card')).toBeNull()
  })

  it('shows the understanding state for an empty summary without crashing', () => {
    render(<SummaryCard fileName="认知负荷.pdf" state="empty" summary={null} />)
    expect(screen.getByText('AI正在理解文档...')).toBeTruthy()
    expect(screen.getByText('认知负荷.pdf').className).toContain('summary-title')
    expect(document.querySelector('.summary-card')).toBeNull()
  })

  it('renders markdown headings inside the overview and keeps the file name as the title', async () => {
    const content = '# 一级标题\n\n## 二级标题\n\n### 三级标题'
    const load = vi.fn(async () => detail({ ...summary, content, keyPoints: [], citations: [] }))
    render(<FileSummaryPanel fileId="file_1" fileName="本地名称.pdf" load={load} />)
    expect(await screen.findByRole('heading', { level: 1, name: '一级标题' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: '二级标题' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 3, name: '三级标题' })).toBeTruthy()
    const title = screen.getByText('认知负荷.pdf')
    expect(title.tagName).toBe('P')
    expect(title.className).toContain('summary-title')
  })

  it('renders unordered and ordered lists and blockquotes from markdown', async () => {
    const content = '- 无序一\n- 无序二\n\n1. 有序一\n2. 有序二\n\n> 引用原文'
    const load = vi.fn(async () => detail({ ...summary, content }))
    render(<FileSummaryPanel fileId="file_1" fileName="认知负荷.pdf" load={load} />)
    const card = (await screen.findByText('无序一')).closest('.summary-card')
    expect(card).toBeTruthy()
    const view = within(card as HTMLElement)
    expect(view.getAllByRole('list').map((list) => list.tagName)).toEqual(['UL', 'OL'])
    expect(view.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['无序一', '无序二', '有序一', '有序二'])
    expect(view.getByText('引用原文').closest('blockquote')).toBeTruthy()
  })

  it('keeps plain lines as paragraphs instead of inventing headings', async () => {
    const load = vi.fn(async () => detail({ ...summary, content: '工作记忆\n容量有限。', keyPoints: [], citations: [] }))
    render(<FileSummaryPanel fileId="file_1" fileName="认知负荷.pdf" load={load} />)
    const card = (await screen.findByText(/工作记忆/)).closest('.summary-card')
    expect(card?.querySelector('h1, h2, h3, ul, ol, blockquote')).toBeNull()
    expect(card?.querySelector('p')?.textContent).toBe('工作记忆\n容量有限。')
  })

  it('shows the failure state when the detail request fails', async () => {
    const load = vi.fn(async () => Promise.reject(new Error('offline')))
    render(<FileSummaryPanel fileId="file_1" fileName="认知负荷.pdf" load={load} />)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '文档理解失败，请重试')
    expect(screen.getByText('认知负荷.pdf')).toBeTruthy()
  })
})
