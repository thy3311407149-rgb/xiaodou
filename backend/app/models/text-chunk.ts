export type EmbeddingStatus = 'NOT_READY' | 'PENDING' | 'READY' | 'FAILED'

export type TextChunk = {
  id: string
  fileId: string
  pageNumber: number | null
  chunkIndex: number
  content: string
  tokenCount: number
  embeddingStatus: EmbeddingStatus
  startTime: number | null
  endTime: number | null
  speakerId: string | null
  noteId: string | null
  createdAt: string
}

export type CreateTextChunkInput = {
  id: string
  fileId: string
  pageNumber?: number | null
  chunkIndex: number
  content: string
  tokenCount?: number
  embeddingStatus?: EmbeddingStatus
}
