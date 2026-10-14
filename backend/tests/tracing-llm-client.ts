import type { LlmClient, LlmMessage } from '../app/services/llm/llm-client.js'

type PromptChunk = {
  chunkId: string
  chunkIndex: number
  pageNumber: number | null
  content: string
}

export function createTracingLlmClient(): LlmClient {
  return {
    async complete(messages: readonly LlmMessage[]) {
      const userMessage = messages.find((message) => message.role === 'user')
      const payload = JSON.parse(userMessage?.content ?? '{}') as { chunks?: PromptChunk[] }
      const chunk = payload.chunks?.[0]
      if (!chunk || chunk.content.length === 0) {
        throw new Error('tracing client received no chunk text')
      }
      const quote = chunk.content.slice(0, Math.min(chunk.content.length, 12))
      return {
        content: JSON.stringify({
          title: '文档摘要',
          summary: quote,
          keyPoints: [{ content: quote, sourceChunkIndexes: [chunk.chunkIndex] }],
          citations: [{ chunkId: chunk.chunkId, pageNumber: chunk.pageNumber, quote }],
        }),
        modelName: 'test-model',
        inputTokens: 12,
        outputTokens: 8,
      }
    },
  }
}
