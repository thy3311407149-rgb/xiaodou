import { describe, expect, it } from 'vitest'
import { FILE_SIZE_MESSAGE, FILE_TYPE_MESSAGE, PDF_MAX_BYTES, validatePdfFile } from './pdf-file.ts'

describe('validatePdfFile', () => {
  it('rejects a non-pdf extension before any upload', () => {
    expect(validatePdfFile({ name: 'notes.docx', size: 128 })).toEqual({ ok: false, message: FILE_TYPE_MESSAGE })
    expect(validatePdfFile({ name: 'paper.pdf.txt', size: 128 })).toEqual({ ok: false, message: FILE_TYPE_MESSAGE })
  })

  it('accepts a pdf at the 20MB boundary and rejects one byte over', () => {
    expect(validatePdfFile({ name: 'paper.PDF', size: PDF_MAX_BYTES })).toEqual({ ok: true })
    expect(validatePdfFile({ name: 'paper.pdf', size: PDF_MAX_BYTES + 1 })).toEqual({ ok: false, message: FILE_SIZE_MESSAGE })
  })
})
