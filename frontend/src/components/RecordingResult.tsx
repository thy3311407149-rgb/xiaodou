import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { KnowledgePoint, Recording, RecordingStatus, RecordingTask } from '../api/recordings.ts'
import { durationSeconds, formatClock } from '../recording/clock.ts'
import { recordingStepText } from '../recording/task-label.ts'
import { PROCESS_UNAVAILABLE_MESSAGE } from '../recording/session.ts'

const STATUS_LABEL: Record<RecordingStatus, string> = {
  CREATED: '未开始',
  RECORDING: '录音中',
  PAUSED: '已暂停',
  INTERRUPTED: '已中断',
  ENDED: '已结束',
  DELETED: '已删除',
}

export function RecordingResult({
  recording,
  knowledgePoints,
  failed,
  processing,
  task,
  notice,
  summary,
}: {
  recording: Recording | null
  knowledgePoints: KnowledgePoint[]
  failed: boolean
  processing?: boolean
  task?: RecordingTask | null
  notice?: string | null
  summary?: string | null
}) {
  const seconds = recording ? durationSeconds(recording.startedAt, recording.endedAt) : null
  const step = recordingStepText(task?.currentStep)
  const badge = failed
    ? '暂不可用'
    : processing
      ? (step ?? '提取中')
      : knowledgePoints.length > 0
        ? `已提炼 ${knowledgePoints.length} 条`
        : '提取中'
  return (
    <div className="vs-ai-card">
      <div className="vs-ai-head">
        <span className="vs-ai-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" /></svg>
        </span>
        <b>AI 提炼</b>
        <span className="vs-ai-badge">{badge}</span>
      </div>
      {recording && (
        <p className="record-note">{[recording.title, STATUS_LABEL[recording.status], seconds == null ? null : formatClock(seconds)].filter(Boolean).join(' · ')}</p>
      )}
      {failed && <p className="vs-point is-empty">{notice || PROCESS_UNAVAILABLE_MESSAGE}</p>}
      {!failed && summary && (
        <div className="record-note">
          <Markdown remarkPlugins={[remarkGfm]}>{summary}</Markdown>
        </div>
      )}
      {!failed && knowledgePoints.length > 0 && (
        <div className="vs-points">
          {knowledgePoints.map((point) => <div className="vs-point" key={point.id}>{point.content}</div>)}
        </div>
      )}
      {!failed && knowledgePoints.length === 0 && (
        <p className="vs-point is-empty">{processing || !recording ? '等待提炼…' : '接口没有返回知识点'}</p>
      )}
    </div>
  )
}
