import { ApplicationError } from '../../core/errors/application-error.js'
import type { LlmClient } from '../llm/llm-client.js'
import { KnowledgeRetrievalService, type KnowledgeChunk } from './knowledge-retrieval-service.js'

const ASK_PROMPT = [
  '你是问小豆。只根据用户给出的 chunks 回答问题。',
  '不要补充原文没有的信息。找不到依据时，回答文档中没有相关内容。',
  '只返回一个 JSON 对象，不要使用 Markdown。',
  'JSON 字段只有 answer。',
].join('\n')

const QUOTE_LENGTH = 80

export type KnowledgeSource = {
  fileId: string
  pageNumber: number | null
  quote: string
}

export type KnowledgeAnswer = {
  answer: string
  sources: KnowledgeSource[]
}

export class KnowledgeAskService {
  constructor(
    private readonly retrievalService: KnowledgeRetrievalService,
    private readonly llmClient: LlmClient,
  ) {}

  async ask(query: string): Promise<KnowledgeAnswer> {
    const { chunks } = this.retrievalService.search(query)
    if (chunks.length === 0) return { answer: '', sources: [] }
    const completion = await this.llmClient.complete([
      { role: 'system', content: ASK_PROMPT },
      { role: 'user', content: JSON.stringify({ query, chunks }) },
    ])
    return {
      answer: readAnswer(completion.content),
      sources: chunks.map(toSource),
    }
  }
}

function readAnswer(content: string): string {
  const jsonText = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const payload = JSON.parse(jsonText) as unknown
    if (typeof payload === 'object' && payload !== null && 'answer' in payload && typeof payload.answer === 'string') {
      return payload.answer.trim()
    }
  } catch {
    throw new ApplicationError('LLM_INVALID_RESPONSE')
  }
  throw new ApplicationError('LLM_INVALID_RESPONSE')
}

function toSource(chunk: KnowledgeChunk): KnowledgeSource {
  const quote = chunk.content.trim().slice(0, QUOTE_LENGTH)
  return {
    fileId: chunk.fileId,
    pageNumber: chunk.pageNumber,
    quote,
  }
}
