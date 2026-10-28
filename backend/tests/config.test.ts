import { describe, expect, it } from 'vitest'
import { createConfig, readAllowedOrigins } from '../app/core/config.js'

describe('runtime config', () => {
  it('reads HOST and PORT from the environment without starting the server', () => {
    const config = createConfig({ HOST: '0.0.0.0', PORT: '4100' })

    expect(config.host).toBe('0.0.0.0')
    expect(config.port).toBe(4100)
  })

  it('keeps the local HOST and PORT defaults when they are absent', () => {
    const config = createConfig({})

    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(3000)
  })

  it('reads UPLOAD_DIR and drops wildcard CORS origins', () => {
    const config = createConfig({
      UPLOAD_DIR: '/data/uploads',
      CORS_ALLOWED_ORIGINS: ' https://app.example , *, https://*.example.com, https://localhost ',
    })

    expect(config.uploadDir).toBe('/data/uploads')
    expect(config.corsAllowedOrigins).toEqual(['https://app.example', 'https://localhost'])
    expect(readAllowedOrigins('*')).toEqual([])
  })
})
