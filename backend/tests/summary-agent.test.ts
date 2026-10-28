import { describe, expect, it } from 'vitest'
import { SummaryAgent } from '../app/services/agent/summary-agent.js'
import type { LlmClient } from '../app/services/llm/llm-client.js'

const chunks = [{ chunkId: 'chunk_1', chunkIndex: 0, pageNumber: 1, content: 'alpha page one' }]

describe('SummaryAgent', () => {
  it('drops a citation that is not an excerpt and still returns the summary', async () => {
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

    const draft = await new SummaryAgent(llmClient).summarize(chunks)
    expect(draft.summary).toBe('模型自己编的结论')
    expect(draft.keyPoints).toEqual([{ content: '要点', sourceChunkIndexes: [0] }])
    expect(draft.citations).toEqual([])
  })

  it('keeps a complete summary when the model JSON is cut off', async () => {
    const llmClient: LlmClient = {
      async complete() {
        return {
          content: `{
            "title": "知识库说明",
            "summary": "文档说明了知识库首页和简报。",
            "keyPoints": [
              { "content": "每日执行一次关联分析", "sourceChunkIndexes": [0] },
              { "content": "这条被截断", "sourceChunkIndexes": [0
            ],
            "citations": [
              { "chunkId": "chunk_1", "pageNumber": 1, "quote": "alpha`,
          modelName: 'test-model',
          inputTokens: 10,
          outputTokens: 2048,
        }
      },
    }

    const draft = await new SummaryAgent(llmClient).summarize(chunks)
    expect(draft.title).toBe('知识库说明')
    expect(draft.summary).toBe('文档说明了知识库首页和简报。')
    expect(draft.keyPoints).toEqual([{ content: '每日执行一次关联分析', sourceChunkIndexes: [0] }])
    expect(draft.citations).toEqual([])
  })

  it('reads a JSON object wrapped in markdown', async () => {
    const llmClient: LlmClient = {
      async complete() {
        return {
          content: '结果如下：\n```json\n{"title":"标题","summary":"alpha","keyPoints":[],"citations":[]}\n```',
          modelName: 'test-model',
          inputTokens: 1,
          outputTokens: 1,
        }
      },
    }

    const draft = await new SummaryAgent(llmClient).summarize(chunks)
    expect(draft.title).toBe('标题')
    expect(draft.summary).toBe('alpha')
  })

  it('fails when the model response is not JSON', async () => {
    const llmClient: LlmClient = {
      async complete() {
        return { content: 'not-json', modelName: 'test-model', inputTokens: 1, outputTokens: 1 }
      },
    }

    await expect(new SummaryAgent(llmClient).summarize(chunks)).rejects.toMatchObject({
      code: 'LLM_INVALID_RESPONSE',
    })
  })

  it('accepts a quote copied from the source chunk', async () => {
    let systemPrompt = ''
    const llmClient: LlmClient = {
      async complete(messages) {
        systemPrompt = messages[0]?.content ?? ''
        const payload = JSON.parse(messages[1]?.content ?? '{}') as { chunks: Array<{ chunkId: string; content: string }> }
        const quote = payload.chunks[0]?.content.slice(0, 5) ?? ''
        return {
          content: JSON.stringify({
            title: '标题',
            summary: quote,
            keyPoints: [{ content: quote, sourceChunkIndexes: [0] }],
            citations: [{ chunkId: payload.chunks[0]?.chunkId, pageNumber: 1, quote }],
          }),
          modelName: 'test-model',
          inputTokens: 3,
          outputTokens: 2,
        }
      },
    }

    const draft = await new SummaryAgent(llmClient).summarize(chunks)
    expect(draft.title).toBe('标题')
    expect(draft.summary).toBe('alpha')
    expect(draft.keyPoints).toEqual([{ content: 'alpha', sourceChunkIndexes: [0] }])
    expect(draft.citations[0]).toEqual({ chunkId: 'chunk_1', pageNumber: 1, quote: 'alpha' })
    expect(draft.promptVersion).toBe('summary-v5')
    expect(systemPrompt).not.toContain('不超过 300 字')
    expect(systemPrompt).not.toContain('最多 5 条')
    expect(systemPrompt).not.toContain('不超过 80 字')
    expect(systemPrompt).not.toContain('不超过 40 个字符')
    expect(systemPrompt).toContain('summary 的值必须是 Markdown 正文')
    expect(systemPrompt).toContain('不要使用“一、”“二、”“1、”')
    expect(systemPrompt).toContain('核心结论或观点')
    expect(systemPrompt).toContain('关键事实数据')
    expect(systemPrompt).toContain('定义与概念')
    expect(systemPrompt).toContain('逻辑关系')
    expect(systemPrompt).toContain('重要清单或步骤')
    expect(systemPrompt).toContain('核心论据')
    expect(systemPrompt).toContain('不要为了凑数量生成')
  })

  it('keeps a key point when citations do not cover every source chunk', async () => {
    const llmClient: LlmClient = {
      async complete() {
        return {
          content: JSON.stringify({
            title: '标题',
            summary: 'alpha',
            keyPoints: [{ content: 'alpha', sourceChunkIndexes: [0, 1] }],
            citations: [{ chunkId: 'chunk_1', pageNumber: 1, quote: 'alpha' }],
          }),
          modelName: 'test-model',
          inputTokens: 1,
          outputTokens: 1,
        }
      },
    }

    const draft = await new SummaryAgent(llmClient).summarize([
      ...chunks,
      { chunkId: 'chunk_2', chunkIndex: 1, pageNumber: 2, content: 'beta page two' },
    ])
    expect(draft.keyPoints).toEqual([{ content: 'alpha', sourceChunkIndexes: [0, 1] }])
    expect(draft.citations).toEqual([{ chunkId: 'chunk_1', pageNumber: 1, quote: 'alpha' }])
  })

  it('saves a summary when the model finds no supported knowledge points', async () => {
    const llmClient: LlmClient = {
      async complete() {
        return {
          content: JSON.stringify({
            title: '文档',
            summary: '该文档共包含三页内容。',
            keyPoints: [],
            citations: [],
          }),
          modelName: 'test-model',
          inputTokens: 4,
          outputTokens: 3,
        }
      },
    }

    const draft = await new SummaryAgent(llmClient).summarize(chunks)
    expect(draft.summary).toBe('该文档共包含三页内容。')
    expect(draft.keyPoints).toEqual([])
    expect(draft.citations).toEqual([])
  })

  it('keeps page citations when the model finds no knowledge points', async () => {
    const llmClient: LlmClient = {
      async complete() {
        return {
          content: JSON.stringify({
            title: '文档',
            summary: '该文档共包含三页内容。',
            keyPoints: [],
            citations: [{ chunkId: 'chunk_1', pageNumber: 1, quote: 'alpha' }],
          }),
          modelName: 'test-model',
          inputTokens: 4,
          outputTokens: 3,
        }
      },
    }

    const draft = await new SummaryAgent(llmClient).summarize(chunks)
    expect(draft.keyPoints).toEqual([])
    expect(draft.citations).toEqual([{ chunkId: 'chunk_1', pageNumber: 1, quote: 'alpha' }])
  })

  it('keeps Markdown headings and lists in the summary without changing key points', async () => {
    const markdown = [
      '# 文档概览',
      '',
      '## 核心功能',
      '',
      '系统包含：',
      '',
      '- 文件上传',
      '- AI解析',
    ].join('\n')
    const llmClient: LlmClient = {
      async complete() {
        return {
          content: JSON.stringify({
            title: '文档概览',
            summary: markdown,
            keyPoints: [{ content: 'alpha', sourceChunkIndexes: [0] }],
            citations: [{ chunkId: 'chunk_1', pageNumber: 1, quote: 'alpha' }],
          }),
          modelName: 'test-model',
          inputTokens: 5,
          outputTokens: 4,
        }
      },
    }

    const draft = await new SummaryAgent(llmClient).summarize(chunks)
    expect(draft.summary).toContain('# 文档概览')
    expect(draft.summary).toContain('## 核心功能')
    expect(draft.summary).toContain('- 文件上传')
    expect(draft.keyPoints).toEqual([{ content: 'alpha', sourceChunkIndexes: [0] }])
    expect(draft.citations).toEqual([{ chunkId: 'chunk_1', pageNumber: 1, quote: 'alpha' }])
  })

  it('keeps a plain-text summary unchanged', async () => {
    const llmClient: LlmClient = {
      async complete() {
        return {
          content: JSON.stringify({
            title: '标题',
            summary: '核心功能：文件上传与解析。',
            keyPoints: [],
            citations: [],
          }),
          modelName: 'test-model',
          inputTokens: 2,
          outputTokens: 2,
        }
      },
    }

    const draft = await new SummaryAgent(llmClient).summarize(chunks)
    expect(draft.summary).toBe('核心功能：文件上传与解析。')
  })
})
