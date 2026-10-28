const INVISIBLE_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\uFEFF\u00AD\uFFFD]/g
const SINGLE_CHARACTER_CHINESE_BREAK = /(^|\n)([\u3400-\u9FFF])\n(?!\n)(?=[\u3400-\u9FFF])/g

export function cleanPdfText(input: string): string {
  const normalized = input
    .replace(/\r\n?/g, '\n')
    .replace(/\(cid:\d+\)/gi, '')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(INVISIBLE_CHARACTERS, '')
  const merged = mergeAbnormalLineBreaks(normalized)
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
  return merged.trim()
}

function mergeAbnormalLineBreaks(input: string): string {
  const withoutHyphenBreaks = input.replace(/([A-Za-z])-\n(?!\n)([A-Za-z])/g, '$1$2')
  let current = withoutHyphenBreaks
  let previous = ''
  while (current !== previous) {
    previous = current
    current = current.replace(SINGLE_CHARACTER_CHINESE_BREAK, '$1$2')
  }
  return current
}
