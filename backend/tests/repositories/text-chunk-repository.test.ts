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
})
