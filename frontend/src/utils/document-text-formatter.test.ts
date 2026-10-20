import { describe, expect, it } from 'vitest'
import { formatDocumentText, type DocumentBlock } from './document-text-formatter.ts'

function visibleText(blocks: DocumentBlock[]): string {
  return blocks.flatMap((block) => (block.type === 'list' ? block.items : [block.text])).join('\n')
}

function normalizedLines(content: string): string {
  return content.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter((line) => line.length > 0).join('\n')
}

describe('formatDocumentText', () => {
  it('recognizes chapter, section, and numeric heading levels', () => {
    const blocks = formatDocumentText([
      '第一章 认知负荷',
      '第一节 工作记忆',
      '1.1 容量限制',
    ].join('\n'))

    expect(blocks).toEqual([
      { type: 'heading', level: 1, text: '第一章 认知负荷' },
      { type: 'heading', level: 2, text: '第一节 工作记忆' },
      { type: 'heading', level: 2, text: '1.1 容量限制' },
    ])
  })

  it('recognizes Chinese enumeration headings and keeps the marker', () => {
    const blocks = formatDocumentText('一、基本概念\n二、相关负荷')
    expect(blocks).toEqual([
      { type: 'heading', level: 2, text: '一、基本概念' },
      { type: 'heading', level: 2, text: '二、相关负荷' },
    ])
  })

  it('recognizes standalone numeric headings', () => {
    const blocks = formatDocumentText('1. 引言\n2、方法\n1.2.3 材料')
    expect(blocks.map((block) => block.type === 'heading' ? block.level : block.type)).toEqual([3, 3, 3])
    expect(blocks.map((block) => block.type === 'heading' ? block.text : '')).toEqual(['1. 引言', '2、方法', '1.2.3 材料'])
  })

  it('keeps numbers and enumeration inside a paragraph', () => {
    const content = '实验分为一、对照组和二、实验组，样本量约 1.1 万，详见第3章与公式 1.。'
    expect(formatDocumentText(content)).toEqual([{ type: 'paragraph', text: content }])
  })

  it('keeps a long numbered sentence as a list item instead of a heading', () => {
    const line = '1. 认知负荷包括内在负荷、外在负荷和相关负荷，三者共同决定学习效果。'
    expect(formatDocumentText(line)).toEqual([{ type: 'list', items: [line] }])
  })

  it('splits long body text into paragraphs and preserves line breaks inside a paragraph', () => {
    const blocks = formatDocumentText('第一段上一行\n第一段下一行\n\n第二段只有一行，里面有数字 2026 和编号 3.14。')
    expect(blocks).toEqual([
      { type: 'paragraph', text: '第一段上一行\n第一段下一行' },
      { type: 'paragraph', text: '第二段只有一行，里面有数字 2026 和编号 3.14。' },
    ])
  })

  it('uses blank lines as separators and does not invent blocks from them', () => {
    const blocks = formatDocumentText('\n\n第一章 总论\n\n\n正文。\n\n')
    expect(blocks).toEqual([
      { type: 'heading', level: 1, text: '第一章 总论' },
      { type: 'paragraph', text: '正文。' },
    ])
  })

  it('returns no blocks for an empty string or a blank page', () => {
    expect(formatDocumentText('')).toEqual([])
    expect(formatDocumentText(' \n\t \n ')).toEqual([])
  })

  it('keeps mixed Chinese and English body attached to an explicit chapter line', () => {
    const blocks = formatDocumentText('第一章 Cognitive Load\n\nWorking memory 容量有限，see section 1.1 later。')
    expect(blocks).toEqual([
      { type: 'heading', level: 1, text: '第一章 Cognitive Load' },
      { type: 'paragraph', text: 'Working memory 容量有限，see section 1.1 later。' },
    ])
  })

  it('preserves words, digits, and punctuation in their original order', () => {
    const content = [
      '  第一章  认知负荷 ',
      '',
      '一、基本概念',
      '正文含 # 号、<b>标签</b>、数字 1.1 和「一、」。',
      '• 组块',
      '- 外在负荷',
      '（1） 相关负荷',
    ].join('\r\n')
    expect(visibleText(formatDocumentText(content))).toBe(normalizedLines(content))
  })

  it('leaves unrecognized text intact, including markdown markers', () => {
    const content = '# 不要当成标题\n<script>alert(1)</script>\n普通说明，没有可靠的标题标记。'
    expect(formatDocumentText(content)).toEqual([{ type: 'paragraph', text: content }])
  })

  it('promotes an isolated short line only when the page has other text', () => {
    expect(formatDocumentText('认知负荷\n\n工作记忆需要分组块处理。')).toEqual([
      { type: 'heading', level: 3, text: '认知负荷' },
      { type: 'paragraph', text: '工作记忆需要分组块处理。' },
    ])
    expect(formatDocumentText('第一页正文')).toEqual([{ type: 'paragraph', text: '第一页正文' }])
  })

  it('groups explicit list markers and does not treat a following sentence as another item', () => {
    const blocks = formatDocumentText('• 组块\n• 图式\n随后进入正文，而不是新的列表项。')
    expect(blocks).toEqual([
      { type: 'list', items: ['• 组块', '• 图式'] },
      { type: 'paragraph', text: '随后进入正文，而不是新的列表项。' },
    ])
  })

  it('does not treat a chain of enumerators or a decimal quantity as a heading', () => {
    expect(formatDocumentText('一、二、三组同时进行')).toEqual([{ type: 'paragraph', text: '一、二、三组同时进行' }])
    expect(formatDocumentText('1.1万名被试完成了前测。')).toEqual([{ type: 'paragraph', text: '1.1万名被试完成了前测。' }])
  })

  it('splits a bounded chapter out of text that has no line breaks', () => {
    const content = '平台手册3第一章 概述1.1. 系统简介依据调查制度开发建设，具有自动采集功能。1.2. 编写目的辅助用户完成填报。'
    const blocks = formatDocumentText(content)
    expect(blocks[0]).toEqual({ type: 'paragraph', text: '平台手册3' })
    expect(blocks[1]).toEqual({ type: 'heading', level: 1, text: '第一章 概述' })
    expect(blocks.slice(2).every((block) => block.type === 'paragraph')).toBe(true)
    expect(blocks.flatMap((block) => block.type === 'list' ? block.items : [block.text]).join('')).toBe(content)
  })

  it('keeps dates, decimals, and version numbers inside an unbroken paragraph', () => {
    const content = '发布于2026年1月，版本1.2.3，样本比例约 1.1，详见第3章。'
    expect(formatDocumentText(content)).toEqual([{ type: 'paragraph', text: content }])
  })

  it('keeps an inline table series in the paragraph and lists complete numbered steps', () => {
    const series = '只显示基表 1、基表 2，不显示基表 3、基表 4。说明（或基表 4）继续。'
    expect(formatDocumentText(series)).toEqual([{ type: 'paragraph', text: series }])
    const steps = '说明如下。2.上报：完成上报。3.打印：打印出来。'
    expect(formatDocumentText(steps)).toEqual([
      { type: 'paragraph', text: '说明如下。' },
      { type: 'list', items: ['2.上报：完成上报。', '3.打印：打印出来。'] },
    ])
  })

  it('renders numbered lines and bullet lines as lists when the page has line breaks', () => {
    const blocks = formatDocumentText('1、打开登录页并输入账号。\n2、修改初始密码。\n\n• 组块\n• 图式')
    expect(blocks).toEqual([
      { type: 'list', items: ['1、打开登录页并输入账号。', '2、修改初始密码。'] },
      { type: 'list', items: ['• 组块', '• 图式'] },
    ])
  })
})
