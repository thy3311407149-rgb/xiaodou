import { readFile } from 'node:fs/promises'
import type { ChunkSourcePage } from '../chunk/text-chunker.js'

type PdfTextItem = { str?: string }

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

async function loadPdfjs(): Promise<PdfjsLegacy> {
  const specifier = 'pdfjs-dist/legacy/build/pdf.mjs'
  return import(specifier) as Promise<PdfjsLegacy>
}

function readItemText(item: PdfTextItem): string {
  return typeof item.str === 'string' ? item.str : ''
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
        content: textContent.items.map((item) => readItemText(item)).join(''),
      })
      page.cleanup()
    }
    return pages
  } finally {
    await document.destroy()
  }
}
