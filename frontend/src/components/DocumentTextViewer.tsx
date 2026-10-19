import { useEffect, useState } from 'react'
import { getDocumentText, type DocumentPage } from '../api/document-text.ts'
import { ApiError, REQUEST_FAILED_MESSAGE } from '../api/http.ts'
import { formatDocumentText, type DocumentBlock, type DocumentHeadingLevel } from '../utils/document-text-formatter.ts'

type TextState = 'loading' | 'success' | 'empty' | 'error'

const headingTag: Record<DocumentHeadingLevel, 'h4' | 'h5' | 'h6'> = {
  1: 'h4',
  2: 'h5',
  3: 'h6',
}

function DocumentBlocks({ blocks }: { blocks: DocumentBlock[] }) {
  if (blocks.length === 0) return null
  return (
    <div className="document-body">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const Tag = headingTag[block.level]
          return <Tag key={index} className={`doc-heading doc-heading-${block.level}`}>{block.text}</Tag>
        }
        if (block.type === 'list') {
          return (
            <ul key={index} className="doc-list">
              {block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}
            </ul>
          )
        }
        return <p key={index}>{block.text}</p>
      })}
    </div>
  )
}

export function DocumentTextViewer({
  fileId,
  onClose,
  load = getDocumentText,
}: {
  fileId: string | null
  onClose: () => void
  load?: (fileId: string) => Promise<DocumentPage[]>
}) {
  const [state, setState] = useState<TextState>(fileId ? 'loading' : 'error')
  const [pages, setPages] = useState<DocumentPage[]>([])
  const [message, setMessage] = useState(REQUEST_FAILED_MESSAGE)

  useEffect(() => {
    if (!fileId) return
    let active = true
    load(fileId).then(
      (next) => {
        if (!active) return
        setPages(next)
        setState(next.length === 0 ? 'empty' : 'success')
      },
      (error: unknown) => {
        if (!active) return
        setMessage(error instanceof ApiError ? error.message : REQUEST_FAILED_MESSAGE)
        setState('error')
      },
    )
    return () => {
      active = false
    }
  }, [fileId, load])

  return (
    <div className="overlay viewer-sheet" role="dialog" aria-modal="true" aria-label="完整解析">
      <div className="sheet" onClick={(event) => event.stopPropagation()}>
        <button className="back-row" type="button" onClick={onClose}>关闭</button>
        <h2>完整解析</h2>
        {state === 'loading' && <p className="knowledge-placeholder">正在读取解析文本</p>}
        {state === 'empty' && <p className="knowledge-placeholder">暂无解析文本</p>}
        {state === 'error' && <p className="knowledge-placeholder" role="alert">{message}</p>}
        {state === 'success' && pages.map((page) => (
          <section key={page.pageNumber} className="document-page">
            <h3>第{page.pageNumber}页</h3>
            <DocumentBlocks blocks={formatDocumentText(page.content)} />
          </section>
        ))}
      </div>
    </div>
  )
}
