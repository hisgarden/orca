import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCAD_BUN_VERSION } from '../../shared/orcad-bun-runtime'
import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const execCommandMock = vi.hoisted(() => vi.fn())
const materializeMock = vi.hoisted(() => vi.fn())
const uploadMock = vi.hoisted(() => vi.fn())

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: execCommandMock }))
vi.mock('./orcad-bun-runtime-materializer', () => ({
  materializeCachedOrcadBunRuntime: materializeMock
}))
vi.mock('./ssh-relay-install-transfers', () => ({ uploadRelayDirectory: uploadMock }))
vi.mock('./orcad-deployment-target', () => ({
  resolveOrcadDeploymentTarget: vi.fn().mockResolvedValue('linux-x64-glibc')
}))

const {
  ensureRemoteBundledBun,
  parseBundledBunResult,
  probeBundledBunCommand,
  promoteBundledBunCommand
} = await import('./ssh-remote-bundled-bun')

const conn: SshConnection = Object.create(null)

describe('parseBundledBunResult', () => {
  it('reads only the marker line, ignoring shell noise', () => {
    expect(parseBundledBunResult('motd\nORCA_BUNDLED_BUN:READY:/h/.orca-remote/b/bun\n')).toEqual({
      status: 'ready',
      path: '/h/.orca-remote/b/bun'
    })
    expect(parseBundledBunResult('ORCA_BUNDLED_BUN:MISSING:/home/u')).toEqual({
      status: 'missing',
      home: '/home/u'
    })
    expect(parseBundledBunResult('ORCA_BUNDLED_BUN:NO_SHA_TOOL')).toEqual({ status: 'unusable' })
    expect(parseBundledBunResult('')).toEqual({ status: 'unusable' })
  })
})

describe.runIf(process.platform !== 'win32')('bundled Bun shell verification', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'orca-bundled-bun-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  function fakeBun(dir: string, version: string): { sha: string } {
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'bun')
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`)
    chmodSync(file, 0o644)
    return { sha: createHash('sha256').update(readFileSync(file)).digest('hex') }
  }

  function sh(script: string): string {
    return execFileSync('/bin/sh', ['-c', script], {
      env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      encoding: 'utf8'
    })
  }

  it('promotes a staged binary whose hash and version match, then probes it ready', () => {
    const stage = path.join(home, 'stage')
    const { sha } = fakeBun(stage, ORCAD_BUN_VERSION)
    const target = { executableSha256: sha }
    expect(parseBundledBunResult(sh(probeBundledBunCommand(target))).status).toBe('missing')

    const promoted = parseBundledBunResult(sh(promoteBundledBunCommand(target, stage)))
    const installed = path.join(home, '.orca-remote', 'vault-sqlite', sha, 'bun')
    expect(promoted).toEqual({ status: 'ready', path: installed })
    expect(existsSync(stage)).toBe(false)
    expect(parseBundledBunResult(sh(probeBundledBunCommand(target)))).toEqual({
      status: 'ready',
      path: installed
    })
  })

  it('rejects a binary whose hash does not match and removes the stage', () => {
    const stage = path.join(home, 'stage')
    fakeBun(stage, ORCAD_BUN_VERSION)
    const result = sh(promoteBundledBunCommand({ executableSha256: 'f'.repeat(64) }, stage))
    expect(parseBundledBunResult(result)).toEqual({ status: 'unusable' })
    expect(existsSync(stage)).toBe(false)
  })

  it('rejects a hash-matching binary that does not report the pinned version', () => {
    const stage = path.join(home, 'stage')
    const { sha } = fakeBun(stage, '0.0.1')
    const result = sh(promoteBundledBunCommand({ executableSha256: sha }, stage))
    expect(parseBundledBunResult(result)).toEqual({ status: 'unusable' })
  })
})

describe('ensureRemoteBundledBun', () => {
  const linux = getRemoteHostPlatform('linux-x64')

  beforeEach(() => {
    execCommandMock.mockReset()
    materializeMock.mockReset()
    uploadMock.mockReset()
  })

  it('reuses a verified runtime without downloading or uploading', async () => {
    execCommandMock.mockResolvedValueOnce('ORCA_BUNDLED_BUN:READY:/root/.orca-remote/v/bun\n')
    await expect(ensureRemoteBundledBun(conn, linux)).resolves.toBe('/root/.orca-remote/v/bun')
    expect(materializeMock).not.toHaveBeenCalled()
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('uploads the locally verified pinned Bun and returns the host-verified path', async () => {
    const cacheRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-bun-cache-'))
    try {
      const localRuntime = path.join(cacheRoot, 'bun')
      writeFileSync(localRuntime, 'binary')
      materializeMock.mockResolvedValueOnce(localRuntime)
      uploadMock.mockResolvedValueOnce(undefined)
      execCommandMock
        .mockResolvedValueOnce('ORCA_BUNDLED_BUN:MISSING:/root\n')
        .mockResolvedValueOnce('') // mkdir -p stage
        .mockResolvedValueOnce('ORCA_BUNDLED_BUN:READY:/root/.orca-remote/v/bun\n')

      await expect(ensureRemoteBundledBun(conn, linux, { cacheRoot })).resolves.toBe(
        '/root/.orca-remote/v/bun'
      )
      expect(materializeMock).toHaveBeenCalledWith('linux-x64-glibc', cacheRoot, expect.anything())
      expect(String(uploadMock.mock.calls[0]![2])).toMatch(
        /^\/root\/\.orca-remote\/vault-sqlite\/\.upload-[0-9a-f]{16}$/
      )
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  })

  it('gives up without uploading when the host cannot hash files', async () => {
    execCommandMock.mockResolvedValueOnce('ORCA_BUNDLED_BUN:NO_SHA_TOOL\n')
    await expect(ensureRemoteBundledBun(conn, linux)).resolves.toBeNull()
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('never runs on Windows hosts', async () => {
    await expect(
      ensureRemoteBundledBun(conn, getRemoteHostPlatform('win32-x64'))
    ).resolves.toBeNull()
    expect(execCommandMock).not.toHaveBeenCalled()
  })
})
