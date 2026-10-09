import type { TaskSnapshot, TaskStep } from './task.ts'

export const PROCESS_FAILED_MESSAGE = '文件处理失败'

const STEP_TEXT: Record<TaskStep, string> = {
  EXTRACT_TEXT: '提取文本',
  SAVE_DOCUMENT_TEXT: '保存正文',
  CREATE_CHUNKS: '切分片段',
  GENERATE_SUMMARY: '生成摘要',
  SAVE_SUMMARY: '保存摘要',
  COMPLETED: '步骤完成',
}

export type UploadPhase = 'processing' | 'succeeded' | 'failed'

export type TaskView = {
  phase: UploadPhase
  label: '处理中' | '处理完成' | '失败'
  detail: string | null
  progress: number | null
}

export function stepText(step: string | null | undefined): string | null {
  if (!step) return null
  return step in STEP_TEXT ? STEP_TEXT[step as TaskStep] : null
}

export function mapTaskView(task: Pick<TaskSnapshot, 'status' | 'currentStep' | 'progress' | 'errorMessage'>): TaskView {
  const progress = typeof task.progress === 'number' && Number.isFinite(task.progress) ? task.progress : null
  if (task.status === 'QUEUED' || task.status === 'RUNNING') {
    return { phase: 'processing', label: '处理中', detail: stepText(task.currentStep), progress }
  }
  if (task.status === 'SUCCEEDED') {
    return { phase: 'succeeded', label: '处理完成', detail: null, progress }
  }
  const message = task.errorMessage?.trim() ? task.errorMessage : PROCESS_FAILED_MESSAGE
  return { phase: 'failed', label: '失败', detail: message, progress }
}

export function isTerminalTaskStatus(status: string): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED'
}
