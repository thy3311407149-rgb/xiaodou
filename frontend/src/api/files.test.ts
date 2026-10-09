import { describe, expect, it, vi } from 'vitest'
import { createHttp } from './http.ts'
import { uploadPdf } from './files.ts'
import { fetchTask } from './tasks.ts'

const taskBody = {
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
}

describe('file and task client', () => {
  it('posts multipart file to /api/files and reads the contract task id', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/files')
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('X-Request-Id')).toBeTruthy()
      const form = init?.body as FormData
      expect(form.get('file')).toBeInstanceOf(File)
      return new Response(JSON.stringify({
        requestId: 'req_upload',
        data: { file: { id: 'file_1', fileName: 'paper.pdf', status: 'UPLOADED' }, task: taskBody },
      }), { status: 201 })
    })
    const client = createHttp(fetchImpl as typeof fetch)
    const uploaded = await uploadPdf(new File([new Uint8Array([1])], 'paper.pdf', { type: 'application/pdf' }), client.request)
    expect(uploaded).toMatchObject({ fileId: 'file_1', fileName: 'paper.pdf', task: { id: 'task_1', status: 'QUEUED' } })
  })

  it('does not treat a 201 without a task as success', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      requestId: 'req_upload',
      data: { file: { id: 'file_1', status: 'UPLOADED' } },
    }), { status: 201 }))
    const client = createHttp(fetchImpl as typeof fetch)
    await expect(uploadPdf(new File([new Uint8Array([1])], 'paper.pdf'), client.request)).rejects.toThrow('请求失败')
  })

  it('shows error.message and falls back when the body is empty', async () => {
    const denied = createHttp(vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'INVALID_FILE_TYPE', message: '文件类型无效', requestId: 'req_denied' },
    }), { status: 400 })) as typeof fetch)
    await expect(uploadPdf(new File([new Uint8Array([1])], 'paper.pdf'), denied.request)).rejects.toThrow('文件类型无效')

    const empty = createHttp(vi.fn(async () => new Response(null, { status: 500 })) as typeof fetch)
    await expect(uploadPdf(new File([new Uint8Array([1])], 'paper.pdf'), empty.request)).rejects.toThrow('请求失败')
  })

  it('loads GET /api/tasks/:taskId from the contract envelope', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/tasks/task_1')
      expect(new Headers(init?.headers).get('X-Request-Id')).toBeTruthy()
      return new Response(JSON.stringify({ requestId: 'req_task', data: { task: taskBody } }), { status: 200 })
    })
    const client = createHttp(fetchImpl as typeof fetch)
    await expect(fetchTask('task_1', client.request)).resolves.toMatchObject({ id: 'task_1', status: 'QUEUED', progress: 0 })
  })
})
