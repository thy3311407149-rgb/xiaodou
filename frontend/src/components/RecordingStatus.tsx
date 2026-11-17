import type { RecordingView } from '../recording/session.ts'
import { recordingStepText } from '../recording/task-label.ts'
import { formatClock } from '../recording/clock.ts'

const WAVE_HEIGHTS = [8, 14, 22, 12, 18, 10, 24, 16, 9, 20, 13, 19]

export function RecordingStatus({ view, seconds }: { view: RecordingView; seconds: number }) {
  const listening = view.phase === 'recording' && !view.paused
  const step = recordingStepText(view.task?.currentStep)
  const status = view.phase === 'requesting'
    ? '正在请求麦克风权限'
    : view.phase === 'recording'
      ? (view.paused ? '已暂停' : '正在录音')
      : view.phase === 'upload-error'
        ? '音频上传异常'
        : view.phase === 'finishing'
          ? '正在结束录音'
          : view.phase === 'processing'
            ? (step ?? '正在处理录音')
            : view.phase === 'done'
              ? '录音处理完成'
              : null
  return (
    <div className="vs-top">
      <div className="vs-center">
        <div className="vs-timer">{formatClock(seconds)}</div>
        <div className={`vs-spectrum ${listening ? '' : 'paused'}`} aria-hidden="true">
          {WAVE_HEIGHTS.map((height, index) => (
            <span className="vs-bar" key={height + index} style={{ ['--h' as string]: `${height}px`, ['--d' as string]: `${(index * 0.08).toFixed(2)}s` }} />
          ))}
        </div>
        {status && <p className="vs-status">{status}</p>}
        {view.phase === 'processing' && view.task && (
          <span className="progress vs-progress" role="progressbar" aria-valuenow={view.task.progress} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${Math.min(100, Math.max(0, view.task.progress))}%` }} />
          </span>
        )}
      </div>
    </div>
  )
}
