import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const execCommandMock = vi.hoisted(() => vi.fn())
const ensureRemoteBundledBunMock = vi.hoisted(() => vi.fn())

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: execCommandMock
}))
vi.mock('./ssh-remote-bundled-bun', () => ({
  ensureRemoteBundledBun: ensureRemoteBundledBunMock
}))

const { REMOTE_BUN_PROBE_SCRIPT, resolveRemoteBunPath, selectRemoteBun } =
  await import('./ssh-remote-bun-resolution')

const conn: SshConnection = Object.create(null)
const linux = getRemoteHostPlatform('linux-x64')

describe('selectRemoteBun', () => {
  it('takes the first candidate at or above the Bun.Terminal floor', () => {
    const output = [
      '/usr/bin/bun\t1.2.21',
      '/home/u/.bun/bin/bun\t1.3.5',
      '/usr/local/bin/bun\t1.4.2'
    ].join('\n')
    expect(selectRemoteBun(output)).toBe('/home/u/.bun/bin/bun')
  })

  it('accepts prerelease builds and rejects unparseable or older versions', () => {
    expect(selectRemoteBun('/opt/bun\t1.4.2-canary.1+744846f84')).toBe('/opt/bun')
    expect(selectRemoteBun('/opt/bun\tbun: cannot execute binary file')).toBeNull()
    expect(selectRemoteBun('/opt/bun\t1.3.4\n\n')).toBeNull()
    expect(selectRemoteBun('/opt/bun\t0.9.9')).toBeNull()
  })
})

describe.runIf(process.platform !== 'win32')('REMOTE_BUN_PROBE_SCRIPT', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'orca-bun-probe-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function fakeBun(dir: string, version: string): string {
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'bun')
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`)
    chmodSync(file, 0o755)
    return file
  }

  it('versions PATH and ~/.bun candidates for an exec channel without a profile', () => {
    const onPath = fakeBun(path.join(root, 'path dir'), '1.2.0')
    const home = path.join(root, 'home')
    const installed = fakeBun(path.join(home, '.bun', 'bin'), '1.3.5')
    const output = execFileSync('/bin/sh', ['-c', REMOTE_BUN_PROBE_SCRIPT], {
      env: { HOME: home, PATH: `${path.dirname(onPath)}:/usr/bin:/bin` },
      encoding: 'utf8'
    })
    expect(output).toContain(`${onPath}\t1.2.0`)
    expect(output).toContain(`${installed}\t1.3.5`)
    expect(selectRemoteBun(output)).toBe(installed)
  })

  it('succeeds with no output on a host without Bun', () => {
    const output = execFileSync('/bin/sh', ['-c', REMOTE_BUN_PROBE_SCRIPT], {
      env: { HOME: path.join(root, 'empty-home'), PATH: '/nonexistent' },
      encoding: 'utf8'
    })
    expect(output.trim()).toBe('')
  })
})

describe('resolveRemoteBunPath', () => {
  const savedOverride = process.env.ORCA_SSH_RELAY_RUNTIME

  beforeEach(() => {
    execCommandMock.mockReset()
    ensureRemoteBundledBunMock.mockReset()
    ensureRemoteBundledBunMock.mockResolvedValue(null)
    delete process.env.ORCA_SSH_RELAY_RUNTIME
  })

  afterEach(() => {
    if (savedOverride === undefined) {
      delete process.env.ORCA_SSH_RELAY_RUNTIME
    } else {
      process.env.ORCA_SSH_RELAY_RUNTIME = savedOverride
    }
  })

  it('returns the host Bun from one exec and never uploads', async () => {
    execCommandMock.mockResolvedValueOnce('/home/u/.bun/bin/bun\t1.3.5\n')
    await expect(resolveRemoteBunPath(conn, linux)).resolves.toBe('/home/u/.bun/bin/bun')
    expect(execCommandMock).toHaveBeenCalledTimes(1)
    expect(ensureRemoteBundledBunMock).not.toHaveBeenCalled()
  })

  it("falls back to Orca's pinned Bun when the host has none", async () => {
    execCommandMock.mockResolvedValueOnce('')
    ensureRemoteBundledBunMock.mockResolvedValueOnce('/root/.orca-remote/vault-sqlite/abc/bun')
    await expect(resolveRemoteBunPath(conn, linux)).resolves.toBe(
      '/root/.orca-remote/vault-sqlite/abc/bun'
    )
  })

  it('skips the upload when ORCA_SSH_RELAY_RUNTIME=host', async () => {
    process.env.ORCA_SSH_RELAY_RUNTIME = 'host'
    execCommandMock.mockResolvedValueOnce('')
    await expect(resolveRemoteBunPath(conn, linux)).resolves.toBeNull()
    expect(ensureRemoteBundledBunMock).not.toHaveBeenCalled()
  })

  it('treats a failed probe or upload as no Bun rather than an error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    execCommandMock.mockRejectedValueOnce(new Error('channel closed'))
    ensureRemoteBundledBunMock.mockRejectedValueOnce(new Error('download failed'))
    await expect(resolveRemoteBunPath(conn, linux)).resolves.toBeNull()
  })

  it('rethrows an aborted bootstrap instead of reporting no Bun', async () => {
    const controller = new AbortController()
    controller.abort()
    execCommandMock.mockRejectedValueOnce(new Error('aborted'))
    await expect(resolveRemoteBunPath(conn, linux, { signal: controller.signal })).rejects.toThrow()
    expect(ensureRemoteBundledBunMock).not.toHaveBeenCalled()
  })
})
