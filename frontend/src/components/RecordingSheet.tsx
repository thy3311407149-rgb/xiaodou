import { useEffect, useRef, useState } from 'react'
import { fetchRecording, type RecordingDetail } from '../api/recordings.ts'
import { RECORDING_POLL_INTERVAL_MS } from '../recording/poll.ts'
import { durationSeconds, formatClock, formatRecordedAt } from '../recording/clock.ts'
import { PROCESS_UNAVAILABLE_MESSAGE } from '../recording/session.ts'
import { useRecordingSession } from '../recording/use-recording-session.ts'
import type { RecordingSessionOptions, RecordingView } from '../recording/session.ts'
import { RecordingControls } from './RecordingControls.tsx'
import { RecordingPlayer } from './RecordingPlayer.tsx'
import { RecordingResult } from './RecordingResult.tsx'
import { RecordingStatus } from './RecordingStatus.tsx'
import { TranscriptViewer } from './TranscriptViewer.tsx'

const LIVE = new Set(['requesting', 'recording', 'upload-error', 'finishing', 'processing'])

export function RecordingSheet({
  onClose,
  onUpdate,
  onStudio,
  sessionOptions,
}: {
  onClose: () => void
  onUpdate: (view: RecordingView) => void
  onStudio?: (open: boolean) => void
  sessionOptions?: Partial<Omit<RecordingSessionOptions, 'onChange'>>
}) {
  const session = useRecordingSession(sessionOptions)
  const startRef = useRef(session.start)
  const [seconds, setSeconds] = useState(0)
  const [open, setOpen] = useState(true)
  const [miniExpanded, setMiniExpanded] = useState(false)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [panel, setPanel] = useState<'tx' | 'ai'>('tx')
  const view = session.view
  const live = LIVE.has(view.phase)

  useEffect(() => {
    void startRef.current()
  }, [])

  useEffect(() => {
    if (view.phase !== 'recording' || view.paused || view.startedAtMs == null) return
    const startedAtMs = view.startedAtMs
    const pausedTotalMs = view.pausedTotalMs
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - startedAtMs - pausedTotalMs) / 1000)))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [view.phase, view.paused, view.startedAtMs, view.pausedTotalMs])

  useEffect(() => {
    if (view.recording) onUpdate(view)
  }, [onUpdate, view])

  useEffect(() => {
    onStudio?.(open && live)
  }, [live, onStudio, open])

  function leave(): void {
    if (live) {
      setOpen(false)
      setMiniExpanded(false)
      return
    }
    onClose()
  }

  const showReprocess = view.phase === 'failed' && view.recording?.status === 'ENDED'
  const listening = view.phase === 'recording' && !view.paused && !view.liveTranscriptUnavailable

  return (
    <>
      {open && (
        <div className="voice-studio open" role="dialog" aria-modal="true" aria-label="语音速记">
          <div className="vs-sheet">
            <header className="vs-nav">
              <button className="vs-back" type="button" aria-label="返回" onClick={leave}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6" /></svg>
              </button>
              <div className="vs-nav-title">语音速记</div>
              <button className="vs-min" type="button" aria-label="最小化" onClick={leave}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 12h12" /></svg>
              </button>
            </header>
            <RecordingStatus view={view} seconds={seconds} />
            <div className="vs-body">
              <div className="vs-tabs" role="tablist" aria-label="录音内容">
                <button className={`vs-tab ${panel === 'tx' ? 'on' : ''}`} type="button" role="tab" aria-selected={panel === 'tx'} onClick={() => setPanel('tx')}>实时转写</button>
                <button className={`vs-tab ${panel === 'ai' ? 'on' : ''}`} type="button" role="tab" aria-selected={panel === 'ai'} onClick={() => setPanel('ai')}>AI 总结<span className="vs-spark" aria-hidden="true">✦</span></button>
              </div>
              <div className="vs-panels">
                {panel === 'tx' ? (
                  <div className="vs-panel on" role="tabpanel">
                    {view.message && <p className="record-error" role="alert">{view.message}</p>}
                    <TranscriptViewer
                      segments={view.segments}
                      unavailable={view.liveTranscriptUnavailable}
                      audioSaved={view.audioSaved}
                      listening={listening}
                      paused={view.paused}
                    />
                  </div>
                ) : (
                  <div className="vs-panel on" role="tabpanel">
                    <RecordingResult
                      recording={view.recording}
                      knowledgePoints={view.knowledgePoints}
                      failed={view.phase === 'failed'}
                      processing={view.phase === 'processing' || view.phase === 'recording' || view.phase === 'finishing'}
                      task={view.task}
                      notice={view.message}
                    />
                  </div>
                )}
              </div>
            </div>
            <RecordingControls
              phase={view.phase}
              canPause={view.canPause}
              paused={view.paused}
              showReprocess={showReprocess}
              onPause={() => void session.pause()}
              onAskStop={() => setConfirmEnd(true)}
              onRetry={() => session.retryUpload()}
              onReprocess={() => void session.reprocess()}
              onStart={() => void session.start()}
            />
            {confirmEnd && (
              <div className="end-confirm open" role="dialog" aria-label="结束本次录音？">
                <div className="end-confirm-card">
                  <h3>结束本次录音？</h3>
                  <p>结束后将关联入库，并生成转写与 AI 总结。</p>
                  <div className="end-confirm-actions">
                    <button className="btn btn-ghost" type="button" onClick={() => setConfirmEnd(false)}>取消</button>
                    <button className="btn btn-danger" type="button" onClick={() => { setConfirmEnd(false); void session.stop() }}>结束并入库</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {!open && live && (
        <button
          className={`rec-mini show ${miniExpanded ? 'expanded' : ''}`}
          type="button"
          aria-label={miniExpanded ? '点按返回录音工作台' : '录音进行中，点按展开'}
          onClick={() => {
            if (!miniExpanded) {
              setMiniExpanded(true)
              return
            }
            setOpen(true)
          }}
        >
          <span className="rec-mini-ico" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" /><path d="M19 10v1a7 7 0 0 1-14 0v-1" /><path d="M12 18v3" /></svg>
            <span className="dot" />
          </span>
          <span className="rec-mini-detail">
            <span>{formatClock(seconds)}</span>
            <span>{view.phase === 'recording' && !view.paused ? '录音中' : view.paused ? '已暂停' : '处理中'}</span>
          </span>
        </button>
      )}
    </>
  )
}

export function RecordingDetail({ recordingId, onClose }: { recordingId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<RecordingDetail | null>(null)
  const [message, setMessage] = useState('')
  const [panel, setPanel] = useState<'tx' | 'ai'>('tx')

  useEffect(() => {
    let active = true
    let timer = 0
    const pull = () => {
      void fetchRecording(recordingId).then(
        (next) => {
          if (!active) return
          setDetail(next)
          setMessage('')
          const status = next.task?.status
          if (status === 'QUEUED' || status === 'RUNNING') timer = window.setTimeout(pull, RECORDING_POLL_INTERVAL_MS)
        },
        () => {
          if (!active) return
          setMessage('录音详情暂时无法读取')
        },
      )
    }
    pull()
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [recordingId])

  const taskStatus = detail?.task?.status
  const failed = taskStatus === 'FAILED' || detail?.recording.status === 'INTERRUPTED'
  const processing = taskStatus === 'QUEUED' || taskStatus === 'RUNNING' || detail?.recording.status === 'RECORDING' || detail?.recording.status === 'PAUSED' || detail?.recording.status === 'CREATED'
  const notice = detail?.task?.errorCode === 'ASR_UNAVAILABLE' || detail?.task?.errorCode === 'ASR_FAILED' || detail?.recording.errorCode === 'ASR_UNAVAILABLE'
    ? PROCESS_UNAVAILABLE_MESSAGE
    : detail?.task?.errorMessage || detail?.recording.errorMessage
  const seconds = detail ? durationSeconds(detail.recording.startedAt, detail.recording.endedAt) : null

  return (
    <div className="voice-detail" role="dialog" aria-label="录音详情">
      <div className="vd">
        <div className="vd-top">
          <div className="vd-nav">
            <button className="vd-back" type="button" aria-label="返回" onClick={onClose}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
            <div className="vd-title">{detail?.recording.title || '录音'}</div>
          </div>
          {detail && (
            <RecordingPlayer recordingId={recordingId} chunks={detail.chunks} durationSec={seconds} sampleRate={detail.recording.sampleRate} />
          )}
        </div>
        <div className="vd-sheet">
          <div className="vd-handle" aria-hidden="true" />
          <div className="vd-tabs" role="tablist">
            <button className={`vd-tab ${panel === 'tx' ? 'on' : ''}`} type="button" role="tab" aria-selected={panel === 'tx'} onClick={() => setPanel('tx')}>实时转写</button>
            <button className={`vd-tab ${panel === 'ai' ? 'on' : ''}`} type="button" role="tab" aria-selected={panel === 'ai'} onClick={() => setPanel('ai')}>AI总结</button>
          </div>
          <div className="vd-body">
            {message && <p className="record-error" role="alert">{message}</p>}
            {!detail && !message && <p className="record-note">正在读取录音</p>}
            {detail && (
              <div className="vd-meta">
                <div className="vd-meta-info">
                  {['录音时长', seconds == null ? null : formatClock(seconds), formatRecordedAt(detail.recording.createdAt)].filter(Boolean).join(' · ')}
                </div>
              </div>
            )}
            {detail && panel === 'tx' && (
              <TranscriptViewer segments={detail.segments} unavailable={detail.segments.length === 0} audioSaved={detail.chunks.length > 0} />
            )}
            {detail && panel === 'ai' && (
              <RecordingResult
                recording={detail.recording}
                knowledgePoints={failed ? [] : detail.knowledgePoints}
                failed={Boolean(failed)}
                processing={processing}
                task={detail.task}
                notice={notice}
                summary={detail.summary?.content}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
