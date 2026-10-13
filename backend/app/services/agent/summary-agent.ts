import { ApplicationError } from '../../core/errors/application-error.js'
import type { Citation, SummaryKeyPoint } from '../../models/summary.js'
import type { LlmClient, LlmMessage } from '../llm/llm-client.js'

export const SUMMARY_PROMPT_VERSION = 'summary-v1'

export type SummaryChunkInput = {
  id: string
  chunkIndex: number
  pageNumber: number | null
  content: string
}

export type SummaryDraft = {
  title: string
  summary: string
  keyPoints: SummaryKeyPoint[]
  citations: Citation[]
  modelName: string
  promptVersion: string
  inputTokens: number
  outputTokens: number
}

const SYSTEM_PROMPT = [
  '你是文档摘要助手。只根据用户给出的 text chunks 写摘要。',
  '不要补充原文没有的事实。',
  '只返回一个 JSON 对象，不要使用 Markdown。',
  'JSON 字段：title, summary, keyPoints, citations。',
  'keyPoints 的每一项必须包含 content 和 sourceChunkIndexes。sourceChunkIndexes 只能使用输入里的 chunkIndex。',
  'citations 的每一项必须包含 chunkId, pageNumber, quote。quote 必须是对应 chunk content 的连续原文，pageNumber 必须与该 chunk 一致。',
].join('\n')

export class SummaryAgent {
  constructor(
    private readonly llmClient: LlmClient,
    private readonly promptVersion = SUMMARY_PROMPT_VERSION,
  ) {}

  async summarize(chunks: readonly SummaryChunkInput[]): Promise<SummaryDraft> {
    if (chunks.length === 0) {
      throw new ApplicationError('SUMMARY_GENERATION_FAILED', { message: '没有可摘要的文本' })
    }

    const messages: LlmMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ chunks }) },
    ]
    const completion = await this.llmClient.complete(messages)
    const parsed = parseSummaryPayload(completion.content)
    const validated = validateSummaryPayload(parsed, chunks)
    return {
      ...validated,
      modelName: completion.modelName,
      promptVersion: this.promptVersion,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
    }
  }
}

function parseSummaryPayload(content: string): unknown {
  const jsonText = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(jsonText) as unknown
  } catch {
    throw new ApplicationError('LLM_INVALID_RESPONSE')
  }
}

function validateSummaryPayload(payload: unknown, chunks: readonly SummaryChunkInput[]): {
  title: string
  summary: string
  keyPoints: SummaryKeyPoint[]
  citations: Citation[]
} {
  if (!isRecord(payload)) throw new ApplicationError('LLM_INVALID_RESPONSE')
  const title = readText(payload.title)
  const summary = readText(payload.summary)
  if (title.length === 0 || summary.length === 0) throw new ApplicationError('LLM_INVALID_RESPONSE')

  const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]))
  const chunksByIndex = new Map(chunks.map((chunk) => [chunk.chunkIndex, chunk]))
  const keyPoints = readKeyPoints(payload.keyPoints, chunksByIndex)
  const citations = readCitations(payload.citations, chunksById)
  if (keyPoints.length === 0 || citations.length === 0) throw new ApplicationError('LLM_INVALID_RESPONSE')
  return { title, summary, keyPoints, citations }
}

function readKeyPoints(value: unknown, chunksByIndex: Map<number, SummaryChunkInput>): SummaryKeyPoint[] {
  if (!Array.isArray(value)) throw new ApplicationError('LLM_INVALID_RESPONSE')
  return value.map((item) => {
    if (!isRecord(item)) throw new ApplicationError('LLM_INVALID_RESPONSE')
    const content = readText(item.content)
    if (content.length === 0 || !Array.isArray(item.sourceChunkIndexes) || item.sourceChunkIndexes.length === 0) {
      throw new ApplicationError('LLM_INVALID_RESPONSE')
    }
    const sourceChunkIndexes = item.sourceChunkIndexes.map((index) => {
      if (typeof index !== 'number' || !Number.isInteger(index) || !chunksByIndex.has(index)) {
        throw new ApplicationError('LLM_INVALID_RESPONSE')
      }
      return index
    })
    return { content, sourceChunkIndexes }
  })
}

function readCitations(value: unknown, chunksById: Map<string, SummaryChunkInput>): Citation[] {
  if (!Array.isArray(value)) throw new ApplicationError('LLM_INVALID_RESPONSE')
  return value.map((item) => {
    if (!isRecord(item)) throw new ApplicationError('LLM_INVALID_RESPONSE')
    const chunkId = readText(item.chunkId)
    const quote = readText(item.quote)
    const chunk = chunksById.get(chunkId)
    const pageNumber = item.pageNumber === null ? null : item.pageNumber
    if (!chunk || typeof pageNumber !== 'number' && pageNumber !== null) {
      throw new ApplicationError('LLM_INVALID_RESPONSE')
    }
    if (pageNumber !== chunk.pageNumber || quote.length === 0 || !chunk.content.includes(quote)) {
      throw new ApplicationError('LLM_INVALID_RESPONSE')
    }
    return { chunkId, pageNumber, quote }
  })
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
