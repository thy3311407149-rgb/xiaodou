import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const certDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../certs')

function developmentHttps(): { key: Buffer; cert: Buffer } | undefined {
  if (process.env.VITE_DEV_HTTPS !== '1') return undefined
  const keyPath = path.join(certDirectory, 'dev-key.pem')
  const certPath = path.join(certDirectory, 'dev-cert.pem')
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    throw new Error('缺少 HTTPS 开发证书。请在仓库根目录用 mkcert 生成 certs/dev-cert.pem 和 certs/dev-key.pem。')
  }
  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  }
}

function isDevBrowserOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.username || url.password || (url.protocol !== 'http:' && url.protocol !== 'https:')) return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return false
  const parts = match.slice(1).map(Number)
  if (parts.some((part) => part > 255)) return false
  const [first, second] = parts
  if (first === 10 || first === 127) return true
  if (first === 192 && second === 168) return true
  return first === 172 && second >= 16 && second <= 31
}

const https = developmentHttps()

export default defineConfig({
  plugins: [react()],
  server: {
    ...(https ? { host: '0.0.0.0', port: 5173, https } : {}),
    cors: {
      origin(origin, callback) {
        // cors reports success with a null error. Vite types that argument as Error.
        const report = callback as (error: Error | null, allowed: boolean) => void
        report(null, !origin || isDevBrowserOrigin(origin))
      },
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
