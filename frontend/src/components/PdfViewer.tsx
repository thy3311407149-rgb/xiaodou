import { useEffect, useRef, useState } from 'react'
import { getPdfContent } from '../api/files.ts'
import { ApiError, REQUEST_FAILED_MESSAGE } from '../api/http.ts'
import { paintPdf } from './paint-pdf.ts'

type PdfState = 'loading' | 'success' | 'empty' | 'error'

const EMPTY_PDF_MESSAGE = '暂无 PDF 原文'
const UNREADABLE_PDF_MESSAGE = '无法打开 PDF'

async function pdfBlobKind(blob: Blob): Promise<'ok' | 'empty' | 'invalid'> {
  if (blob.size === 0) return 'empty'
  const bytes = new Uint8Array(await blob.slice(0, 1024).arrayBuffer())
  const header = new TextDecoder().decode(bytes)
  return header.includes('%PDF') ? 'ok' : 'invalid'
}

export function PdfViewer({
  fileId,
  onClose,
  load = getPdfContent,
  paint = paintPdf,
}: {
  fileId: string | null
  onClose: () => void
  load?: (fileId: string) => Promise<Blob>
  paint?: (blob: Blob, host: HTMLElement) => Promise<number>
}) {
  const pagesRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<PdfState>(fileId ? 'loading' : 'error')
  const [message, setMessage] = useState(REQUEST_FAILED_MESSAGE)

  useEffect(() => {
    if (!fileId) return
    const host = pagesRef.current
    let active = true
    load(fileId).then(
      async (blob) => {
        try {
          if (!active) return
          const kind = await pdfBlobKind(blob)
          if (!active) return
          if (kind === 'empty') {
            setState('empty')
            return
          }
          if (kind === 'invalid') {
            setMessage(UNREADABLE_PDF_MESSAGE)
            setState('error')
            return
          }
          if (!host) return
          const pageCount = await paint(blob, host)
          if (!active) return
          setState(pageCount > 0 ? 'success' : 'empty')
        } catch {
          if (!active) return
          setMessage(UNREADABLE_PDF_MESSAGE)
          setState('error')
        }
      },
      (error: unknown) => {
        if (!active) return
        setMessage(error instanceof ApiError ? error.message : REQUEST_FAILED_MESSAGE)
        setState('error')
      },
    )
    return () => {
      active = false
      if (host) host.dataset.paintToken = String(Number(host.dataset.paintToken || 0) + 1)
      host?.replaceChildren()
    }
  }, [fileId, load, paint])

  return (
    <div className="overlay viewer-sheet" role="dialog" aria-modal="true" aria-label="PDF原文">
      <div className="sheet pdf-sheet" onClick={(event) => event.stopPropagation()}>
        <button className="back-row" type="button" onClick={onClose}>关闭</button>
        <h2>PDF 原文</h2>
        <div className="pdf-stage">
          {state === 'loading' && <p className="knowledge-placeholder">正在打开 PDF</p>}
          {state === 'empty' && <p className="knowledge-placeholder">{EMPTY_PDF_MESSAGE}</p>}
          {state === 'error' && <p className="knowledge-placeholder" role="alert">{message}</p>}
          <div ref={pagesRef} className="pdf-pages" />
        </div>
      </div>
    </div>
  )
}
