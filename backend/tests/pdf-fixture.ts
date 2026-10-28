function escapePdfText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
}

function buildPdf(streams: readonly string[]): Buffer {
  const chunks: Buffer[] = []
  const offsets = [0]
  let length = 0
  const push = (text: string): void => {
    const bytes = Buffer.from(text, 'latin1')
    chunks.push(bytes)
    length += bytes.length
  }
  const addObject = (id: number, body: string): void => {
    offsets[id] = length
    push(`${id} 0 obj\n${body}\nendobj\n`)
  }

  push('%PDF-1.4\n')
  const pageObjectIds: number[] = []
  const contentObjectIds: number[] = []
  let nextId = 4
  for (let index = 0; index < streams.length; index += 1) {
    pageObjectIds.push(nextId)
    contentObjectIds.push(nextId + 1)
    nextId += 2
  }

  addObject(1, '<< /Type /Catalog /Pages 2 0 R >>')
  addObject(2, `<< /Type /Pages /Count ${streams.length} /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] >>`)
  addObject(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

  streams.forEach((stream, index) => {
    const pageId = pageObjectIds[index] as number
    const contentId = contentObjectIds[index] as number
    addObject(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`)
    addObject(contentId, `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`)
  })

  const xrefOffset = length
  let xref = `xref\n0 ${nextId}\n0000000000 65535 f \n`
  for (let id = 1; id < nextId; id += 1) {
    xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  }
  push(xref)
  push(`trailer\n<< /Size ${nextId} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`)
  return Buffer.concat(chunks)
}

export function createTextPdf(pageTexts: readonly string[]): Buffer {
  return buildPdf(pageTexts.map((text) => `BT\n/F1 12 Tf\n72 720 Td\n(${escapePdfText(text)}) Tj\nET\n`))
}

export type PdfTextRun = {
  text: string
  x: number
  y: number
  fontSize: number
}

export function createLayoutPdf(runs: readonly PdfTextRun[]): Buffer {
  const commands = ['BT']
  for (const run of runs) {
    commands.push(`/F1 ${run.fontSize} Tf`)
    commands.push(`1 0 0 1 ${run.x} ${run.y} Tm`)
    commands.push(`(${escapePdfText(run.text)}) Tj`)
  }
  commands.push('ET\n')
  return buildPdf([commands.join('\n')])
}
