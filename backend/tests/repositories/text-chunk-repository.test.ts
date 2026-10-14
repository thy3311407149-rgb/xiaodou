import { afterEach, describe, expect, it } from 'vitest'
import { TextChunkRepository } from '../../app/repositories/text-chunk-repository.js'
import { closeRepositoryTestDatabase, insertTestFile, openRepositoryTestDatabase } from '../repository-test-helper.js'

let directory = ''
afterEach(async () => closeRepositoryTestDatabase(directory))

describe('TextChunkRepository', () => {
  it('creates chunks in one transaction and reads them by chunk index', async () => {
    const context = await openRepositoryTestDatabase(); directory = context.directory; insertTestFile(context.database)
    const repository = new TextChunkRepository(context.database)
    repository.createMany([{ id: 'chunk_1', fileId: 'file_001', pageNumber: null, chunkIndex: 1, content: 'second', tokenCount: 2 }, { id: 'chunk_0', fileId: 'file_001', pageNumber: 1, chunkIndex: 0, content: 'first', tokenCount: 1 }])
    expect(repository.findByFileId('file_001').map((chunk) => chunk.chunkIndex)).toEqual([0, 1])
    expect(repository.findByFileId('file_001')[0].pageNumber).toBe(1)
    expect(() => repository.create({ id: 'duplicate', fileId: 'file_001', chunkIndex: 0, content: 'duplicate' })).toThrow()
    expect(repository.deleteByFileId('file_001')).toBe(2)
  })

  it('reads available chunks by id and skips deleted files and blank content', async () => {
    const context = await openRepositoryTestDatabase(); directory = context.directory; insertTestFile(context.database)
    context.database.prepare(`
      INSERT INTO files (id, file_name, file_type, file_size, storage_path, status)
      VALUES ('file_deleted', 'deleted.pdf', 'application/pdf', 10, 'uploads/file_deleted.pdf', 'DELETED')
    `).run()
    const repository = new TextChunkRepository(context.database)
    repository.createMany([
      { id: 'chunk_visible', fileId: 'file_001', pageNumber: 2, chunkIndex: 0, content: '预算已经确认' },
      { id: 'chunk_blank', fileId: 'file_001', pageNumber: 3, chunkIndex: 1, content: '   ' },
      { id: 'chunk_deleted', fileId: 'file_deleted', pageNumber: 1, chunkIndex: 0, content: '预算已经确认' },
    ])

    expect(repository.findByIds(['chunk_deleted', 'chunk_blank', 'chunk_visible', 'chunk_missing']).map((chunk) => chunk.id)).toEqual(['chunk_visible'])
    expect(repository.findByFileId('file_001').map((chunk) => chunk.id)).toEqual(['chunk_visible'])
    expect(repository.listAvailableChunks().map((chunk) => chunk.id)).toEqual(['chunk_visible'])
    expect(repository.searchByKeyword('预算', 1).map((chunk) => chunk.id)).toEqual(['chunk_visible'])
    expect(repository.searchByKeyword('  ', 5)).toEqual([])
    expect(repository.searchByKeyword('%_', 5)).toEqual([])
  })
})
