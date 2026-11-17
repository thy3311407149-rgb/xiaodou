const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f'])
const TWO_CHAR_OPERATORS = new Set(['<=', '>=', '!=', '<>', '||', '=='])

/**
 * Normalize SQLite SQL for structural comparison.
 * Whitespace and comments outside literals are collapsed. Spaces inside
 * string, identifier, and blob literals stay intact.
 */
export function normalizeSql(sql: string): string {
  return tokenizeSql(sql).join(' ')
}

export function tokenizeSql(sql: string): string[] {
  const tokens: string[] = []
  let index = 0

  while (index < sql.length) {
    const current = sql[index] ?? ''
    const next = sql[index + 1] ?? ''

    if (current === '-' && next === '-') {
      index += 2
      while (index < sql.length && sql[index] !== '\n') index += 1
      continue
    }

    if (current === '/' && next === '*') {
      index += 2
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1
      index = Math.min(sql.length, index + 2)
      continue
    }

    if (WHITESPACE.has(current)) {
      index += 1
      continue
    }

    if ((current === 'X' || current === 'x') && next === "'") {
      const token = readQuoted(sql, index + 1, "'")
      tokens.push(sql.slice(index, index + 1 + token.length))
      index += 1 + token.length
      continue
    }

    if (current === "'") {
      const token = readQuoted(sql, index, "'")
      tokens.push(token)
      index += token.length
      continue
    }

    if (current === '"') {
      const token = readQuoted(sql, index, '"')
      tokens.push(token)
      index += token.length
      continue
    }

    if (current === '`') {
      const token = readQuoted(sql, index, '`')
      tokens.push(token)
      index += token.length
      continue
    }

    if (current === '[') {
      const end = sql.indexOf(']', index + 1)
      const token = end === -1 ? sql.slice(index) : sql.slice(index, end + 1)
      tokens.push(token)
      index += token.length
      continue
    }

    if (isIdentifierStart(current)) {
      let end = index + 1
      while (end < sql.length && isIdentifierPart(sql[end] ?? '')) end += 1
      tokens.push(sql.slice(index, end))
      index = end
      continue
    }

    if (isDigit(current) || (current === '.' && isDigit(next))) {
      let end = index + 1
      while (end < sql.length && /[0-9A-Fa-fx.]/u.test(sql[end] ?? '')) end += 1
      tokens.push(sql.slice(index, end))
      index = end
      continue
    }

    const pair = sql.slice(index, index + 2)
    if (TWO_CHAR_OPERATORS.has(pair)) {
      tokens.push(pair)
      index += 2
      continue
    }

    tokens.push(current)
    index += 1
  }

  return tokens
}

function readQuoted(sql: string, start: number, quote: string): string {
  let index = start + 1
  while (index < sql.length) {
    if (sql[index] === quote && sql[index + 1] === quote) {
      index += 2
      continue
    }
    if (sql[index] === quote) {
      return sql.slice(start, index + 1)
    }
    index += 1
  }
  return sql.slice(start)
}

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_]/u.test(character)
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_]/u.test(character)
}

function isDigit(character: string): boolean {
  return /[0-9]/u.test(character)
}
