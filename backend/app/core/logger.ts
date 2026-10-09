export type LogLevel = 'info' | 'warn' | 'error'

export type LogFields = {
  requestId?: string
  fileId?: string
  taskId?: string
  operation?: string
  status?: string
  durationMs?: number
  errorCode?: string
  method?: string
  path?: string
  statusCode?: number
  [key: string]: unknown
}

function write(level: LogLevel, event: string, fields: LogFields = {}): void {
  const entry = {
    level,
    timestamp: new Date().toISOString(),
    event,
    ...fields,
  }
  const output = JSON.stringify(entry)

  if (level === 'error') {
    console.error(output)
  } else if (level === 'warn') {
    console.warn(output)
  } else {
    console.info(output)
  }
}

export const logger = {
  info(event: string, fields?: LogFields): void {
    write('info', event, fields)
  },
  warn(event: string, fields?: LogFields): void {
    write('warn', event, fields)
  },
  error(event: string, fields?: LogFields): void {
    write('error', event, fields)
  },
}
