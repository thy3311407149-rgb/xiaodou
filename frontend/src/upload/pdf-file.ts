export const PDF_MAX_BYTES = 20_971_520
export const FILE_TYPE_MESSAGE = '文件类型无效'
export const FILE_SIZE_MESSAGE = '文件超过大小限制'

export type PdfFileMeta = {
  name: string
  size: number
}

export type PdfValidation = { ok: true } | { ok: false; message: string }

export function validatePdfFile(file: PdfFileMeta): PdfValidation {
  if (!file.name.toLowerCase().endsWith('.pdf')) return { ok: false, message: FILE_TYPE_MESSAGE }
  if (file.size > PDF_MAX_BYTES) return { ok: false, message: FILE_SIZE_MESSAGE }
  return { ok: true }
}
