import { describe, expect, it } from 'vitest'
import { extractNoteText } from '../app/services/note/html-text-extractor.js'
import { sanitizeNoteHtml } from '../app/services/note/html-sanitizer.js'

const todo = [
  '<div class="nc-todo" data-done="false">',
  '<span class="nc-box" data-todo-box="1" contenteditable="false" role="checkbox" aria-checked="false" aria-label="待办完成"></span>',
  '<span class="nc-todo-label">买牛奶</span>',
  '</div>',
].join('')

describe('note HTML sanitizer', () => {
  it('keeps paragraphs, lists, emphasis, todos, and highlights', () => {
    const html = [
      '<p>第一段</p>',
      '<div>第二段<br>换行</div>',
      '<ul><li>无序</li></ul>',
      '<ol><li><b>加粗</b><i>斜体</i><u>下划线</u></li></ol>',
      '<mark class="nc-hl extra" onclick="alert(1)">重点</mark>',
      todo,
    ].join('')
    const clean = sanitizeNoteHtml(html)

    expect(clean).toContain('<p>第一段</p>')
    expect(clean).toContain('<div>第二段<br />换行</div>')
    expect(clean).toContain('<ul><li>无序</li></ul>')
    expect(clean).toContain('<b>加粗</b>')
    expect(clean).toContain('<i>斜体</i>')
    expect(clean).toContain('<u>下划线</u>')
    expect(clean).toContain('<mark class="nc-hl">重点</mark>')
    expect(clean).toContain('class="nc-todo"')
    expect(clean).toContain('data-done="false"')
    expect(clean).toContain('class="nc-box"')
    expect(clean).toContain('data-todo-box="1"')
    expect(clean).toContain('contenteditable="false"')
    expect(clean).toContain('role="checkbox"')
    expect(clean).toContain('aria-checked="false"')
    expect(clean).toContain('aria-label="待办完成"')
    expect(clean).toContain('class="nc-todo-label"')
    expect(clean).not.toContain('onclick')
    expect(clean).not.toContain('extra')
  })

  it('removes scripts, event handlers, dangerous URLs, frames, and attachment payloads', () => {
    const clean = sanitizeNoteHtml([
      '<p onclick="alert(1)" style="background:url(javascript:alert(1))" class="evil">正文</p>',
      '<script>alert(1)</script>',
      '<iframe src="https://evil.test"></iframe>',
      '<object data="https://evil.test"></object>',
      '<embed src="https://evil.test">',
      '<a href="javascript:alert(1)">点我</a>',
      '<img src="x" onerror="alert(1)">',
      '<div data-nc-files="%7B%7D"></div>',
    ].join(''))

    expect(clean).toBe('<p>正文</p>点我')
    expect(clean).not.toContain('script')
    expect(clean).not.toContain('javascript:')
    expect(clean).not.toContain('iframe')
    expect(clean).not.toContain('onerror')
    expect(clean).not.toContain('data-nc-files')
  })

  it('returns an empty string for empty or non-content markup', () => {
    expect(sanitizeNoteHtml('')).toBe('')
    expect(sanitizeNoteHtml('   ')).toBe('')
    expect(sanitizeNoteHtml('<script>alert(1)</script>')).toBe('')
  })

  it('keeps readable text from malformed markup', () => {
    expect(sanitizeNoteHtml('<p><b>未闭合')).toContain('未闭合')
  })
})

describe('note HTML text extractor', () => {
  it('keeps paragraph breaks, list text, todos, and highlight text without tags', () => {
    const text = extractNoteText([
      '<p>第一段</p>',
      '<div>第二段<br>继续</div>',
      '<ul><li>无序</li><li><b>加粗</b>项目</li></ul>',
      '<mark class="nc-hl">重点</mark>',
      todo,
      '<div class="nc-todo" data-done="true"><span class="nc-box"></span><span class="nc-todo-label">已完成\u200b</span></div>',
    ].join(''))

    expect(text).toBe([
      '第一段',
      '第二段',
      '继续',
      '无序',
      '加粗项目',
      '重点',
      '☐ 买牛奶',
      '☑ 已完成',
    ].join('\n'))
    expect(text).not.toContain('<')
  })

  it('does not concatenate separated blocks or include script and style text', () => {
    expect(extractNoteText('<div>你好</div><div>世界</div>')).toBe('你好\n世界')
    expect(extractNoteText('<b>你好</b><i>世界</i>')).toBe('你好世界')
    expect(extractNoteText('<p>可见</p><script>alert(1)</script><style>body{}</style>')).toBe('可见')
    expect(extractNoteText('')).toBe('')
    expect(extractNoteText('   ')).toBe('')
  })

  it('recovers text from malformed HTML', () => {
    expect(extractNoteText('<p><b>未闭合')).toBe('未闭合')
  })
})
