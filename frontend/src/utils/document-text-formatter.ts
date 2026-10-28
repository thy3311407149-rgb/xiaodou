export type DocumentHeadingLevel = 1 | 2 | 3

export type DocumentBlock =
  | { type: 'heading'; level: DocumentHeadingLevel; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: string[] }

const HEADING_MAX_LENGTH = 32
const SHORT_TITLE_MAX_LENGTH = 16

const CHAPTER_PATTERN = /^第[0-9零〇一二三四五六七八九十百千万]{1,8}[章篇部编](?:[ \t\u3000]+.+)?$/
const SECTION_PATTERN = /^第[0-9零〇一二三四五六七八九十百千万]{1,8}节(?:[ \t\u3000]+.+)?$/
const CN_ENUM_PATTERN = /^[一二三四五六七八九十百千]{1,4}、(?:[ \t\u3000]*.+)?$/
const PAREN_CN_PATTERN = /^[（(][一二三四五六七八九十]{1,3}[）)](?:[ \t\u3000]*.+)?$/
const MULTI_NUMBER_PATTERN = /^\d{1,2}(?:\.\d{1,2}){1,3}\.?(?:[ \t\u3000]+.+)?$/
const SINGLE_NUMBER_PATTERN = /^\d{1,2}[.、](?!\d)(?:[ \t\u3000]*\S.*)?$/
const BULLET_PATTERN = /^(?:[•●○■□▪▫◆◇►▸][ \t\u3000]*\S|[-–—*]\s+\S)/
const ORDERED_LIST_PATTERN = /^(?:[（(]\d{1,2}[）)]|\d{1,2}[)）])[ \t\u3000]*\S/
const SENTENCE_PUNCTUATION = /[。！？!?；;，,]/
const MARKER_PATTERN = /第[0-9零〇一二三四五六七八九十百千万]{1,8}(?:[章篇部编]|节)|[（(][一二三四五六七八九十]{1,3}[）)]|[一二三四五六七八九十百千]{1,4}、|[•●○■□▪▫◆◇►▸]|[-–—]\s+|[（(]\d{1,2}[）)]|\d{1,2}[)）]|\d{1,2}(?:\.\d{1,2}){1,3}\.?|\d{1,2}[.、]/g

function isShortHeading(text: string): boolean {
  return text.length > 0 && text.length <= HEADING_MAX_LENGTH && !SENTENCE_PUNCTUATION.test(text)
}

function isChineseEnumHeading(text: string): boolean {
  if (/^[一二三四五六七八九十百千]{1,4}、[一二三四五六七八九十百千]/.test(text)) return false
  if (!CN_ENUM_PATTERN.test(text) || !isShortHeading(text)) return false
  const rest = text.replace(/^[一二三四五六七八九十百千]{1,4}、[ \t\u3000]*/, '')
  return rest.length > 0 && !/^[一二三四五六七八九十百千]{1,4}、/.test(rest)
}

function headingLevel(text: string): DocumentHeadingLevel | null {
  if (CHAPTER_PATTERN.test(text) && isShortHeading(text)) return 1
  if (SECTION_PATTERN.test(text) && isShortHeading(text)) return 2
  if (isChineseEnumHeading(text)) return 2
  if (PAREN_CN_PATTERN.test(text) && isShortHeading(text)) return 3
  if (MULTI_NUMBER_PATTERN.test(text) && isShortHeading(text) && hasNumericTitle(text)) {
    return /^\d{1,2}(?:\.\d{1,2}){2,3}\.?/.test(text) ? 3 : 2
  }
  if (SINGLE_NUMBER_PATTERN.test(text) && isShortHeading(text) && hasNumericTitle(text)) return 3
  return null
}

function hasNumericTitle(text: string): boolean {
  const rest = text.replace(/^\d{1,2}(?:\.\d{1,2}){1,3}\.?(?:[ \t\u3000]+)?|^\d{1,2}[.、](?:[ \t\u3000]+)?/, '')
  return rest.length >= 2 && !/^[万亿千百%％]/.test(rest)
}

function isListLine(text: string): boolean {
  if (BULLET_PATTERN.test(text) || ORDERED_LIST_PATTERN.test(text)) return true
  return SINGLE_NUMBER_PATTERN.test(text) && !isShortHeading(text)
}

function isFlatList(text: string): boolean {
  if (!isListLine(text)) return false
  const body = text.replace(/^(?:[•●○■□▪▫◆◇►▸]|[-–—*]\s+|[（(]\d{1,2}[）)]|\d{1,2}[)）]|\d{1,2}[.、])[ \t\u3000]*/, '')
  return body.replace(/[。！？!?；;，,、\s]/g, '').length >= 2
}

function isIsolatedShortTitle(text: string, isolated: boolean, hasNeighbor: boolean): boolean {
  if (!isolated || !hasNeighbor) return false
  if (text.length < 2 || text.length > SHORT_TITLE_MAX_LENGTH) return false
  if (/[。！？!?；;，,、：:．.#<>*`[\]]/.test(text)) return false
  return /[\p{Script=Han}A-Za-z]{2}/u.test(text)
}

function isClosingParenthesis(text: string, index: number, token: string): boolean {
  if (!/^\d{1,2}[)）]$/.test(token)) return false
  const before = text.slice(0, index)
  const open = Math.max(before.lastIndexOf('（'), before.lastIndexOf('('))
  if (open < 0) return false
  return !/[。！？!?；;]/.test(before.slice(open))
}

function isInlineRepeat(text: string, index: number, token: string): boolean {
  if (!/^\d{1,2}[.、]/.test(token) || index === 0 || !/\s/.test(text[index - 1])) return false
  const run = text.slice(0, index - 1).match(/[\u3400-\u9FFF]{1,8}$/)
  if (!run) return false
  const after = text.slice(index + token.length).replace(/^[ \t\u3000]+/, '')
  for (let size = run[0].length; size >= 2; size -= 1) {
    if (after.startsWith(run[0].slice(-size))) return true
  }
  return false
}

function isFlatBoundary(text: string, index: number, token: string): boolean {
  if (index === 0) return true
  const previous = text[index - 1]
  if (/[\s。！？!?；;]/.test(previous)) return true
  if (token.startsWith('第') && /[0-9]/.test(previous)) {
    const beforeDigit = index >= 2 ? text[index - 2] : ''
    return beforeDigit.length === 0 || /[\s。！？!?；;]|[\u3400-\u9FFF]/.test(beforeDigit)
  }
  return false
}

function flatHeadingTitle(text: string, level: DocumentHeadingLevel, nextToken: string | null): boolean {
  if (/^\d/.test(text) && /[：:（(【]/.test(text)) return false
  if (/^\d/.test(text) && nextToken && /^\d{1,2}[.、]/.test(nextToken)) {
    const title = text.replace(/^\d{1,2}(?:\.\d{1,2}){1,3}\.?[ \t\u3000]*|^\d{1,2}[.、][ \t\u3000]*/, '')
    if (title.length <= 6) return false
  }
  if (level === 1 && /^第[0-9零〇一二三四五六七八九十百千万]{1,8}[章篇部编]$/.test(text)) return true
  const rest = text.replace(/^第[0-9零〇一二三四五六七八九十百千万]{1,8}[章篇部编节][ \t\u3000]*|^[（(][一二三四五六七八九十]{1,3}[）)][ \t\u3000]*|^[一二三四五六七八九十百千]{1,4}、[ \t\u3000]*|^\d{1,2}(?:\.\d{1,2}){1,3}\.?[ \t\u3000]*|^\d{1,2}[.、][ \t\u3000]*/, '')
  if (rest.length < 2) return false
  if (/^[一二三四五六七八九十百千]{1,4}、/.test(rest)) return false
  if (/^[万亿千百%％]/.test(rest)) return false
  return true
}

function formatFlat(content: string): DocumentBlock[] {
  const markers = [...content.matchAll(MARKER_PATTERN)].filter((match) => (
    match.index != null && !isInlineRepeat(content, match.index, match[0]) && !isClosingParenthesis(content, match.index, match[0])
  ))
  const starts = markers.filter((match) => isFlatBoundary(content, match.index ?? 0, match[0]))
  if (starts.length === 0) return [{ type: 'paragraph', text: content }]

  const blocks: DocumentBlock[] = []
  let cursor = 0

  const pushParagraph = (text: string) => {
    if (text.length === 0) return
    const last = blocks[blocks.length - 1]
    if (last?.type === 'paragraph') last.text += text
    else blocks.push({ type: 'paragraph', text })
  }

  const pushList = (text: string) => {
    const last = blocks[blocks.length - 1]
    if (last?.type === 'list') last.items.push(text)
    else blocks.push({ type: 'list', items: [text] })
  }

  starts.forEach((match) => {
    const start = match.index ?? 0
    if (start < cursor) return
    const next = markers.find((item) => (item.index ?? 0) > start)
    const end = next?.index ?? content.length
    const raw = content.slice(start, end)
    const slice = raw.trim()
    if (slice.length === 0) return
    const level = headingLevel(slice)
    const nextToken = next?.[0] ?? null
    const heading = level != null && flatHeadingTitle(slice, level, nextToken)
    const list = !heading && isFlatList(slice) && (next == null || /[。！？!?；;]$/.test(slice))
    if (!heading && !list) return
    const lead = raw.length - raw.trimStart().length
    pushParagraph(content.slice(cursor, start + lead))
    if (heading && level) blocks.push({ type: 'heading', level, text: slice })
    else pushList(slice)
    cursor = start + lead + slice.length
  })

  pushParagraph(content.slice(cursor))
  return blocks
}

function formatLines(content: string): DocumentBlock[] {
  const lines = content.split('\n')
  const hasNeighbor = lines.filter((line) => line.trim().length > 0).length > 1
  const blocks: DocumentBlock[] = []
  let paragraph: string[] = []
  let list: string[] = []

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') })
    paragraph = []
  }

  const flushList = () => {
    if (list.length === 0) return
    blocks.push({ type: 'list', items: list })
    list = []
  }

  lines.forEach((raw, index) => {
    const text = raw.trim()
    if (text.length === 0) {
      flushParagraph()
      flushList()
      return
    }

    const level = headingLevel(text)
    if (level) {
      flushParagraph()
      flushList()
      blocks.push({ type: 'heading', level, text })
      return
    }

    if (isListLine(text)) {
      flushParagraph()
      list.push(text)
      return
    }

    const previousBlank = index === 0 || lines[index - 1].trim().length === 0
    const nextBlank = index === lines.length - 1 || lines[index + 1].trim().length === 0
    if (isIsolatedShortTitle(text, previousBlank && nextBlank, hasNeighbor)) {
      flushParagraph()
      flushList()
      blocks.push({ type: 'heading', level: 3, text })
      return
    }

    flushList()
    paragraph.push(text)
  })

  flushParagraph()
  flushList()
  return blocks
}

export function formatDocumentText(content: string): DocumentBlock[] {
  const normalized = content.replace(/\r\n?/g, '\n')
  if (normalized.trim().length === 0) return []
  if (normalized.includes('\n')) return formatLines(normalized)
  return formatFlat(normalized)
}
