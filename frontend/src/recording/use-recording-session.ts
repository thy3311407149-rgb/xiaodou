import { useEffect, useRef, useState } from 'react'
import { http } from '../api/http.ts'
import { browserRecordingClock, browserRecordingMedia } from './browser-media.ts'
import { RecordingSession, type RecordingSessionOptions, type RecordingView } from './session.ts'

const idle: RecordingView = {
  phase: 'idle',
  message: null,
  mimeType: null,
  browserSampleRate: null,
  savedChunks: 0,
  segments: [],
  liveTranscriptUnavailable: false,
  audioSaved: false,
  recording: null,
  knowledgePoints: [],
  task: null,
  startedAtMs: null,
  paused: false,
  pausedAtMs: null,
  pausedTotalMs: 0,
  canPause: false,
}

export function useRecordingSession(overrides: Partial<Omit<RecordingSessionOptions, 'onChange'>> = {}) {
  const [view, setView] = useState<RecordingView>(idle)
  const sessionRef = useRef<RecordingSession | null>(null)
  const overridesRef = useRef(overrides)

  useEffect(() => {
    const options = overridesRef.current
    const session = new RecordingSession({
      request: options.request ?? http.request,
      media: options.media ?? browserRecordingMedia(),
      clock: options.clock ?? browserRecordingClock(),
      onChange: setView,
    })
    sessionRef.current = session
    return () => {
      session.dispose()
      sessionRef.current = null
    }
  }, [])

  return {
    view,
    start: () => void sessionRef.current?.start(),
    stop: () => void sessionRef.current?.stop(),
    retryUpload: () => sessionRef.current?.retryUpload(),
    reprocess: () => void sessionRef.current?.reprocess(),
    pause: () => sessionRef.current?.pause(),
  }
}
