type PdfViewport = { width: number; height: number }

type PdfPage = {
  getViewport: (params: { scale: number }) => PdfViewport
  render: (params: { canvas: HTMLCanvasElement; viewport: PdfViewport }) => { promise: Promise<void> }
}

type PdfDocument = {
  numPages: number
  getPage: (pageNumber: number) => Promise<PdfPage>
  cleanup: () => Promise<void>
}

type PdfjsModule = {
  getDocument: (source: { data: Uint8Array }) => { promise: Promise<PdfDocument> }
  GlobalWorkerOptions: { workerSrc: string }
}

let workerConfigured = false

async function loadPdfjs(): Promise<PdfjsModule> {
  const pdfjs = await import('pdfjs-dist') as unknown as PdfjsModule
  if (!workerConfigured) {
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default
    workerConfigured = true
  }
  return pdfjs
}

function nextPaintToken(host: HTMLElement): string {
  const token = String(Number(host.dataset.paintToken || 0) + 1)
  host.dataset.paintToken = token
  return token
}

export async function paintPdf(blob: Blob, host: HTMLElement): Promise<number> {
  const token = nextPaintToken(host)
  const pdfjs = await loadPdfjs()
  const data = new Uint8Array(await blob.arrayBuffer())
  const pdf = await pdfjs.getDocument({ data }).promise
  try {
    if (host.dataset.paintToken !== token) return 0
    host.replaceChildren()
    const cssWidth = Math.max(host.clientWidth, 280)
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (!host.isConnected || host.dataset.paintToken !== token) return pageNumber - 1
      const page = await pdf.getPage(pageNumber)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: (cssWidth / base.width) * pixelRatio })
      const canvas = document.createElement('canvas')
      canvas.className = 'pdf-page'
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      canvas.style.width = `${cssWidth}px`
      canvas.style.height = `${(base.height * cssWidth) / base.width}px`
      const context = canvas.getContext('2d')
      if (!context) throw new Error('canvas')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvas, viewport }).promise
      if (host.dataset.paintToken !== token) return pageNumber - 1
      host.appendChild(canvas)
    }
    return pdf.numPages
  } finally {
    await pdf.cleanup()
  }
}
