import { describe, expect, it } from 'vitest'
import { citationPages, parseFileSummary, summaryDisplayState, type FileSummary } from './summaries.ts'

const summary: FileSummary = {
  id: 'summary_1',
  fileId: 'file_1',
  taskId: 'task_1',
  content: '工作记忆容量有限。',
  keyPoints: ['外在负荷可以降低'],
  citations: [
    { chunkId: 'chunk_1', pageNumber: 1, quote: '留空' },
    { chunkId: 'chunk_2', pageNumber: null, quote: '无页码' },
    { chunkId: 'chunk_3', pageNumber: 3, quote: '第三页' },
  ],
}

describe('summary contract', () => {
  it('reads key points and citation pages without adding pages', () => {
    expect(parseFileSummary(summary)).toMatchObject({ keyPoints: ['外在负荷可以降低'] })
    expect(parseFileSummary({
      ...summary,
      keyPoints: [{ content: '外在负荷可以降低', sourceChunkIndexes: [0] }],
    })).toMatchObject({ keyPoints: ['外在负荷可以降低'] })
    expect(parseFileSummary({ ...summary, keyPoints: [{ sourceChunkIndexes: [0] }] })).toBeNull()
    expect(citationPages(summary)).toEqual([1, 3])
  })

  it('keeps a missing summary empty and a failed summary in error', () => {
    expect(summaryDisplayState({ file: { status: 'UPLOADED' }, task: { status: 'RUNNING' }, summary: null })).toBe('empty')
    expect(summaryDisplayState({ file: { status: 'SUMMARY_FAILED' }, task: null, summary: null })).toBe('error')
    expect(summaryDisplayState({ file: { status: 'UPLOADED' }, task: null, summary })).toBe('success')
  })
})
