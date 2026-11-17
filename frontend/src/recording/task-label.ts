import type { RecordingTaskStep } from '../api/recordings.ts'

const STEP_TEXT: Record<RecordingTaskStep, string> = {
  PERSIST_AUDIO: '正在整理录音文件',
  TRANSCRIBE_AUDIO: '正在转写录音内容',
  SAVE_TRANSCRIPT: '正在保存转写文本',
  GENERATE_SUMMARY: '正在生成录音摘要',
  SAVE_SUMMARY: '正在保存摘要',
  EXTRACT_KNOWLEDGE: '正在提取知识点',
  COMPLETED: '录音处理完成',
}

export function recordingStepText(step: string | null | undefined): string | null {
  if (!step || !(step in STEP_TEXT)) return null
  return STEP_TEXT[step as RecordingTaskStep]
}
