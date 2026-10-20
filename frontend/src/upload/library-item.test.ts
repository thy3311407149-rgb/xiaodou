import { describe, expect, it } from 'vitest'
import { libraryItemFromUpload, withTask } from './library-item.ts'
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

  it('does not decode or repair a file name returned by the server', () => {
    const stored = 'ä½¿ç¨æå.pdf'
    const item = libraryItemFromUpload(uploaded(stored))
    expect(item.title).toBe(stored)
    expect(withTask(item, task({ status: 'SUCCEEDED', currentStep: 'COMPLETED', progress: 100 })).title).toBe(stored)
  })
})
