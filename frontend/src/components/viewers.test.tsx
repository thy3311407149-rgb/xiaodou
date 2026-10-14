/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentTextViewer } from './DocumentTextViewer.tsx'
import { PdfViewer } from './PdfViewer.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('document and pdf viewers', () => {
  it('renders parsed pages and keeps an error inside the text viewer', async () => {
    const load = vi.fn(async () => [
      { pageNumber: 1, content: '第一页正文' },
      { pageNumber: 2, content: '第二页正文' },
    ])
    const { unmount } = render(<DocumentTextViewer fileId="file_1" onClose={() => undefined} load={load} />)
    expect(await screen.findByText('第一页正文')).toBeTruthy()
    expect(screen.getByText('第2页')).toBeTruthy()
    unmount()

    render(<DocumentTextViewer fileId="file_1" onClose={() => undefined} load={async () => []} />)
    expect(await screen.findByText('暂无解析文本')).toBeTruthy()
    cleanup()

    render(<DocumentTextViewer fileId="file_1" onClose={() => undefined} load={async () => Promise.reject(new Error('offline'))} />)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '请求失败')
  })

  it('shows the pdf in an iframe and revokes the object url on close', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pdf')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const load = vi.fn(async () => new Blob(['%PDF'], { type: 'application/pdf' }))
    const { unmount } = render(<PdfViewer fileId="file_1" onClose={() => undefined} load={load} />)
    const frame = await screen.findByTitle('PDF原文')
    expect(frame.getAttribute('src')).toBe('blob:pdf')
    expect(load).toHaveBeenCalledWith('file_1')
    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:pdf')
    createObjectURL.mockRestore()
  })

  it('keeps an empty or unreadable pdf on the sheet instead of an iframe', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pdf')
    const { unmount } = render(<PdfViewer fileId="file_1" onClose={() => undefined} load={async () => new Blob([], { type: 'application/pdf' })} />)
    expect(await screen.findByText('暂无 PDF 原文')).toBeTruthy()
    expect(screen.queryByTitle('PDF原文')).toBeNull()
    unmount()

    render(<PdfViewer fileId="file_1" onClose={() => undefined} load={async () => new Blob(['not-a-pdf'], { type: 'application/pdf' })} />)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '无法打开 PDF')
    expect(screen.queryByTitle('PDF原文')).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
    createObjectURL.mockRestore()
  })
})