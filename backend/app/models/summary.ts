export type Citation = {
  chunkId: string
  pageNumber: number | null
  quote: string
}

export type Summary = {
  id: string
  fileId: string
  taskId: string
  content: string
  keyPoints: string[]
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
  keyPoints: string[]
  citations: Citation[]
  modelName: string
  promptVersion: string
  inputTokens?: number
  outputTokens?: number
}
