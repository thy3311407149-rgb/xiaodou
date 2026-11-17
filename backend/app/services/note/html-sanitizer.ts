import render from 'dom-serializer'
import { parseDocument } from 'htmlparser2'
import sanitizeHtml from 'sanitize-html'

const ALLOWED_TAGS = ['p', 'div', 'br', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'ul', 'ol', 'li', 'mark']

type ParsedNode = ReturnType<typeof parseDocument>['children'][number]

export function sanitizeNoteHtml(value: string): string {
  if (value.trim() === '') return ''
  const sanitized = sanitizeHtml(dropAttachmentCarriers(value), {
    allowedTags: ALLOWED_TAGS,
    disallowedTagsMode: 'discard',
    allowedAttributes: {
      div: ['class', { name: 'data-done', values: ['true', 'false'] }],
      span: [
        'class',
        { name: 'data-todo-box', values: ['1'] },
        { name: 'contenteditable', values: ['false'] },
        { name: 'role', values: ['checkbox'] },
        { name: 'aria-checked', values: ['true', 'false'] },
        { name: 'aria-label', values: ['待办完成'] },
      ],
      mark: ['class'],
    },
    allowedClasses: {
      div: ['nc-todo'],
      span: ['nc-box', 'nc-todo-label'],
      mark: ['nc-hl'],
    },
    allowedSchemes: [],
    allowedSchemesByTag: {},
    allowedSchemesAppliedToAttributes: [],
    allowProtocolRelative: false,
    nonTextTags: ['script', 'style', 'textarea', 'option', 'xmp', 'noscript', 'iframe', 'object', 'embed', 'noembed'],
    transformTags: {
      div: (tagName, attribs) => {
        const next = { ...attribs }
        if (!classNames(next.class).has('nc-todo')) delete next['data-done']
        return { tagName, attribs: next }
      },
      span: (tagName, attribs) => {
        const next = { ...attribs }
        if (!classNames(next.class).has('nc-box')) {
          delete next['data-todo-box']
          delete next.contenteditable
          delete next.role
          delete next['aria-checked']
          delete next['aria-label']
        }
        return { tagName, attribs: next }
      },
    },
  })
  return sanitized.trim()
}

function dropAttachmentCarriers(html: string): string {
  const document = parseDocument(html)
  document.children = removeAttachmentDivs(document.children) as typeof document.children
  return render(document)
}

function removeAttachmentDivs(nodes: ParsedNode[]): ParsedNode[] {
  const kept: ParsedNode[] = []
  for (const node of nodes) {
    if (isAttachmentCarrier(node)) continue
    if ('children' in node && Array.isArray(node.children)) {
      node.children = removeAttachmentDivs(node.children as ParsedNode[]) as typeof node.children
    }
    kept.push(node)
  }
  return kept
}

function isAttachmentCarrier(node: ParsedNode): boolean {
  return node.type === 'tag'
    && 'name' in node
    && node.name === 'div'
    && 'attribs' in node
    && Object.prototype.hasOwnProperty.call(node.attribs, 'data-nc-files')
}

function classNames(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(/\s+/).filter((name) => name.length > 0))
}
