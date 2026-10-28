import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDF_MAX_BYTES } from './pdf-file.ts'
import type { TaskSnapshot, UploadedPdf } from './task.ts'
import { stopAllTaskPolling } from './task-poller.ts'
import { createUploadSession, type UploadListener } from './upload-session.ts'

function task(id: string, status: TaskSnapshot['status']): TaskSnapshot {
  return {
    id,
    fileId: `file-${id}`,
    taskType: 'PROCESS_PDF',
    status,
    currentStep: 'EXTRACT_TEXT',
    progress: 0,
    errorCode: status === 'FAILED' ? 'TASK_EXECUTION_FAILED' : null,
    errorMessage: status === 'FAILED' ? 'PDF 解析尚未接入' : null,
    startedAt: null,
    finishedAt: null,
  }
}

function uploaded(id: string, status: TaskSnapshot['status'] = 'QUEUED'): UploadedPdf {
  return { fileId: `file-${id}`, fileName: `${id}.pdf`, task: task(id, status) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function listener(partial: Partial<UploadListener> = {}): UploadListener {
  return {
    onRejected: () => undefined,
    onUploadFailed: () => undefined,
    onAccepted: () => undefined,
    onTask: () => undefined,
    onPollFailed: () => undefined,
    ...partial,
  }
}

afterEach(() => {
  stopAllTaskPolling()
})

describe('createUploadSession', () => {
  it('does not call upload for a non-pdf or an oversized file', async () => {
    const upload = vi.fn(async () => uploaded('task_1'))
    const rejected: string[] = []
    const session = createUploadSession({
      upload,
      getTask: vi.fn(),
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (id) => clearTimeout(id),
      listener: listener({ onRejected: (message) => rejected.push(message) }),
    })

    await session.submit({ name: 'notes.txt', size: 10 } as File)
    await session.submit({ name: 'large.pdf', size: PDF_MAX_BYTES + 1 } as File)

    expect(upload).not.toHaveBeenCalled()
    expect(rejected).toEqual(['文件类型无效', '文件超过大小限制'])
    session.dispose()
  })

  it('discards a stale upload response after a newer file is selected', async () => {
    const uploads = [deferred<UploadedPdf>(), deferred<UploadedPdf>()]
    let uploadIndex = 0
    const upload = vi.fn(() => uploads[uploadIndex++]!.promise)
    const polls = [deferred<TaskSnapshot>(), deferred<TaskSnapshot>()]
    let pollIndex = 0
    const getTask = vi.fn(() => polls[pollIndex++]!.promise)
    const accepted: string[] = []
    const session = createUploadSession({
      upload,
      getTask,
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (id) => clearTimeout(id),
      listener: listener({ onAccepted: (next) => accepted.push(next.task.id) }),
    })

    const firstSubmit = session.submit(new File([new Uint8Array([1])], 'a.pdf'))
    const secondSubmit = session.submit(new File([new Uint8Array([1])], 'b.pdf'))
    uploads[0]?.resolve(uploaded('task-a'))
    uploads[1]?.resolve(uploaded('task-b'))
    await firstSubmit
    await secondSubmit

    expect(accepted).toEqual(['task-b'])
    expect(getTask).toHaveBeenCalledTimes(1)
    expect(getTask).toHaveBeenCalledWith('task-b')
    session.dispose()
  })

  it('drops a late poll from the task that was replaced', async () => {
    const secondUpload = deferred<UploadedPdf>()
    const upload = vi.fn()
      .mockImplementationOnce(async () => uploaded('task-a'))
      .mockImplementationOnce(() => secondUpload.promise)
    const polls = [deferred<TaskSnapshot>(), deferred<TaskSnapshot>()]
    let pollIndex = 0
    const getTask = vi.fn(() => polls[pollIndex++]!.promise)
    const seen: string[] = []
    const session = createUploadSession({
      upload,
      getTask,
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (id) => clearTimeout(id),
      listener: listener({ onTask: (next) => seen.push(`${next.id}:${next.status}`) }),
    })

    await session.submit(new File([new Uint8Array([1])], 'a.pdf'))
    const replaced = session.submit(new File([new Uint8Array([1])], 'b.pdf'))
    polls[0]?.resolve(task('task-a', 'SUCCEEDED'))
    secondUpload.resolve(uploaded('task-b'))
    await replaced
    polls[1]?.resolve(task('task-b', 'RUNNING'))
    await Promise.resolve()
    await Promise.resolve()

    expect(seen).toEqual(['task-b:RUNNING'])
    session.dispose()
  })
})
