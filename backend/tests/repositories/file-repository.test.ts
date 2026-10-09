import { afterEach, describe, expect, it } from 'vitest'
import { FileRepository } from '../../app/repositories/file-repository.js'
import { closeRepositoryTestDatabase, openRepositoryTestDatabase } from '../repository-test-helper.js'

let directory = ''
afterEach(async () => closeRepositoryTestDatabase(directory))

describe('FileRepository', () => {
  it('creates, finds, lists, and updates files with camelCase mapping', async () => {
    const context = await openRepositoryTestDatabase(); directory = context.directory
    const repository = new FileRepository(context.database)
    const created = repository.create({ id: 'file_001', userId: 'user_001', fileName: 'one.pdf', fileType: 'application/pdf', fileSize: 42, storagePath: 'uploads/file_001.pdf', idempotencyKey: 'upload_001' })
    expect(created).toMatchObject({ id: 'file_001', userId: 'user_001', fileName: 'one.pdf', fileSize: 42, idempotencyKey: 'upload_001', status: 'CREATED' })
    expect(repository.findById('file_001')).toEqual(created)
    expect(repository.findByIdempotencyKey('upload_001')?.id).toBe('file_001')
    expect(repository.listByUser('user_001', 10, 0)).toHaveLength(1)
    expect(repository.listByUser('other_user', 10, 0)).toEqual([])
    expect(repository.update('file_001', { status: 'QUEUED', errorCode: null, errorMessage: null })?.status).toBe('QUEUED')
  })
})
