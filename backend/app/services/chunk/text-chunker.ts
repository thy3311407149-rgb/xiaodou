export const DEFAULT_CHUNK_SIZE = 1200

export type ChunkSourcePage = {
  pageNumber: number
  content: string
}

export type TextChunkDraft = {
  pageNumber: number
  chunkIndex: number
  content: string
  tokenCount: number
}

export function estimateTokenCount(content: string): number {
  const trimmed = content.trim()
  if (trimmed.length === 0) return 0
  return Math.max(1, Math.ceil(trimmed.length / 4))
}

export function chunkDocumentTexts(pages: readonly ChunkSourcePage[], chunkSize = DEFAULT_CHUNK_SIZE): TextChunkDraft[] {
  const size = Math.max(1, chunkSize)
  const ordered = [...pages].sort((left, right) => left.pageNumber - right.pageNumber)
  const drafts: TextChunkDraft[] = []
  let chunkIndex = 0

  for (const page of ordered) {
    const content = page.content
    if (content.trim().length === 0) continue
    for (let offset = 0; offset < content.length; offset += size) {
      const slice = content.slice(offset, offset + size)
      if (slice.trim().length === 0) continue
      drafts.push({
        pageNumber: page.pageNumber,
        chunkIndex,
        content: slice,
        tokenCount: estimateTokenCount(slice),
      })
      chunkIndex += 1
    }
  }

  return drafts
}
