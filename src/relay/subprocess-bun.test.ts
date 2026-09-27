import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { build } from 'esbuild'
import { spawnRelay, type RelayProcess } from './subprocess-test-utils'
import { relayTestSocketPath } from './relay-test-socket-path'
import { BUN_RELAY_RUNTIME_FLAGS } from '../shared/relay-bun-runtime'

function findBun(): string | null {
  const candidate = process.env.ORCA_TEST_BUN ?? 'bun'
  try {
    execFileSync(candidate, ['--version'], { stdio: 'ignore' })
    return candidate
  } catch {
    return null
  }
}

const bun = process.platform === 'win32' ? null : findBun()
const tempDirs: string[] = []
let relayEntry: string
let relay: RelayProcess | null = null

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function readWhenWritten(file: string): string | null {
  // Why the newline check: the shell may be mid-write when the file first appears.
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  return text.endsWith('\n') ? text.trim() : null
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe.skipIf(!bun)('relay running under Bun', () => {
  beforeAll(async () => {
    // Why no node_modules beside the bundle: a Bun host has no node-pty, so terminals must come from Bun.Terminal.
    relayEntry = path.join(tempDir('relay-bun-bundle-'), 'relay.js')
    await build({
      entryPoints: [path.resolve(__dirname, 'relay.ts')],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: relayEntry,
      external: ['node-pty', '@parcel/watcher', 'electron'],
      sourcemap: false
    })
  }, 30_000)

  afterEach(() => {
    relay?.proc.kill('SIGKILL')
    relay = null
  })

  afterAll(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('spawns, drives, resizes, and exits a terminal without node-pty', async () => {
    const socketDir = tempDir('relay-bun-sock-')
    relay = spawnRelay(
      relayEntry,
      [
        '--sock-path',
        relayTestSocketPath(socketDir),
        '--endpoint-dir',
        path.join(socketDir, 'agent-hooks')
      ],
      {
        runtime: bun ?? 'bun',
        runtimeArgs: [...BUN_RELAY_RUNTIME_FLAGS],
        env: { ...process.env, SHELL: '/bin/sh' }
      }
    )
    await relay.sentinelReceived

    const spawned = await relay.waitForResponse(
      relay.send('pty.spawn', { cols: 80, rows: 24, cwd: socketDir })
    )
    expect(spawned.error).toBeUndefined()
    const ptyId: unknown = Reflect.get(Object(spawned.result), 'id')
    expect(typeof ptyId).toBe('string')

    // Why files: pty.data only reaches clients holding a consumer grant; the shell's own writes
    // prove input reached it and that the kernel terminal, not just our bookkeeping, resized.
    const evalFile = path.join(socketDir, 'eval.txt')
    const sizeFile = path.join(socketDir, 'size.txt')
    relay.sendNotification('pty.data', { id: ptyId, data: `echo $((20+22)) > '${evalFile}'\n` })
    await waitFor(() => readWhenWritten(evalFile) !== null, 'shell input')
    expect(readWhenWritten(evalFile)).toBe('42')

    relay.sendNotification('pty.resize', { id: ptyId, cols: 101, rows: 33 })
    const size = await relay.waitForResponse(relay.send('pty.getSize', { id: ptyId }))
    expect(size.result).toEqual({ cols: 101, rows: 33 })
    relay.sendNotification('pty.data', { id: ptyId, data: `stty size > '${sizeFile}'\n` })
    await waitFor(() => readWhenWritten(sizeFile) !== null, 'terminal size')
    expect(readWhenWritten(sizeFile)).toBe('33 101')

    const exitNotification = relay.waitForNotification('pty.exit')
    relay.sendNotification('pty.data', { id: ptyId, data: 'exit 3\n' })
    expect((await exitNotification).params).toMatchObject({ id: ptyId, code: 3 })
  }, 20_000)
})
