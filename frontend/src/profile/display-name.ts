export const nickname = 'Tina'

export function avatarLetter(name: string): string {
  const first = Array.from(name.trim())[0]
  return first ? first.toLocaleUpperCase() : ''
}
