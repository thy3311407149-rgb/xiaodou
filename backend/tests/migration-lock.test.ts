import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATION_LOCK_TIMEOUT_MS } from '../app/db/migration-lock.js'

const children: ChildProcess[] = []
let temporaryDirectory: string | undefined

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
  await Promise.all(children.map((child) => exitOf(child)))
  children.length = 0
  if (temporaryDirectory) {
    const directory = temporaryDirectory
    temporaryDirectory = undefined
    rmSync(directory, { recursive: true, force: true })
  }
}, 20_000)

describe('migration lock', () => {
  it('uses a 10 second default wait', () => {
    expect(MIGRATION_LOCK_TIMEOUT_MS).toBe(10_000)
  })

  it('makes a second process wait until the first process releases the lock', async () => {
    const databasePath = tempDatabasePath()
    const readyPath = join(temporaryDirectory!, 'ready')
    const releasePath = join(temporaryDirectory!, 'release')
    const resultPath = join(temporaryDirectory!, 'result.json')
    const holder = spawnWorker(['hold', databasePath, readyPath, releasePath])
    await waitForFile(readyPath)

    const attemptPath = join(temporaryDirectory!, 'attempt')
    const waiter = spawnWorker(['acquire', databasePath, attemptPath, resultPath, '10000'])
    await waitForFile(attemptPath)
    await delay(700)
    expect(existsSync(resultPath)).toBe(false)

    writeFileSync(releasePath, 'go')
    const result = await readJsonWhenReady(resultPath)
    await exitOf(holder)
    await exitOf(waiter)

    expect(result.ok).toBe(true)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(700)
    expect(result.row).toMatchObject({ id: 1 })
  })

  it('reports a lock timeout once the 10 second wait is exhausted', async () => {
    const databasePath = tempDatabasePath()
    const readyPath = join(temporaryDirectory!, 'ready')
    const releasePath = join(temporaryDirectory!, 'release')
    const resultPath = join(temporaryDirectory!, 'result.json')
    const holder = spawnWorker(['hold', databasePath, readyPath, releasePath])
    await waitForFile(readyPath)

    const attemptPath = join(temporaryDirectory!, 'attempt')
    const waiter = spawnWorker(['acquire', databasePath, attemptPath, resultPath, String(MIGRATION_LOCK_TIMEOUT_MS)])
    await waitForFile(attemptPath)
    const result = await readJsonWhenReady(resultPath, 15_000)
    writeFileSync(releasePath, 'go')
    await exitOf(holder)
    await exitOf(waiter)

    expect(result.ok).toBe(false)
    expect(result.name).toBe('MigrationLockError')
    expect(result.message).toContain('10000ms')
    expect(result.elapsedMs).toBeGreaterThanOrEqual(10_000)
  }, 25_000)

  it('releases the lock when the holding process is terminated', async () => {
    const databasePath = tempDatabasePath()
    const readyPath = join(temporaryDirectory!, 'ready')
    const releasePath = join(temporaryDirectory!, 'release')
    const resultPath = join(temporaryDirectory!, 'result.json')
    const holder = spawnWorker(['hold', databasePath, readyPath, releasePath])
    await waitForFile(readyPath)
    holder.kill()
    await exitOf(holder)

    const waiter = spawnWorker(['acquire', databasePath, join(temporaryDirectory!, 'attempt'), resultPath, '5000'])
    const result = await readJsonWhenReady(resultPath)
    await exitOf(waiter)
    expect(result.ok).toBe(true)
  }, 15_000)

  it('blocks a business connection only while the migration connection stays open', async () => {
    const databasePath = tempDatabasePath()
    const readyPath = join(temporaryDirectory!, 'ready')
    const releasePath = join(temporaryDirectory!, 'release')
    const blockedPath = join(temporaryDirectory!, 'blocked.json')
    const openedPath = join(temporaryDirectory!, 'opened.json')
    const holder = spawnWorker(['hold', databasePath, readyPath, releasePath])
    await waitForFile(readyPath)

    const blocked = spawnWorker(['read', databasePath, '', blockedPath, '300'])
    const blockedResult = await readJsonWhenReady(blockedPath)
    await exitOf(blocked)
    expect(blockedResult.ok).toBe(false)

    writeFileSync(releasePath, 'go')
    await exitOf(holder)
    const opened = spawnWorker(['read', databasePath, '', openedPath, '3000'])
    const openedResult = await readJsonWhenReady(openedPath)
    await exitOf(opened)
    expect(openedResult.ok).toBe(true)
  })
})

function tempDatabasePath(): string {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'xiaodou-lock-'))
  return join(temporaryDirectory, 'lock.db')
}

function spawnWorker(args: string[]): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/migration-lock-worker.ts', ...args], {
    cwd: process.cwd(),
    stdio: 'ignore',
  })
  children.push(child)
  return child
}

async function waitForFile(path: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}`)
    await delay(40)
  }
}

async function readJsonWhenReady(path: string, timeoutMs = 8_000): Promise<{ ok: boolean; elapsedMs?: number; name?: string; message?: string; row?: { id: number } }> {
  await waitForFile(path, timeoutMs)
  return JSON.parse(readFileSync(path, 'utf8')) as { ok: boolean; elapsedMs?: number; name?: string; message?: string; row?: { id: number } }
}

function exitOf(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(child.exitCode), 5_000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
