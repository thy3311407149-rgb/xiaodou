export type Citation = {
  chunkId: string
  pageNumber: number | null
  quote: string
}

export type SummaryKeyPoint = {
  content: string
  sourceChunkIndexes: number[]
}

export type Summary = {
  id: string
  fileId: string
  taskId: string
  content: string
  keyPoints: SummaryKeyPoint[]
  citations: Citation[]
  modelName: string
  promptVersion: string
  inputTokens: number
  outputTokens: number
  createdAt: string
  updatedAt: string
}

export type CreateSummaryInput = {
  id: string
  fileId: string
  taskId: string
  content: string
  keyPoints: SummaryKeyPoint[]
  citations: Citation[]
  modelName: string
  promptVersion: string
  inputTokens?: number
  outputTokens?: number
}
