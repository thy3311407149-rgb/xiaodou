import { describe, expect, it } from 'vitest'
import { chunkDocumentTexts, DEFAULT_CHUNK_SIZE } from '../app/services/chunk/text-chunker.js'

describe('text chunker', () => {
  it('splits a long page into continuous indexes and keeps the page number', () => {
    const drafts = chunkDocumentTexts([{ pageNumber: 1, content: 'a'.repeat(10_000) }], 1000)

    expect(drafts.length).toBe(10)
    expect(drafts.map((draft) => draft.chunkIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(drafts.every((draft) => draft.pageNumber === 1)).toBe(true)
    expect(drafts.every((draft) => draft.content.length > 0 && draft.content.length <= 1000)).toBe(true)
    expect(drafts.every((draft) => draft.tokenCount > 0)).toBe(true)
  })

  it('continues chunk indexes across pages and skips empty pages', () => {
    const drafts = chunkDocumentTexts([
      { pageNumber: 2, content: 'second-page' },
      { pageNumber: 1, content: '   ' },
      { pageNumber: 3, content: 'third-page' },
    ])

    expect(drafts).toEqual([
      expect.objectContaining({ pageNumber: 2, chunkIndex: 0, content: 'second-page' }),
      expect.objectContaining({ pageNumber: 3, chunkIndex: 1, content: 'third-page' }),
    ])
  })

  it('uses a character size inside the MVP range by default', () => {
    expect(DEFAULT_CHUNK_SIZE).toBeGreaterThanOrEqual(1000)
    expect(DEFAULT_CHUNK_SIZE).toBeLessThanOrEqual(1500)
    const drafts = chunkDocumentTexts([{ pageNumber: 4, content: 'z'.repeat(DEFAULT_CHUNK_SIZE + 20) }])
    expect(drafts.map((draft) => draft.content.length)).toEqual([DEFAULT_CHUNK_SIZE, 20])
  })
})
