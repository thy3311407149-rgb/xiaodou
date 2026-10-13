import { describe, expect, it } from 'vitest'
import { SummaryAgent } from '../app/services/agent/summary-agent.js'
import type { LlmClient } from '../app/services/llm/llm-client.js'

const chunks = [{ id: 'chunk_1', chunkIndex: 0, pageNumber: 1, content: 'alpha page one' }]

describe('SummaryAgent', () => {
  it('rejects a citation that is not an excerpt of the source chunk', async () => {
    const llmClient: LlmClient = {
      async complete() {
        return {
          content: JSON.stringify({
            title: '标题',
            summary: '模型自己编的结论',
            keyPoints: [{ content: '要点', sourceChunkIndexes: [0] }],
            citations: [{ chunkId: 'chunk_1', pageNumber: 1, quote: '这句话不在原文里' }],
          }),
          modelName: 'test-model',
          inputTokens: 1,
          outputTokens: 1,
        }
      },
    }

    await expect(new SummaryAgent(llmClient).summarize(chunks)).rejects.toMatchObject({
      code: 'LLM_INVALID_RESPONSE',
    })
  })

  it('accepts a quote copied from the source chunk', async () => {
    const llmClient: LlmClient = {
      async complete(messages) {
        const payload = JSON.parse(messages[1]?.content ?? '{}') as { chunks: Array<{ content: string }> }
        const quote = payload.chunks[0]?.content.slice(0, 5) ?? ''
        return {
          content: JSON.stringify({
            title: '标题',
            summary: quote,
            keyPoints: [{ content: quote, sourceChunkIndexes: [0] }],
            citations: [{ chunkId: 'chunk_1', pageNumber: 1, quote }],
          }),
          modelName: 'test-model',
          inputTokens: 3,
          outputTokens: 2,
        }
      },
    }

    const draft = await new SummaryAgent(llmClient).summarize(chunks)
    expect(draft.summary).toBe('alpha')
    expect(draft.citations[0]).toEqual({ chunkId: 'chunk_1', pageNumber: 1, quote: 'alpha' })
    expect(draft.promptVersion).toBe('summary-v1')
  })
})
