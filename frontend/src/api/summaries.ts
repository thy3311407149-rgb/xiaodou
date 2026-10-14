export type FileCitation = {
  chunkId: string
  pageNumber: number | null
  quote: string
}

export type FileSummary = {
  id: string
  fileId: string
  taskId: string
  content: string
  keyPoints: string[]
  citations: FileCitation[]
}

export type SummaryDisplayState = 'loading' | 'success' | 'empty' | 'error'
export type SummaryResultState = Exclude<SummaryDisplayState, 'loading'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readKeyPoint(point: unknown): string | null {
  if (typeof point === 'string') return point
  if (isRecord(point) && typeof point.content === 'string') return point.content
  return null
}

export function parseFileSummary(value: unknown): FileSummary | null {
  if (!isRecord(value) || typeof value.content !== 'string' || !Array.isArray(value.keyPoints) || !Array.isArray(value.citations)) return null
  const keyPoints: string[] = []
  for (const point of value.keyPoints) {
    const content = readKeyPoint(point)
    if (content == null) return null
    keyPoints.push(content)
  }
  const citations: FileCitation[] = []
  for (const citation of value.citations) {
    if (!isRecord(citation) || typeof citation.quote !== 'string') return null
    if (citation.pageNumber != null && typeof citation.pageNumber !== 'number') return null
    citations.push({
      chunkId: typeof citation.chunkId === 'string' ? citation.chunkId : '',
      pageNumber: citation.pageNumber ?? null,
      quote: citation.quote,
    })
  }
  return {
    id: typeof value.id === 'string' ? value.id : '',
    fileId: typeof value.fileId === 'string' ? value.fileId : '',
    taskId: typeof value.taskId === 'string' ? value.taskId : '',
    content: value.content,
    keyPoints,
    citations,
  }
}

export function summaryDisplayState(detail: { file: { status: string }; task: { status: string } | null; summary: FileSummary | null }): SummaryResultState {
  if (detail.summary) return 'success'
  if (detail.file.status === 'SUMMARY_FAILED' || detail.task?.status === 'FAILED') return 'error'
  return 'empty'
}

export function citationPages(summary: FileSummary): number[] {
  return summary.citations.flatMap((citation) => typeof citation.pageNumber === 'number' ? [citation.pageNumber] : [])
}
