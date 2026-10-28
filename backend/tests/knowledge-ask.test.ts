import type Database from 'better-sqlite3'
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createKnowledgeRouter } from '../app/api/knowledge.js'
import { errorHandler } from '../app/core/errors/error-handler.js'
import { requestIdMiddleware } from '../app/core/request-id-middleware.js'
import { requestLoggingMiddleware } from '../app/core/request-logging-middleware.js'
import type { FileStatus } from '../app/models/file.js'
import { TextChunkRepository } from '../app/repositories/text-chunk-repository.js'
import { KnowledgeAskService } from '../app/services/knowledge/knowledge-ask-service.js'
import { KnowledgeRetrievalService } from '../app/services/knowledge/knowledge-retrieval-service.js'
import type { LlmClient } from '../app/services/llm/llm-client.js'
import { closeRepositoryTestDatabase, openRepositoryTestDatabase } from './repository-test-helper.js'

let directory = ''

afterEach(async () => {
  if (directory) {
    await closeRepositoryTestDatabase(directory)
    directory = ''
  }
})

function insertFile(database: Database.Database, id: string, status: FileStatus): void {
  database.prepare(`
    INSERT INTO files (id, file_name, file_type, file_size, storage_path, status)
    VALUES (?, ?, 'application/pdf', 10, ?, ?)
  `).run(id, `${id}.pdf`, `uploads/${id}.pdf`, status)
}

async function createAskApp(llmClient: LlmClient) {
  const databaseContext = await openRepositoryTestDatabase()
  directory = databaseContext.directory
  const textChunkRepository = new TextChunkRepository(databaseContext.database)
  const retrievalService = new KnowledgeRetrievalService(textChunkRepository)
  const app = express()
  app.use(express.json())
  app.use(requestIdMiddleware)
  app.use(requestLoggingMiddleware)
  app.use(createKnowledgeRouter({
    retrievalService,
    askService: new KnowledgeAskService(retrievalService, llmClient),
  }))
  app.use(errorHandler)
  return { app, database: databaseContext.database, textChunkRepository }
}

describe('knowledge ask', () => {
  it('answers from a matching chunk and returns that chunk as the source', async () => {
    let called = false
    const context = await createAskApp({
      async complete() {
        called = true
        return {
          content: JSON.stringify({ answer: '本季度预算已经确认。' }),
          modelName: 'test-model',
          inputTokens: 8,
          outputTokens: 6,
        }
      },
    })
    insertFile(context.database, 'file_budget', 'COMPLETED')
    context.textChunkRepository.create({
      id: 'chunk_budget',
      fileId: 'file_budget',
      pageNumber: 2,
      chunkIndex: 0,
      content: '本季度预算已经确认',
    })

    const response = await request(context.app)
      .post('/api/knowledge/ask')
      .set('X-Request-Id', 'req_ask_match')
      .send({ query: '预算' })

    expect(called).toBe(true)
    expect(response.status).toBe(200)
    expect(response.body.requestId).toBe('req_ask_match')
    expect(response.body.data.answer).toBe('本季度预算已经确认。')
    expect(response.body.data.sources).toEqual([
      { fileId: 'file_budget', pageNumber: 2, quote: '本季度预算已经确认' },
    ])
    expect(response.body.data.sources[0].quote).toContain('预算')
  })

  it('returns an empty answer and no sources when nothing matches', async () => {
    const context = await createAskApp({
      async complete() {
        throw new Error('llm should not be called')
      },
    })
    insertFile(context.database, 'file_budget', 'COMPLETED')
    context.textChunkRepository.create({
      id: 'chunk_budget',
      fileId: 'file_budget',
      pageNumber: 1,
      chunkIndex: 0,
      content: '本季度预算已经确认',
    })

    const response = await request(context.app).post('/api/knowledge/ask').send({ query: '不存在的词' })

    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({ answer: '', sources: [] })
  })
})
