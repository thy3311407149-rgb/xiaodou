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
import { KnowledgeRetrievalService } from '../app/services/knowledge/knowledge-retrieval-service.js'
import { closeRepositoryTestDatabase, openRepositoryTestDatabase } from './repository-test-helper.js'

let directory = ''

afterEach(async () => {
  if (directory) {
    await closeRepositoryTestDatabase(directory)
    directory = ''
  }
})

async function createSearchContext() {
  const databaseContext = await openRepositoryTestDatabase()
  directory = databaseContext.directory
  const textChunkRepository = new TextChunkRepository(databaseContext.database)
  const app = express()
  app.use(express.json())
  app.use(requestIdMiddleware)
  app.use(requestLoggingMiddleware)
  app.use(createKnowledgeRouter({ retrievalService: new KnowledgeRetrievalService(textChunkRepository) }))
  app.use(errorHandler)
  return { app, database: databaseContext.database, textChunkRepository }
}

function insertFile(database: Database.Database, id: string, status: FileStatus): void {
  database.prepare(`
    INSERT INTO files (id, file_name, file_type, file_size, storage_path, status)
    VALUES (?, ?, 'application/pdf', 10, ?, ?)
  `).run(id, `${id}.pdf`, `uploads/${id}.pdf`, status)
}

describe('knowledge search', () => {
  it('returns the chunk that contains the keyword', async () => {
    const context = await createSearchContext()
    insertFile(context.database, 'file_budget', 'COMPLETED')
    context.textChunkRepository.create({
      id: 'chunk_budget',
      fileId: 'file_budget',
      pageNumber: 2,
      chunkIndex: 0,
      content: '本季度预算已经确认',
    })

    const response = await request(context.app)
      .post('/api/knowledge/search')
      .set('X-Request-Id', 'req_knowledge_match')
      .send({ query: '预算' })

    expect(response.status).toBe(200)
    expect(response.body.requestId).toBe('req_knowledge_match')
    expect(response.body.data.chunks).toEqual([
      { chunkId: 'chunk_budget', fileId: 'file_budget', pageNumber: 2, content: '本季度预算已经确认' },
    ])
  })

  it('returns an empty array when nothing matches', async () => {
    const context = await createSearchContext()
    insertFile(context.database, 'file_budget', 'COMPLETED')
    context.textChunkRepository.create({
      id: 'chunk_budget',
      fileId: 'file_budget',
      pageNumber: 1,
      chunkIndex: 0,
      content: '本季度预算已经确认',
    })

    const response = await request(context.app).post('/api/knowledge/search').send({ query: '不存在的词' })

    expect(response.status).toBe(200)
    expect(response.body.data.chunks).toEqual([])
  })

  it('returns chunks from more than one file', async () => {
    const context = await createSearchContext()
    insertFile(context.database, 'file_plan', 'COMPLETED')
    insertFile(context.database, 'file_report', 'EXTRACTED')
    context.textChunkRepository.createMany([
      { id: 'chunk_plan', fileId: 'file_plan', pageNumber: 1, chunkIndex: 0, content: '项目里程碑在三月' },
      { id: 'chunk_report', fileId: 'file_report', pageNumber: 4, chunkIndex: 0, content: '报告里的里程碑已经完成' },
    ])

    const response = await request(context.app).post('/api/knowledge/search').send({ query: '里程碑' })

    expect(response.status).toBe(200)
    expect(response.body.data.chunks).toHaveLength(2)
    expect(response.body.data.chunks).toEqual(expect.arrayContaining([
      { chunkId: 'chunk_plan', fileId: 'file_plan', pageNumber: 1, content: '项目里程碑在三月' },
      { chunkId: 'chunk_report', fileId: 'file_report', pageNumber: 4, content: '报告里的里程碑已经完成' },
    ]))
  })

  it('does not search chunks that belong to a deleted file', async () => {
    const context = await createSearchContext()
    insertFile(context.database, 'file_deleted', 'DELETED')
    context.textChunkRepository.create({
      id: 'chunk_deleted',
      fileId: 'file_deleted',
      pageNumber: 1,
      chunkIndex: 0,
      content: '归档关键词只存在于已删除文件',
    })

    const response = await request(context.app).post('/api/knowledge/search').send({ query: '归档关键词' })

    expect(response.status).toBe(200)
    expect(response.body.data.chunks).toEqual([])
  })

  it('does not return a blank chunk', async () => {
    const context = await createSearchContext()
    insertFile(context.database, 'file_notes', 'COMPLETED')
    context.textChunkRepository.createMany([
      { id: 'chunk_blank', fileId: 'file_notes', pageNumber: 1, chunkIndex: 0, content: '   ' },
      { id: 'chunk_visible', fileId: 'file_notes', pageNumber: 2, chunkIndex: 1, content: '可见正文包含检索词' },
    ])

    const response = await request(context.app).post('/api/knowledge/search').send({ query: '检索词' })

    expect(response.status).toBe(200)
    expect(response.body.data.chunks).toEqual([
      { chunkId: 'chunk_visible', fileId: 'file_notes', pageNumber: 2, content: '可见正文包含检索词' },
    ])
  })
})
