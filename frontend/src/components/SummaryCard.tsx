import { useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fetchFileDetail, type FileDetail } from '../api/files.ts'
import { summaryDisplayState, type FileSummary, type SummaryDisplayState, type SummaryResultState } from '../api/summaries.ts'

const visibleKeyPointLimit = 6

export function SummaryCard({
  fileName,
  state,
  summary,
}: {
  fileName: string
  state: SummaryDisplayState
  summary: FileSummary | null
}) {
  const points = summary && state === 'success' ? summary.keyPoints.slice(0, visibleKeyPointLimit) : []
  const citations = summary && state === 'success' ? summary.citations : []
  return (
    <section className="knowledge-detail" aria-label="AI摘要">
      <h3>AI 摘要</h3>
      <p className="summary-label">文档标题</p>
      <p className="summary-title">{fileName}</p>
      <p className="summary-label">整体概述</p>
      {state === 'loading' && <p className="knowledge-placeholder">正在读取摘要</p>}
      {state === 'empty' && <p className="knowledge-placeholder">AI正在理解文档...</p>}
      {state === 'error' && <p className="knowledge-placeholder" role="alert">文档理解失败，请重试</p>}
      {state === 'success' && summary && (
        <div className="summary-card">
          <Markdown remarkPlugins={[remarkGfm]}>{summary.content}</Markdown>
        </div>
      )}
      {points.length > 0 && (
        <div>
          <h3>核心知识点</h3>
          <ol className="summary-points">
            {points.map((content, index) => (
              <li key={`${content}-${index}`}>
                <b>{String(index + 1).padStart(2, '0')}</b>
                <span>{content}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {citations.length > 0 && (
        <div>
          <h3>来源</h3>
          <ul className="summary-cites">
            {citations.map((citation, index) => (
              <li key={`${citation.chunkId}-${index}`}>
                {citation.pageNumber != null && <b>第{citation.pageNumber}页</b>}
                {citation.quote && <span>{citation.quote}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

export function FileSummary({
  fileId,
  fileName,
  load = fetchFileDetail,
}: {
  fileId: string | null
  fileName: string
  load?: (fileId: string) => Promise<FileDetail>
}) {
  const [loaded, setLoaded] = useState<{ fileId: string; title: string; state: SummaryResultState; summary: FileSummary | null } | null>(null)

  useEffect(() => {
    if (!fileId) return
    let active = true
    load(fileId).then(
      (detail) => {
        if (!active) return
        setLoaded({ fileId, title: detail.file.fileName || fileName, state: summaryDisplayState(detail), summary: detail.summary })
      },
      () => {
        if (!active) return
        setLoaded({ fileId, title: fileName, state: 'error', summary: null })
      },
    )
    return () => {
      active = false
    }
  }, [fileId, fileName, load])

  const current = loaded?.fileId === fileId ? loaded : null
  const state: SummaryDisplayState = !fileId ? 'empty' : current?.state ?? 'loading'
  return <SummaryCard fileName={current?.title || fileName} state={state} summary={current?.summary ?? null} />
}
