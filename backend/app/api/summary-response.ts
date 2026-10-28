import type { Summary } from '../models/summary.js'

export function toPublicSummary(summary: Summary) {
  return {
    id: summary.id,
    fileId: summary.fileId,
    taskId: summary.taskId,
    content: summary.content,
    keyPoints: summary.keyPoints,
    citations: summary.citations,
    modelName: summary.modelName,
    promptVersion: summary.promptVersion,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
  }
}
