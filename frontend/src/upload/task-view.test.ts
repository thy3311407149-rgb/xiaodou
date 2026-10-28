import { describe, expect, it } from 'vitest'
import { PROCESS_FAILED_MESSAGE, mapTaskView } from './task-view.ts'
import type { TaskSnapshot } from './task.ts'

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

describe('mapTaskView', () => {
  it('maps queued and running to processing and keeps the server progress', () => {
    expect(mapTaskView(task({ status: 'QUEUED', currentStep: 'EXTRACT_TEXT', progress: 0 }))).toEqual({
      phase: 'processing',
      label: '处理中',
      detail: '提取文本',
      progress: 0,
    })
    expect(mapTaskView(task({ status: 'RUNNING', currentStep: 'CREATE_CHUNKS', progress: 37 }))).toMatchObject({
      phase: 'processing',
      label: '处理中',
      detail: '切分片段',
      progress: 37,
    })
  })

  it('maps succeeded and failed from the task status, including the phase 8.1 parser message', () => {
    expect(mapTaskView(task({ status: 'SUCCEEDED', progress: 100 })).label).toBe('处理完成')
    expect(mapTaskView(task({
      status: 'FAILED',
      errorCode: 'TASK_EXECUTION_FAILED',
      errorMessage: 'PDF 解析尚未接入',
      progress: 0,
    }))).toEqual({
      phase: 'failed',
      label: '失败',
      detail: 'PDF 解析尚未接入',
      progress: 0,
    })
    expect(mapTaskView(task({ status: 'FAILED', errorMessage: '   ' })).detail).toBe(PROCESS_FAILED_MESSAGE)
  })
})
