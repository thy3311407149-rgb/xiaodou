import { describe, expect, it } from 'vitest'
import { cleanPdfText } from '../app/services/pdf/pdf-text-cleaner.js'

describe('PdfTextCleaner', () => {
  it('keeps Chinese text and joins line breaks between Chinese characters', () => {
    const cleaned = cleanPdfText('项\n目\n预\n算\n已经确认')
    expect(cleaned).toBe('项目预算已经确认')
    expect(cleaned).toMatch(/[\u3400-\u9FFF]/)
  })

  it('keeps English words and joins a hyphenated line break', () => {
    const cleaned = cleanPdfText('The project budget\nwas confi-\nrmed in 2026.')
    expect(cleaned).toBe('The project budget\nwas confirmed in 2026.')
    expect(cleaned).toContain('2026')
  })

  it('keeps mixed Chinese, English, and digits while removing garbled characters', () => {
    const cleaned = cleanPdfText('2026 年 Project\uFFFD 预算\u0000\n已经\u200B确认')
    expect(cleaned).toBe('2026 年 Project 预算已经确认')
    expect(cleaned).not.toContain('\uFFFD')
    expect(cleaned).not.toContain('\u0000')
  })
})
