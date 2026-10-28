import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanPdfText } from '../app/services/pdf/pdf-text-cleaner.js'
import { extractPdfPages } from '../app/services/pdf/pdf-text-extractor.js'
import { createLayoutPdf } from './pdf-fixture.js'

const chinesePdf = resolve('tests/fixtures/pdf/chinese.pdf')
const corruptPdf = resolve('tests/fixtures/pdf/corrupt.pdf')
const noTextPdf = resolve('tests/fixtures/pdf/no-text.pdf')
const realPdfCandidates = [
  resolve('tests/fixtures/pdf/beta1.2需求文档.pdf'),
]
const realPdf = realPdfCandidates.find((path) => existsSync(path))

let directory = ''

afterEach(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true })
    directory = ''
  }
})

describe('PDF text extraction', () => {
  it('keeps headings, numbered lines, and same-line runs in reading order', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xiaodou-pdf-layout-'))
    const pdfPath = join(directory, 'layout.pdf')
    await writeFile(pdfPath, createLayoutPdf([
      { text: '1. Overview', x: 72, y: 720, fontSize: 18 },
      { text: '1.1 Details', x: 72, y: 680, fontSize: 14 },
      { text: '1. ', x: 90, y: 664, fontSize: 12 },
      { text: 'First item', x: 108, y: 664, fontSize: 12 },
      { text: '- ', x: 90, y: 648, fontSize: 12 },
      { text: 'Second item', x: 102, y: 648, fontSize: 12 },
      { text: 'Alpha', x: 72, y: 632, fontSize: 12 },
      { text: 'Beta', x: 130, y: 632, fontSize: 12 },
      { text: 'Budget 2026: OK.', x: 72, y: 560, fontSize: 12 },
    ]))

    const [page] = await extractPdfPages(pdfPath)
    const content = cleanPdfText(page?.content ?? '')
    const lines = content.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)

    expect(content).toContain('\n')
    expect(lines[0]).toBe('1. Overview')
    expect(lines).toContain('1.1 Details')
    expect(lines).toContain('1. First item')
    expect(lines).toContain('- Second item')
    expect(lines).toContain('Alpha Beta')
    expect(content.indexOf('1. Overview')).toBeLessThan(content.indexOf('1.1 Details'))
    expect(content.indexOf('1.1 Details')).toBeLessThan(content.indexOf('1. First item'))
    expect(content.indexOf('1. First item')).toBeLessThan(content.indexOf('- Second item'))
    expect(content.indexOf('- Second item')).toBeLessThan(content.indexOf('Alpha Beta'))
    expect(content).toContain('Budget 2026: OK.')
    expect(content).not.toContain('Overview1.1')
    expect(content).not.toContain('AlphaBeta')
  })

  it('restores a newline between Chinese lines in the fixture PDF', async () => {
    const [page] = await extractPdfPages(chinesePdf)
    const content = cleanPdfText(page?.content ?? '')
    expect(content).toBe('你好，第二大脑\n这是中文 PDF 测试')
    expect(content).toContain('，')
    expect(content).toContain('PDF')
  })

  it('rejects a corrupt PDF and returns no text for a page without text', async () => {
    await expect(extractPdfPages(corruptPdf)).rejects.toThrow()
    const pages = await extractPdfPages(noTextPdf)
    expect(pages.length).toBeGreaterThan(0)
    expect(pages.every((page) => page.content.trim() === '')).toBe(true)
  })

  it.skipIf(!realPdf)('preserves line structure in the downloaded requirements PDF', async () => {
    const pages = await extractPdfPages(realPdf as string)
    const firstPage = cleanPdfText(pages[0]?.content ?? '')
    const secondPage = cleanPdfText(pages[1]?.content ?? '')

    expect(firstPage).toContain('\n')
    expect(firstPage).toMatch(/一、功能说明\n+1、\s*知识库首页/)
    expect(firstPage).not.toContain('功能说明1、')
    expect(firstPage).toContain('原型图：知识')
    expect(firstPage).toContain('库首页')
    expect(firstPage.indexOf('一、功能说明')).toBeLessThan(firstPage.indexOf('知识库首页'))
    expect(secondPage).toMatch(/• .+\n• /)
    expect(secondPage).toContain('7')
    expect(secondPage).toContain('MVP')
    expect(`${firstPage}\n${secondPage}`).toContain('，')
  })
})
