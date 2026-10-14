import type { TextChunk } from '../../models/text-chunk.js'
import { TextChunkRepository } from '../../repositories/text-chunk-repository.js'

export const KNOWLEDGE_SEARCH_LIMIT = 20

export type KnowledgeChunk = {
  chunkId: string
  fileId: string
  pageNumber: number | null
  content: string
}

export class KnowledgeRetrievalService {
  constructor(
    private readonly textChunkRepository: TextChunkRepository,
    private readonly limit = KNOWLEDGE_SEARCH_LIMIT,
  ) {}

  search(query: string): { chunks: KnowledgeChunk[] } {
    const matches = this.textChunkRepository.searchByKeyword(query, this.limit)
    return { chunks: matches.map(toKnowledgeChunk) }
  }
}

function toKnowledgeChunk(chunk: TextChunk): KnowledgeChunk {
  return {
    chunkId: chunk.id,
    fileId: chunk.fileId,
    pageNumber: chunk.pageNumber,
    content: chunk.content,
  }
}
