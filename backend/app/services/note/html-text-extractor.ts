import { parseDocument } from 'htmlparser2'

type ParsedNode = ReturnType<typeof parseDocument>['children'][number]

export function extractNoteText(html: string): string {
  if (html.trim() === '') return ''
  const parts: string[] = []
  for (const node of parseDocument(html, { decodeEntities: true }).children) {
    walk(node, parts)
  }
  return parts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function walk(node: ParsedNode, parts: string[]): void {
  if (node.type === 'text' && 'data' in node) {
    parts.push(node.data.replaceAll('\u200b', ''))
    return
  }
  if (node.type !== 'tag' || !('name' in node) || !('children' in node)) return
  if (node.name === 'script' || node.name === 'style' || node.name === 'noscript') return
  if (node.name === 'div' && classNames(node).has('nc-todo')) {
    const done = 'attribs' in node && node.attribs['data-done'] === 'true'
    const label = labelText(node).replaceAll('\u200b', '').trim()
    separateBlock(parts)
    parts.push(`${done ? '☑' : '☐'} ${label}\n`)
    return
  }
  if (node.name === 'br') {
    parts.push('\n')
    return
  }
  for (const child of node.children as ParsedNode[]) walk(child, parts)
  if (node.name === 'div' || node.name === 'p' || node.name === 'li') separateBlock(parts)
}

function separateBlock(parts: string[]): void {
  const current = parts.join('')
  if (current.length > 0 && !current.endsWith('\n')) parts.push('\n')
}

function labelText(node: ParsedNode): string {
  const children = 'children' in node ? node.children as ParsedNode[] : []
  const label = children.find((child) => child.type === 'tag' && 'name' in child && child.name === 'span' && classNames(child).has('nc-todo-label'))
  return collectText(label ?? node)
}

function collectText(node: ParsedNode): string {
  if (node.type === 'text' && 'data' in node) return node.data
  if (!('children' in node)) return ''
  return (node.children as ParsedNode[]).map((child) => collectText(child)).join('')
}

function classNames(node: ParsedNode): Set<string> {
  const value = 'attribs' in node ? node.attribs.class ?? '' : ''
  return new Set(value.split(/\s+/).filter((name) => name.length > 0))
}
