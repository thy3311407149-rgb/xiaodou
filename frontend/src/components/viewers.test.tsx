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
    expect(screen.getByText('第一页正文').tagName).toBe('P')
    expect(screen.getByText('第2页')).toBeTruthy()
    unmount()

    const structured = render(<DocumentTextViewer fileId="file_1" onClose={() => undefined} load={async () => [{
      pageNumber: 3,
      content: [
        '第一章 认知负荷',
        '一、基本概念',
        '正文里出现一、和 1.1，不应成为标题。',
        '• 组块',
        '# 不是标题',
      ].join('\n'),
    }]} />)
    expect(await screen.findByRole('heading', { level: 4, name: '第一章 认知负荷' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 5, name: '一、基本概念' })).toBeTruthy()
    expect(screen.getByText('第3页').tagName).toBe('H3')
    expect(screen.getByText('正文里出现一、和 1.1，不应成为标题。').tagName).toBe('P')
    expect(screen.getByText('• 组块').closest('li')).toBeTruthy()
    expect(screen.getByText('# 不是标题').tagName).toBe('P')
    expect(screen.queryByRole('heading', { name: '不是标题' })).toBeNull()
    structured.unmount()

    const flat = render(<DocumentTextViewer fileId="file_1" onClose={() => undefined} load={async () => [{
      pageNumber: 4,
      content: '手册3第一章 概述1.1. 系统简介依据调查制度开发建设，具有自动采集功能。',
    }]} />)
    expect(await screen.findByRole('heading', { level: 4, name: '第一章 概述' })).toBeTruthy()
    expect(screen.getByText('1.1. 系统简介依据调查制度开发建设，具有自动采集功能。').tagName).toBe('P')
    expect(screen.getByText('手册3').tagName).toBe('P')
    flat.unmount()

    render(<DocumentTextViewer fileId="file_1" onClose={() => undefined} load={async () => []} />)
    expect(await screen.findByText('暂无解析文本')).toBeTruthy()
    cleanup()

    render(<DocumentTextViewer fileId="file_1" onClose={() => undefined} load={async () => Promise.reject(new Error('offline'))} />)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '请求失败')
  })

  it('paints pdf pages on a white sheet instead of a plugin frame', async () => {
    const paint = vi.fn(async (_blob: Blob, host: HTMLElement) => {
      const canvas = document.createElement('canvas')
      canvas.className = 'pdf-page'
      host.appendChild(canvas)
      return 1
    })
    const load = vi.fn(async () => new Blob(['%PDF'], { type: 'application/pdf' }))
    const { unmount } = render(<PdfViewer fileId="file_1" onClose={() => undefined} load={load} paint={paint} />)
    expect(await screen.findByRole('dialog', { name: 'PDF原文' })).toBeTruthy()
    expect(document.querySelector('.pdf-page')).toBeTruthy()
    expect(document.querySelector('iframe')).toBeNull()
    expect(load).toHaveBeenCalledWith('file_1')
    unmount()
    expect(document.querySelector('.pdf-page')).toBeNull()
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