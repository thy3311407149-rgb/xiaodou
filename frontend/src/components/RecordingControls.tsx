import type { RecordingPhase } from '../recording/session.ts'

export function RecordingControls({
  phase,
  canPause,
  paused,
  onPause,
  onAskStop,
  onRetry,
  onReprocess,
  onStart,
  showReprocess,
}: {
  phase: RecordingPhase
  canPause: boolean
  paused: boolean
  onPause: () => void
  onAskStop: () => void
  onRetry: () => void
  onReprocess: () => void
  onStart: () => void
  showReprocess: boolean
}) {
  if (phase === 'failed') {
    return (
      <div className="vs-dock vs-dock-text">
        {showReprocess && <button className="btn btn-ghost" type="button" onClick={onReprocess}>重新处理</button>}
        <button className="btn btn-primary" type="button" onClick={onStart}>重试</button>
      </div>
    )
  }
  if (phase !== 'recording' && phase !== 'upload-error') return null
  return (
    <div className="vs-dock">
      {phase === 'upload-error' && <button className="btn btn-ghost vs-retry" type="button" onClick={onRetry}>重试上传</button>}
      <button className="vs-end" type="button" aria-label="结束并关联入库" onClick={onAskStop}>
        <span className="vs-end-ico" aria-hidden="true"><span /></span>
      </button>
      {canPause && (
        <button className="vs-pause" type="button" aria-label={paused ? '继续' : '暂停'} onClick={onPause}>
          {paused
            ? <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
            : <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>}
        </button>
      )}
    </div>
  )
}
