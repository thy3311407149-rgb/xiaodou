import { describe, expect, it } from 'vitest'
import { avatarLetter } from './display-name.ts'

describe('avatar letter', () => {
  it('uses the first character of the nickname', () => {
    expect(avatarLetter('Tina')).toBe('T')
    expect(avatarLetter(' 小豆 ')).toBe('小')
    expect(avatarLetter('')).toBe('')
  })
})