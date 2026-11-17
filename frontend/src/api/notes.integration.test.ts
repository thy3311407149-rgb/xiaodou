// @ts-nocheck
import { spawn, type ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApiError, createHttp } from './http.ts'
import { createNote, deleteNote, fetchNoteList, updateNote } from './notes.ts'

const backendRoot = 'D:\\项目文件-be\\backend'
const devDatabase = resolve(backendRoot, 'data/app.db')

let server: ChildProcess | null = null
let directory = ''
let baseUrl = ''
let devDatabaseStamp: { mtimeMs: number; size: number } | null = null

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolveListen, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()))
  return port
}

async function waitForServer(child: ChildProcess): Promise<void> {
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  await new Promise<void>((resolveStarted, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('isolated note API did not start'))
    }, 20000)
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolveStarted()
    }
    child.on('exit', (code) => finish(new Error(`isolated note API exited ${code ?? 'unknown'}`)))
    const poll = () => {
      if (settled) return
      if (output.includes('Backend listening')) finish()
      else setTimeout(poll, 50)
    }
    poll()
  })
}

describe('note API in an isolated database', () => {
  beforeAll(async () => {
    try {
      const stat = statSync(devDatabase)
      devDatabaseStamp = { mtimeMs: stat.mtimeMs, size: stat.size }
    } catch {
      devDatabaseStamp = null
    }
    directory = await mkdtemp(join(tmpdir(), 'xiaodou-notes-'))
    const port = await freePort()
    baseUrl = `http://127.0.0.1:${port}`
    const databasePath = join(directory, 'notes.db')
    expect(resolve(databasePath)).not.toBe(devDatabase)
    server = spawn(process.execPath, [join(backendRoot, 'node_modules/tsx/dist/cli.mjs'), 'app/server.ts'], {
      cwd: backendRoot,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        DATABASE_PATH: databasePath,
        UPLOAD_DIR: join(directory, 'uploads'),
        RECORDING_DIR: join(directory, 'recordings'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForServer(server)
  }, 30000)

  afterAll(async () => {
    const child = server
    if (child && child.exitCode == null) {
      await new Promise<void>((resolveStop) => {
        const timer = setTimeout(resolveStop, 5000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolveStop()
        })
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      })
    }
    server = null
    if (directory) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          await rm(directory, { recursive: true, force: true })
          break
        } catch (error) {
          if (attempt === 7) throw error
          await new Promise((resolveRetry) => setTimeout(resolveRetry, 250))
        }
      }
    }
    if (devDatabaseStamp) {
      const stat = statSync(devDatabase)
      expect(stat.size).toBe(devDatabaseStamp.size)
    }
  })

  it('creates, edits, reloads, and deletes one note without duplicating a replay', async () => {
    const client = createHttp(fetch, { baseUrl, production: false })
    const created = await createNote({
      idempotencyKey: 'isolated-note',
      title: '小记 · 待办',
      tags: ['TODO'],
      bodyHtml: '<p>刷新后还在</p>',
    }, client.request)
    const replay = await createNote({
      idempotencyKey: 'isolated-note',
      title: '小记 · 待办',
      tags: ['TODO'],
      bodyHtml: '<p>刷新后还在</p>',
    }, client.request)
    expect(replay.noteId).toBe(created.noteId)

    const listed = await fetchNoteList(1, 20, client.request)
    expect(listed.total).toBe(1)
    expect(listed.items.map((item) => item.noteId)).toEqual([created.noteId])
    expect(listed.items[0]).toMatchObject({ title: '小记 · 待办', bodyText: '刷新后还在', tags: ['TODO'] })

    const updated = await updateNote(created.noteId, { bodyHtml: '<p>修改后还在</p>' }, client.request)
    const reloaded = await fetchNoteList(1, 20, client.request)
    expect(reloaded.items[0]).toMatchObject({ noteId: created.noteId, bodyText: '修改后还在', bodyHtml: updated.bodyHtml })

    await deleteNote(created.noteId, client.request)
    await expect(fetchNoteList(1, 20, client.request)).resolves.toMatchObject({ total: 0, items: [] })
    await expect(deleteNote(created.noteId, client.request)).rejects.toMatchObject({ status: 404, code: 'NOTE_NOT_FOUND' })
  })

  it('keeps the original note when the same idempotency key is reused for different content', async () => {
    const client = createHttp(fetch, { baseUrl, production: false })
    const created = await createNote({
      idempotencyKey: 'isolated-conflict',
      title: '小记 · 灵感',
      tags: ['IDEA'],
      bodyHtml: '<p>第一稿</p>',
    }, client.request)
    await expect(createNote({
      idempotencyKey: 'isolated-conflict',
      title: '小记 · 灵感',
      tags: ['IDEA'],
      bodyHtml: '<p>另一稿</p>',
    }, client.request)).rejects.toBeInstanceOf(ApiError)
    const listed = await fetchNoteList(1, 20, client.request)
    expect(listed.items.filter((item) => item.noteId === created.noteId)).toHaveLength(1)
    expect(listed.total).toBe(1)
    await deleteNote(created.noteId, client.request)
  })
})
