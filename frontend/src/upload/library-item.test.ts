import { describe, expect, it } from 'vitest'
import { libraryItemFromStoredFile, libraryItemFromUpload, mergeStoredFiles, withTask } from './library-item.ts'
import type { TaskSnapshot, UploadedPdf } from './task.ts'

const fileName = '全国公共机构节约能源资源综合信息平台用户使用手册.pdf'

function task(overrides: Partial<TaskSnapshot>): TaskSnapshot {
  return {
    id: 'task_1',
    fileId: 'file_1',
    taskType: 'PROCESS_PDF',
    status: 'QUEUED',
    currentStep: 'EXTRACT_TEXT',
    progress: 0,
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  }
}

function uploaded(name = fileName): UploadedPdf {
  return { fileId: 'file_1', fileName: name, task: task({ status: 'QUEUED' }) }
}

describe('library file name', () => {
  it('keeps the upload file name through success and failure', () => {
    const item = libraryItemFromUpload(uploaded())
    expect(item.title).toBe(fileName)

    const done = withTask(item, task({ status: 'SUCCEEDED', currentStep: 'COMPLETED', progress: 100 }))
    expect(done.title).toBe(fileName)
    expect(done.upload?.label).toBe('处理完成')

    const failed = withTask(item, task({ status: 'FAILED', errorMessage: 'PDF 文本提取失败' }))
    expect(failed.title).toBe(fileName)
    expect(failed.upload?.label).toBe('失败')
  })

  it('restores a saved file into the library with its stored name and status', () => {
    const now = new Date(2026, 9, 20, 18, 2, 0)
    const completed = libraryItemFromStoredFile({
      id: 'file_1',
      fileName,
      status: 'COMPLETED',
      errorMessage: null,
      createdAt: new Date(2026, 9, 20, 9, 20, 0).toISOString(),
    }, now)
    expect(completed.title).toBe(fileName)
    expect(completed.upload).toMatchObject({ fileId: 'file_1', taskId: null, phase: 'succeeded', label: '处理完成' })
    expect(completed.time).toBe('今天 09:20')
    expect(completed.ready).toBe(true)

    const failed = libraryItemFromStoredFile({
      id: 'file_2',
      fileName: '计划书.pdf',
      status: 'SUMMARY_FAILED',
      errorMessage: '没有可摘要的文本',
      createdAt: new Date(2026, 9, 19, 8, 0, 0).toISOString(),
    }, now)
    expect(failed.upload).toMatchObject({ phase: 'failed', label: '失败', detail: '没有可摘要的文本' })
    expect(failed.time).toBe('昨天 08:00')

    const processing = libraryItemFromStoredFile({
      id: 'file_3',
      fileName: '讲义.pdf',
      status: 'EXTRACTING',
      errorMessage: null,
      createdAt: new Date(2026, 8, 2, 12, 0, 0).toISOString(),
    }, now)
    expect(processing.upload?.label).toBe('处理中')
    expect(processing.time).toBe('9月2日')
  })

  it('puts saved files ahead of the current page and keeps an in-progress upload', () => {
    const saved = libraryItemFromStoredFile({
      id: 'file_1',
      fileName,
      status: 'UPLOADED',
      errorMessage: null,
      createdAt: new Date(2026, 9, 20, 9, 20, 0).toISOString(),
    })
    const live = libraryItemFromUpload(uploaded())
    const note = { id: 'n1', upload: undefined }
    expect(mergeStoredFiles([note, live], [saved]).map((item) => item.id)).toEqual(['file_1', 'n1'])
    expect(mergeStoredFiles([note, live], [saved])[0]).toBe(live)
  })

  it('does not decode or repair a file name returned by the server', () => {
    const stored = 'ä½¿ç¨æå.pdf'
    const item = libraryItemFromUpload(uploaded(stored))
    expect(item.title).toBe(stored)
    expect(withTask(item, task({ status: 'SUCCEEDED', currentStep: 'COMPLETED', progress: 100 })).title).toBe(stored)
  })
})
