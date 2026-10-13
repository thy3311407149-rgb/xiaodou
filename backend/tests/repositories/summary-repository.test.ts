import { afterEach, describe, expect, it } from 'vitest'
import { SummaryRepository } from '../../app/repositories/summary-repository.js'
import { closeRepositoryTestDatabase, insertTestFile, insertTestTask, openRepositoryTestDatabase } from '../repository-test-helper.js'

let directory = ''
afterEach(async () => closeRepositoryTestDatabase(directory))

describe('SummaryRepository', () => {
  it('allows multiple summaries for one file but only one per task', async () => {
    const context = await openRepositoryTestDatabase(); directory = context.directory; insertTestFile(context.database); insertTestTask(context.database, 'task_001', 'file_001'); context.database.prepare("UPDATE tasks SET status = 'FAILED' WHERE id = 'task_001'").run(); insertTestTask(context.database, 'task_002', 'file_001')
    const repository = new SummaryRepository(context.database)
    const first = repository.create({ id: 'summary_001', fileId: 'file_001', taskId: 'task_001', content: 'first', keyPoints: [{ content: 'one', sourceChunkIndexes: [0] }], citations: [{ chunkId: 'chunk_001', pageNumber: 1, quote: 'quote' }], modelName: 'model-a', promptVersion: 'summary-v1' })
    const second = repository.create({ id: 'summary_002', fileId: 'file_001', taskId: 'task_002', content: 'second', keyPoints: [{ content: 'two', sourceChunkIndexes: [1] }], citations: [], modelName: 'model-a', promptVersion: 'summary-v1' })
    expect(repository.listByFileId('file_001')).toHaveLength(2)
    expect(repository.findLatestByFileId('file_001')?.id).toBe(second.id)
    expect(first.keyPoints).toEqual([{ content: 'one', sourceChunkIndexes: [0] }])
    expect(first.citations[0].chunkId).toBe('chunk_001')
    expect(() => repository.create({ ...first, id: 'summary_duplicate' })).toThrow()
  })

  it('throws when stored JSON is invalid', async () => {
    const context = await openRepositoryTestDatabase(); directory = context.directory; insertTestFile(context.database); insertTestTask(context.database, 'task_001', 'file_001')
    context.database.prepare("INSERT INTO summaries (id, file_id, task_id, content, key_points, citations, model_name, prompt_version) VALUES ('summary_001', 'file_001', 'task_001', 'bad', 'not-json', '[]', 'model', 'prompt')").run()
    const repository = new SummaryRepository(context.database)
    expect(() => repository.findById('summary_001')).toThrow(/Invalid JSON in summaries.key_points/)
  })
})
