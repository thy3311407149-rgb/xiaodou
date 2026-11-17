import type { TranscriptSegment } from '../api/recordings.ts'
import { AUDIO_SAVED_MESSAGE, LIVE_TRANSCRIPT_UNAVAILABLE_MESSAGE } from '../recording/session.ts'
import { formatClock } from '../recording/clock.ts'

function stamp(ms: number): string {
  return formatClock(Math.floor(ms / 1000))
}

export function TranscriptViewer({
  segments,
  unavailable,
  audioSaved,
  listening,
  paused,
}: {
  segments: TranscriptSegment[]
  unavailable: boolean
  audioSaved: boolean
  listening?: boolean
  paused?: boolean
}) {
  if (segments.length === 0) {
    const hint = unavailable
      ? null
      : listening
        ? '正在聆听…'
        : paused
          ? '等待语音…'
          : null
    return (
      <div className="vs-stream">
        {audioSaved && <p className="vs-stream-empty">{AUDIO_SAVED_MESSAGE}</p>}
        {unavailable && <p className="vs-stream-empty">{LIVE_TRANSCRIPT_UNAVAILABLE_MESSAGE}</p>}
        {hint && (
          <div className="vs-stream-empty">
            {hint}
            {listening && <span className="vs-cursor" aria-hidden="true" />}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className={`vs-stream ${paused ? 'is-paused' : ''}`}>
      {segments.map((segment, index) => (
        <div className={`vs-seg ${index === segments.length - 1 && listening ? 'is-live' : ''}`} key={segment.id}>
          <div className="vs-seg-meta">
            {segment.speakerId && <span className="vs-seg-who">{segment.speakerId}</span>}
            <span className="vs-seg-t">{stamp(segment.startTimeMs)}</span>
          </div>
          <p className="vs-seg-txt">
            {segment.content}
            {listening && index === segments.length - 1 && <span className="vs-cursor" aria-hidden="true" />}
          </p>
        </div>
      ))}
    </div>
  )
}
