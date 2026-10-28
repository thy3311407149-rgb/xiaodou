import { ApplicationError } from '../../core/errors/application-error.js'
import type { Citation, SummaryKeyPoint } from '../../models/summary.js'
import type { LlmClient, LlmMessage } from '../llm/llm-client.js'

export const SUMMARY_PROMPT_VERSION = 'summary-v5'

export type SummaryChunkInput = {
  chunkId: string
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
  '不要补充原文没有的事实，不要输出主观评价。',
  '只返回一个 JSON 对象，不要把整个结果放进代码块，不要在 JSON 前后添加解释。',
  'JSON 字段：title, summary, keyPoints, citations。',
  'title 是文档标题，只能依据原文概括，不要编造文档中不存在的名称。',
  'summary 的值必须是 Markdown 正文，不要输出 HTML。',
  'Markdown 标题必须有语义：用 # 表示文档主要章节，用 ## 表示功能模块或主要观点，用 ### 表示细分内容。',
  '列表使用 - 或 1. ，不要使用“一、”“二、”“1、”这类纯文本编号。',
  '保持段落结构，不要使用大量连续空行。',
  'summary 示例：',
  '## 核心功能',
  '',
  '系统包含：',
  '',
  '- 文件上传',
  '- AI解析',
  '- 知识管理',
  'keyPoints 只收录原文中的核心知识点，每一项包含 content 和 sourceChunkIndexes。知识点不要写成 Markdown 文档。',
  '知识点只从以下类型中选取，没有依据的类型不要写：核心结论或观点、关键事实数据、定义与概念、逻辑关系、重要清单或步骤、核心论据。',
  '不要输出原文不存在的信息，不要为了凑数量生成知识点或引用。',
  '长文档优先总结高价值内容。没有依据时 keyPoints 和 citations 可以是空数组。',
  'sourceChunkIndexes 只能使用输入里的 chunkIndex。',
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
  const jsonText = extractJsonObject(content)
  try {
    return JSON.parse(jsonText) as unknown
  } catch {
    const repaired = repairTruncatedJson(jsonText)
    if (repaired) return repaired
    throw new ApplicationError('LLM_INVALID_RESPONSE')
  }
}

function extractJsonObject(content: string): string {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = trimmed.indexOf('{')
  if (start < 0) return trimmed
  const end = findContainerEnd(trimmed, start, '{', '}')
  return end === null ? trimmed.slice(start) : trimmed.slice(start, end)
}

function repairTruncatedJson(jsonText: string): Record<string, unknown> | null {
  const title = readJsonStringField(jsonText, 'title')
  const summary = readJsonStringField(jsonText, 'summary')
  if (title === null || summary === null || title.length === 0 || summary.length === 0) return null
  return {
    title,
    summary,
    keyPoints: readCompleteObjects(jsonText, 'keyPoints'),
    citations: readCompleteObjects(jsonText, 'citations'),
  }
}

function readJsonStringField(jsonText: string, field: string): string | null {
  const match = new RegExp(`"${field}"\\s*:\\s*"`).exec(jsonText)
  if (!match) return null
  const start = match.index + match[0].length
  let index = start
  while (index < jsonText.length) {
    if (jsonText[index] === '\\') {
      index += 2
      continue
    }
    if (jsonText[index] === '"') {
      try {
        const value = JSON.parse(`"${jsonText.slice(start, index)}"`) as unknown
        return typeof value === 'string' ? value : null
      } catch {
        return null
      }
    }
    index += 1
  }
  return null
}

function readCompleteObjects(jsonText: string, field: string): unknown[] {
  const match = new RegExp(`"${field}"\\s*:\\s*\\[`).exec(jsonText)
  if (!match) return []
  let index = match.index + match[0].length
  const objects: unknown[] = []
  while (index < jsonText.length) {
    const char = jsonText[index] ?? ''
    if (char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === ',') {
      index += 1
      continue
    }
    if (char === ']' || char !== '{') break
    const end = findContainerEnd(jsonText, index, '{', '}')
    if (end === null) break
    try {
      objects.push(JSON.parse(jsonText.slice(index, end)) as unknown)
    } catch {
      break
    }
    index = end
  }
  return objects
}

function findContainerEnd(text: string, start: number, open: string, close: string): number | null {
  let depth = 0
  let inString = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === open) depth += 1
    if (char === close) {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return null
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

  const chunksById = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]))
  const chunksByIndex = new Map(chunks.map((chunk) => [chunk.chunkIndex, chunk]))
  return {
    title,
    summary,
    keyPoints: readKeyPoints(payload.keyPoints, chunksByIndex),
    citations: readCitations(payload.citations, chunksById),
  }
}

function readKeyPoints(value: unknown, chunksByIndex: Map<number, SummaryChunkInput>): SummaryKeyPoint[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item)) return []
    const content = readText(item.content)
    if (content.length === 0 || !Array.isArray(item.sourceChunkIndexes) || item.sourceChunkIndexes.length === 0) return []
    const sourceChunkIndexes: number[] = []
    for (const index of item.sourceChunkIndexes) {
      if (typeof index !== 'number' || !Number.isInteger(index) || !chunksByIndex.has(index)) return []
      sourceChunkIndexes.push(index)
    }
    return [{ content, sourceChunkIndexes }]
  })
}

function readCitations(value: unknown, chunksById: Map<string, SummaryChunkInput>): Citation[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item)) return []
    const chunkId = readText(item.chunkId)
    const quote = readText(item.quote)
    const chunk = chunksById.get(chunkId)
    const pageNumber = item.pageNumber === null ? null : item.pageNumber
    if (!chunk || (typeof pageNumber !== 'number' && pageNumber !== null)) return []
    if (pageNumber !== chunk.pageNumber || quote.length === 0 || !chunk.content.includes(quote)) return []
    return [{ chunkId, pageNumber, quote }]
  })
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
