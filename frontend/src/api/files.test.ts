import { describe, expect, it, vi } from 'vitest'
import { createHttp } from './http.ts'
import { fetchFileDetail, fetchStoredFiles, uploadPdf } from './files.ts'
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

  it('keeps a Chinese fileName from the upload response without decoding it', async () => {
    const fileName = '全国公共机构节约能源资源综合信息平台用户使用手册.pdf'
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData
      expect((form.get('file') as File).name).toBe(fileName)
      return new Response(JSON.stringify({
        requestId: 'req_upload',
        data: { file: { id: 'file_1', fileName, status: 'UPLOADED' }, task: taskBody },
      }), { status: 201 })
    })
    const client = createHttp(fetchImpl as typeof fetch)
    const uploaded = await uploadPdf(new File([new Uint8Array([1])], fileName, { type: 'application/pdf' }), client.request)
    expect(uploaded.fileName).toBe(fileName)
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

  it('loads every saved file page from GET /api/files', async () => {
    const pages = [
      [{ id: 'file_1', fileName: '讲义.pdf', status: 'COMPLETED', errorMessage: null, createdAt: '2026-10-20T01:20:00.000Z' }],
      Array.from({ length: 100 }, (_, index) => ({ id: `file_${index}`, fileName: `资料${index}.pdf`, status: 'COMPLETED', errorMessage: null, createdAt: '2026-10-19T01:00:00.000Z' })),
    ]
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const page = new URL(String(input), 'http://localhost').searchParams.get('page')
      const items = page === '1' ? pages[1] : pages[0]
      return new Response(JSON.stringify({ requestId: 'req_list', data: { items, page: Number(page), pageSize: 100, total: items.length } }), { status: 200 })
    })
    const client = createHttp(fetchImpl as typeof fetch)
    const files = await fetchStoredFiles(client.request)
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('/api/files?page=1&pageSize=100')
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe('/api/files?page=2&pageSize=100')
    expect(files[0]?.fileName).toBe('资料0.pdf')
    expect(files.at(-1)?.fileName).toBe('讲义.pdf')
    expect(files).toHaveLength(101)
  })

  it('loads GET /api/files/:fileId with file, task, and summary', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/files/file_1')
      expect(new Headers(init?.headers).get('X-Request-Id')).toBeTruthy()
      return new Response(JSON.stringify({
        requestId: 'req_detail',
        data: {
          file: { id: 'file_1', fileName: 'paper.pdf', status: 'COMPLETED' },
          task: { ...taskBody, status: 'SUCCEEDED', currentStep: 'COMPLETED', progress: 100 },
          summary: {
            id: 'summary_1',
            fileId: 'file_1',
            taskId: 'task_1',
            content: '工作记忆容量有限。',
            keyPoints: [{ content: '外在负荷可以降低', sourceChunkIndexes: [0] }],
            citations: [{ chunkId: 'chunk_1', pageNumber: 1, quote: '留空' }],
          },
        },
      }), { status: 200 })
    })
    const client = createHttp(fetchImpl as typeof fetch)
    await expect(fetchFileDetail('file_1', client.request)).resolves.toMatchObject({
      file: { fileName: 'paper.pdf' },
      summary: { content: '工作记忆容量有限。', keyPoints: ['外在负荷可以降低'] },
    })
  })
})
