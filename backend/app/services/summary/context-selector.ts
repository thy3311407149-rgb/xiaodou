import type { SummaryChunkInput } from '../agent/summary-agent.js'

export const MAX_SUMMARY_CHUNKS = 20
export const MAX_SUMMARY_INPUT_TOKENS = 6000

export function selectSummaryContext(chunks: readonly SummaryChunkInput[]): SummaryChunkInput[] {
  const ordered = [...chunks].sort((left, right) => left.chunkIndex - right.chunkIndex)
  const sampled = evenSample(ordered, MAX_SUMMARY_CHUNKS)
  return fitTokenBudget(sampled, MAX_SUMMARY_INPUT_TOKENS)
}

function evenSample<T>(items: readonly T[], limit: number): T[] {
  if (items.length <= limit) return [...items]
  if (limit <= 1) return items[0] === undefined ? [] : [items[0]]
  const indexes = new Set<number>()
  for (let slot = 0; slot < limit; slot += 1) {
    indexes.add(Math.round((slot * (items.length - 1)) / (limit - 1)))
  }
  return [...indexes].sort((left, right) => left - right).map((index) => items[index] as T)
}

function fitTokenBudget(items: readonly SummaryChunkInput[], maxTokens: number): SummaryChunkInput[] {
  const selected = [...items]
  while (selected.length > 1 && estimateTokens(selected) > maxTokens) {
    selected.splice(Math.floor(selected.length / 2), 1)
  }
  return selected
}

function estimateTokens(chunks: readonly SummaryChunkInput[]): number {
  return chunks.reduce((total, chunk) => total + Math.max(1, Math.ceil(chunk.content.length / 4)), 0)
}
