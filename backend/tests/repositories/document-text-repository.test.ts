import { afterEach, describe, expect, it } from 'vitest'
import { DocumentTextRepository } from '../../app/repositories/document-text-repository.js'
import { closeRepositoryTestDatabase, insertTestFile, openRepositoryTestDatabase } from '../repository-test-helper.js'

let directory = ''
afterEach(async () => closeRepositoryTestDatabase(directory))

describe('DocumentTextRepository', () => {
  it('creates pages in one transaction and reads them by page number', async () => {
    const context = await openRepositoryTestDatabase(); directory = context.directory; insertTestFile(context.database)
    const repository = new DocumentTextRepository(context.database)
    const texts = repository.createMany([{ id: 'page_2', fileId: 'file_001', pageNumber: 2, content: 'second' }, { id: 'page_1', fileId: 'file_001', pageNumber: 1, content: 'first' }])
    expect(texts).toHaveLength(2)
    expect(repository.findByFileId('file_001').map((text) => text.pageNumber)).toEqual([1, 2])
    expect(() => repository.create({ id: 'duplicate', fileId: 'file_001', pageNumber: 1, content: 'duplicate' })).toThrow()
    expect(repository.deleteByFileId('file_001')).toBe(2)
  })
})
