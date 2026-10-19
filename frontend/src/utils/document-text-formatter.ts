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
const MULTI_NUMBER_PATTERN = /^\d{1,2}(?:\.\d{1,2}){1,3}(?:[ \t\u3000]+.+)?$/
const SINGLE_NUMBER_PATTERN = /^\d{1,2}[.、](?!\d)(?:[ \t\u3000]*\S.*)?$/
const BULLET_PATTERN = /^(?:[•●○■□▪▫◆◇►▸][ \t\u3000]*\S|[-–—*]\s+\S)/
const ORDERED_LIST_PATTERN = /^(?:[（(]\d{1,2}[）)]|\d{1,2}[)）])[ \t\u3000]*\S/
const SENTENCE_PUNCTUATION = /[。！？!?；;，,]/

function isShortHeading(text: string): boolean {
  return text.length > 0 && text.length <= HEADING_MAX_LENGTH && !SENTENCE_PUNCTUATION.test(text)
}

function isChineseEnumHeading(text: string): boolean {
  if (!CN_ENUM_PATTERN.test(text) || !isShortHeading(text)) return false
  const rest = text.replace(/^[一二三四五六七八九十百千]{1,4}、[ \t\u3000]*/, '')
  return !/^[一二三四五六七八九十百千]{1,4}、/.test(rest)
}

function headingLevel(text: string): DocumentHeadingLevel | null {
  if (CHAPTER_PATTERN.test(text) && isShortHeading(text)) return 1
  if (SECTION_PATTERN.test(text) && isShortHeading(text)) return 2
  if (isChineseEnumHeading(text)) return 2
  if (PAREN_CN_PATTERN.test(text) && isShortHeading(text)) return 3
  if (MULTI_NUMBER_PATTERN.test(text) && isShortHeading(text)) return 3
  if (SINGLE_NUMBER_PATTERN.test(text) && isShortHeading(text)) return 3
  return null
}

function isListLine(text: string): boolean {
  if (BULLET_PATTERN.test(text) || ORDERED_LIST_PATTERN.test(text)) return true
  return SINGLE_NUMBER_PATTERN.test(text) && !isShortHeading(text)
}

function isIsolatedShortTitle(text: string, isolated: boolean, hasNeighbor: boolean): boolean {
  if (!isolated || !hasNeighbor) return false
  if (text.length < 2 || text.length > SHORT_TITLE_MAX_LENGTH) return false
  if (/[。！？!?；;，,、：:．.#<>*`[\]]/.test(text)) return false
  return /[\p{Script=Han}A-Za-z]{2}/u.test(text)
}

export function formatDocumentText(content: string): DocumentBlock[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
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

    const prevBlank = index === 0 || lines[index - 1].trim().length === 0
    const nextBlank = index === lines.length - 1 || lines[index + 1].trim().length === 0
    if (isIsolatedShortTitle(text, prevBlank && nextBlank, hasNeighbor)) {
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
