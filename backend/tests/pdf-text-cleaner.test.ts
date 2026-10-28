import { describe, expect, it } from 'vitest'
import { cleanPdfText } from '../app/services/pdf/pdf-text-cleaner.js'

describe('PdfTextCleaner', () => {
  it('joins a Chinese character that was broken onto its own line', () => {
    const cleaned = cleanPdfText('项\n目\n预\n算\n已经确认')
    expect(cleaned).toBe('项目\n预算\n已经确认')
    expect(cleaned).toMatch(/[\u3400-\u9FFF]/)
  })

  it('keeps newlines between Chinese headings, numbers, and list items', () => {
    const source = '一、功能说明\n1、 知识库首页\n• 每日更新一次，保留编号\n\n二、个人设置'
    const cleaned = cleanPdfText(source)
    expect(cleaned).toBe(source)
    expect(cleaned).toContain('1、')
    expect(cleaned).toContain('，')
  })

  it('keeps English words and joins a hyphenated line break', () => {
    const cleaned = cleanPdfText('The project budget\nwas confi-\nrmed in 2026.')
    expect(cleaned).toBe('The project budget\nwas confirmed in 2026.')
    expect(cleaned).toContain('2026')
  })

  it('keeps mixed Chinese, English, digits, and newlines while removing garbled characters', () => {
    const cleaned = cleanPdfText('2026 年 Project\uFFFD 预算\u0000\n已经\u200B确认(cid:12)')
    expect(cleaned).toBe('2026 年 Project 预算\n已经确认')
    expect(cleaned).not.toContain('\uFFFD')
    expect(cleaned).not.toContain('\u0000')
    expect(cleaned).not.toContain('(cid:')
  })
})
