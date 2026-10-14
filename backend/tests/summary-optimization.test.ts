import { afterEach, describe, expect, it } from 'vitest'
import type { Task } from '../app/models/task.js'
import { OperationLogRepository } from '../app/repositories/operation-log-repository.js'
import { SummaryRepository } from '../app/repositories/summary-repository.js'
import type { LlmClient } from '../app/services/llm/llm-client.js'
import { OperationLogger } from '../app/services/operation-logger.js'
import { preserveSummaryContent, SummaryService } from '../app/services/summary-service.js'
import { MAX_SUMMARY_CHUNKS, selectSummaryContext } from '../app/services/summary/context-selector.js'
import type { SummaryChunkInput } from '../app/services/agent/summary-agent.js'
import { closeRepositoryTestDatabase, insertTestTask, openRepositoryTestDatabase } from './repository-test-helper.js'

let directory = ''

afterEach(async () => {
  if (directory) {
    await closeRepositoryTestDatabase(directory)
    directory = ''
  }
})

const task = {
  id: 'task_long',
  fileId: 'file_long',
  requestId: 'req_long',
} as Task

function buildChunks(count: number, contentLength = 12): SummaryChunkInput[] {
  return Array.from({ length: count }, (_, index) => ({
    chunkId: `chunk_${index}`,
    chunkIndex: index,
    pageNumber: index + 1,
    content: `${index}`.padEnd(contentLength, '预算'),
  }))
}

describe('summary optimization', () => {
  it('samples a long document down to the chunk and token limits', () => {
    const selected = selectSummaryContext(buildChunks(30))
    expect(selected.length).toBeLessThanOrEqual(MAX_SUMMARY_CHUNKS)
    expect(selected[0]?.chunkIndex).toBe(0)
    expect(selected.at(-1)?.chunkIndex).toBe(29)
    expect(selected.map((chunk) => chunk.pageNumber)).toEqual([...new Set(selected.map((chunk) => chunk.pageNumber))])

    const oversized = selectSummaryContext(buildChunks(3, 9000))
    expect(oversized.length).toBeLessThan(3)
    expect(oversized[0]?.chunkIndex).toBe(0)
    expect(oversized.at(-1)?.chunkIndex).toBe(2)
  })

  it('sends only the selected chunks to the model', async () => {
    const context = await openRepositoryTestDatabase()
    directory = context.directory
    let receivedIndexes: number[] = []
    const llmClient: LlmClient = {
      async complete(messages) {
        const payload = JSON.parse(messages[1]?.content ?? '{}') as { chunks: Array<{ chunkIndex: number }> }
        receivedIndexes = payload.chunks.map((chunk) => chunk.chunkIndex)
        return {
          content: JSON.stringify({ title: '长文档', summary: '预算说明', keyPoints: [], citations: [] }),
          modelName: 'test-model',
          inputTokens: 10,
          outputTokens: 4,
        }
      },
    }
    const service = new SummaryService({
      llmClient,
      summaryRepository: new SummaryRepository(context.database),
      operationLogger: new OperationLogger(new OperationLogRepository(context.database)),
    })

    const draft = await service.generate(task, buildChunks(30))

    expect(receivedIndexes.length).toBeLessThanOrEqual(MAX_SUMMARY_CHUNKS)
    expect(receivedIndexes[0]).toBe(0)
    expect(receivedIndexes.at(-1)).toBe(29)
    expect(draft.summary).toBe('预算说明')
  })

  it('saves a summary whose key points and citations are empty', async () => {
    const context = await openRepositoryTestDatabase()
    directory = context.directory
    context.database.prepare(`
      INSERT INTO files (id, file_name, file_type, file_size, storage_path, status)
      VALUES ('file_long', 'long.pdf', 'application/pdf', 10, 'uploads/file_long.pdf', 'SUMMARIZING')
    `).run()
    insertTestTask(context.database, 'task_long', 'file_long', 'req_long')
    const repository = new SummaryRepository(context.database)
    const service = new SummaryService({
      llmClient: { async complete() { throw new Error('unused') } },
      summaryRepository: repository,
      operationLogger: new OperationLogger(new OperationLogRepository(context.database)),
    })

    const saved = service.save(task, {
      title: '长文档',
      summary: '预算说明',
      keyPoints: [],
      citations: [],
      modelName: 'test-model',
      promptVersion: 'summary-v3',
      inputTokens: 10,
      outputTokens: 4,
    })

    expect(saved.keyPoints).toEqual([])
    expect(saved.citations).toEqual([])
    expect(repository.findByTaskId('task_long')?.content).toBe('预算说明')
  })

  it('saves Markdown headings and lists without changing key points or citations', async () => {
    const context = await openRepositoryTestDatabase()
    directory = context.directory
    context.database.prepare(`
      INSERT INTO files (id, file_name, file_type, file_size, storage_path, status)
      VALUES ('file_long', 'long.pdf', 'application/pdf', 10, 'uploads/file_long.pdf', 'SUMMARIZING')
    `).run()
    insertTestTask(context.database, 'task_long', 'file_long', 'req_long')
    const repository = new SummaryRepository(context.database)
    const service = new SummaryService({
      llmClient: { async complete() { throw new Error('unused') } },
      summaryRepository: repository,
      operationLogger: new OperationLogger(new OperationLogRepository(context.database)),
    })
    const markdown = '# 文档概览\n\n\n## 核心功能\n\n- 文件上传'
    const keyPoints = [{ content: 'alpha', sourceChunkIndexes: [0] }]
    const citations = [{ chunkId: 'chunk_1', pageNumber: 1, quote: 'alpha' }]

    const saved = service.save(task, {
      title: '文档概览',
      summary: markdown,
      keyPoints,
      citations,
      modelName: 'test-model',
      promptVersion: 'summary-v4',
      inputTokens: 5,
      outputTokens: 4,
    })

    expect(saved.content).toBe('# 文档概览\n\n## 核心功能\n\n- 文件上传')
    expect(saved.content).toContain('#')
    expect(saved.content).toContain('##')
    expect(saved.content).toContain('-')
    expect(saved.keyPoints).toEqual(keyPoints)
    expect(saved.citations).toEqual(citations)
    expect(preserveSummaryContent('核心功能：文件上传。')).toBe('核心功能：文件上传。')
  })
})
