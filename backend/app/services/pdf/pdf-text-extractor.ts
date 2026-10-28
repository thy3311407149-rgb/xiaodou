import { readFile } from 'node:fs/promises'
import type { ChunkSourcePage } from '../chunk/text-chunker.js'

type PdfTextItem = {
  str?: string
  dir?: string
  transform?: unknown
  width?: number
  height?: number
  hasEOL?: boolean
}

type PdfPage = {
  getTextContent: () => Promise<{ items: PdfTextItem[] }>
  cleanup: () => void
}

type PdfDocument = {
  numPages: number
  getPage: (pageNumber: number) => Promise<PdfPage>
  destroy: () => Promise<void>
}

type PdfjsLegacy = {
  getDocument: (source: {
    data: Uint8Array
    disableWorker?: boolean
    isEvalSupported?: boolean
    verbosity?: number
  }) => { promise: Promise<PdfDocument> }
}

type TextPosition = {
  x: number
  y: number
  width: number
  fontSize: number
}

type PositionedText = {
  text: string
  position: TextPosition | null
  hasEOL: boolean
}

type TextLine = {
  items: PositionedText[]
  y: number
  fontSize: number
}

const SAME_LINE_RATIO = 0.45
const SPACE_GAP_RATIO = 0.3
const PARAGRAPH_GAP_RATIO = 1.85

async function loadPdfjs(): Promise<PdfjsLegacy> {
  const specifier = 'pdfjs-dist/legacy/build/pdf.mjs'
  return import(specifier) as Promise<PdfjsLegacy>
}

function readItemText(item: PdfTextItem): string {
  return typeof item.str === 'string' ? item.str : ''
}

function readPosition(item: PdfTextItem): TextPosition | null {
  if (!Array.isArray(item.transform) || item.transform.length < 6) return null
  const x = Number(item.transform[4])
  const y = Number(item.transform[5])
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const width = Number(item.width)
  const height = Number(item.height)
  const scaleX = Number(item.transform[0])
  const skewY = Number(item.transform[1])
  const fontFromMatrix = Math.hypot(Number.isFinite(scaleX) ? scaleX : 0, Number.isFinite(skewY) ? skewY : 0)
  const fontSize = height > 0 ? height : fontFromMatrix
  return {
    x,
    y,
    width: Number.isFinite(width) && width > 0 ? width : 0,
    fontSize: fontSize > 0 ? fontSize : 0,
  }
}

function joinByEndOfLine(items: readonly PdfTextItem[]): string {
  let text = ''
  for (const item of items) {
    text += readItemText(item)
    if (item.hasEOL) text += '\n'
  }
  return text.replace(/\n+$/g, '')
}

function groupLines(items: readonly PositionedText[]): TextLine[] {
  const lines: TextLine[] = []
  let current: TextLine | null = null

  const flush = (): void => {
    if (current && current.items.length > 0) lines.push(current)
    current = null
  }

  for (const item of items) {
    if (item.text.length === 0) {
      if (item.hasEOL) flush()
      continue
    }
    if (!item.position) {
      current ??= { items: [], y: 0, fontSize: 0 }
      current.items.push(item)
      if (item.hasEOL) flush()
      continue
    }
    const fontSize = item.position.fontSize
    if (!current) {
      current = { items: [item], y: item.position.y, fontSize }
      if (item.hasEOL) flush()
      continue
    }
    const baselineFont = current.fontSize > 0 ? current.fontSize : fontSize
    const tolerance = Math.max(1.5, Math.min(baselineFont || fontSize || 1, fontSize || baselineFont || 1) * SAME_LINE_RATIO)
    if (Math.abs(item.position.y - current.y) > tolerance) {
      flush()
      current = { items: [item], y: item.position.y, fontSize }
    } else {
      current.items.push(item)
      current.fontSize = Math.max(current.fontSize, fontSize)
    }
    if (item.hasEOL) flush()
  }
  flush()
  return lines
}

function needsSpace(previous: PositionedText, next: PositionedText): boolean {
  if (!previous.position || !next.position) return false
  if (/\s$/.test(previous.text) || /^\s/.test(next.text)) return false
  if (next.position.x + 0.5 < previous.position.x) return false
  const gap = next.position.x - (previous.position.x + previous.position.width)
  const fontSize = Math.max(previous.position.fontSize, next.position.fontSize, 1)
  return gap > fontSize * SPACE_GAP_RATIO
}

function joinLine(items: readonly PositionedText[]): string {
  let text = ''
  items.forEach((item, index) => {
    if (index > 0 && needsSpace(items[index - 1] as PositionedText, item)) text += ' '
    text += item.text
  })
  return text.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/g, '')
}

function joinLines(lines: readonly TextLine[]): string {
  const rendered = lines
    .map((line) => ({
      text: joinLine(line.items).trimEnd(),
      y: line.y,
      fontSize: line.fontSize,
    }))
    .filter((line) => line.text.trim().length > 0)

  let result = ''
  rendered.forEach((line, index) => {
    if (index > 0) {
      const previous = rendered[index - 1] as { y: number; fontSize: number }
      const delta = previous.y - line.y
      const scale = Math.max(previous.fontSize, line.fontSize, 1)
      result += delta < 0 || delta > scale * PARAGRAPH_GAP_RATIO ? '\n\n' : '\n'
    }
    result += line.text.trim()
  })
  return result
}

function composePageText(items: readonly PdfTextItem[]): string {
  const textItems = items.filter((item) => typeof item.str === 'string')
  if (textItems.length === 0) return ''
  if (textItems.some((item) => item.dir === 'ttb')) return joinByEndOfLine(textItems)

  const positioned = textItems.map((item) => ({
    text: readItemText(item),
    position: readPosition(item),
    hasEOL: item.hasEOL === true,
  }))
  const hasPosition = positioned.some((item) => item.position !== null && item.text.length > 0)
  if (!hasPosition) return joinByEndOfLine(textItems)
  return joinLines(groupLines(positioned))
}

export async function extractPdfPages(absolutePath: string): Promise<ChunkSourcePage[]> {
  const pdfjs = await loadPdfjs()
  const data = new Uint8Array(await readFile(absolutePath))
  const document = await pdfjs.getDocument({
    data,
    disableWorker: true,
    isEvalSupported: false,
    verbosity: 0,
  }).promise

  try {
    const pages: ChunkSourcePage[] = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const textContent = await page.getTextContent()
      pages.push({
        pageNumber,
        content: composePageText(textContent.items),
      })
      page.cleanup()
    }
    return pages
  } finally {
    await document.destroy()
  }
}
