// Why: a Bun host has no npm and no node-pty; deploy must install only the watcher, with Bun.

import type * as RelayRipgrepInstallModule from './ssh-relay-ripgrep-install'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RelayInstallMarkerModule from './ssh-relay-install-marker'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/app' }
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('0.1.0+testhash')
}))

vi.mock('./relay-protocol', () => ({
  RELAY_VERSION: '0.1.0',
  RELAY_REMOTE_DIR: '.orca-remote',
  parseUnameToRelayPlatform: vi.fn().mockReturnValue('linux-x64'),
  RELAY_SENTINEL: 'ORCA-RELAY v0.1.0 READY\n',
  RELAY_SENTINEL_TIMEOUT_MS: 10_000
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({
  uploadDirectory: vi.fn().mockResolvedValue(undefined),
  waitForSentinel: vi.fn().mockResolvedValue({
    write: vi.fn(),
    onData: vi.fn(),
    onClose: vi.fn()
  }),
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error &&
    (error as Error & { sshChannelCloseConfirmed?: boolean }).sshChannelCloseConfirmed === false,
  execCommand: vi.fn()
}))

vi.mock('./ssh-remote-node-resolution', () => ({
  resolveRemoteNodePath: vi.fn().mockResolvedValue('/usr/bin/node')
}))
vi.mock('./ssh-remote-bun-resolution', () => ({
  resolveRemoteBunPath: vi.fn().mockResolvedValue('/home/u/.bun/bin/bun')
}))

vi.mock('./ssh-relay-install-marker', async (importOriginal) => ({
  ...(await importOriginal<typeof RelayInstallMarkerModule>()),
  createRelayInstallMarkerFileName: () => '.sftp-namespace-00000000000000000000000000000000'
}))

// Why: the post-launch ripgrep install would consume this file's queued exec mocks.
// Why: the post-launch ripgrep cache GC is fire-and-forget and would drain the queued exec mocks.
vi.mock('./ssh-relay-ripgrep-cache-gc', () => ({ gcRemoteRipgrepCache: vi.fn() }))
vi.mock('./ssh-relay-opencode-runtime', () => ({
  ensureRemoteOpenCodeRuntime: vi.fn().mockResolvedValue('ready')
}))
vi.mock('./ssh-relay-ripgrep-install', async (importOriginal) => ({
  ...(await importOriginal<typeof RelayRipgrepInstallModule>()),
  ensureRemoteBundledRipgrep: vi.fn().mockResolvedValue('present'),
  recordRemoteRipgrepReference: vi.fn().mockResolvedValue(true)
}))

vi.mock('./ssh-relay-versioned-install', () => ({
  readLocalFullVersion: vi.fn().mockReturnValue('0.1.0+testhash'),
  computeRemoteRelayDir: (home: string, v: string) => `${home}/.orca-remote/relay-${v}`,
  isRelayAlreadyInstalled: vi.fn().mockResolvedValue(false),
  finalizeInstall: vi.fn().mockResolvedValue(undefined),
  abandonInstall: vi.fn().mockResolvedValue(undefined),
  gcOldRelayVersions: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-relay-install-lock', () => ({
  acquireInstallLock: vi.fn().mockResolvedValue(undefined),
  RELAY_INSTALL_LOCK_NAME: '.install-lock'
}))

vi.mock('./ssh-relay-repair-lock', () => ({
  tryAcquireRelayRepairLock: vi.fn().mockResolvedValue('acquired')
}))

vi.mock('./ssh-relay-gc-claim', () => ({
  releaseRelayGcClaimWithRetry: vi.fn().mockResolvedValue('released'),
  tryAcquireRelayGcClaim: vi.fn().mockResolvedValue('launch-token'),
  waitForRelayGcClaimRelease: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-connection-utils', () => ({
  shellEscape: (s: string) => `'${s}'`
}))

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand, uploadDirectory } from './ssh-relay-deploy-helpers'
import { parseUnameToRelayPlatform } from './relay-protocol'
import { resolveRemoteNodePath } from './ssh-remote-node-resolution'
import { finalizeInstall, isRelayAlreadyInstalled } from './ssh-relay-versioned-install'
import {
  makeMockConnection,
  makeStagedFirstInstallExecPrefix,
  type ExecResponse,
  type SftpWriteCapture
} from './ssh-relay-native-deps-install-fixture'

const BUN = "'/home/u/.bun/bin/bun'"

function feed(execResponses: ExecResponse[]): void {
  for (const response of execResponses) {
    if (typeof response === 'string') {
      vi.mocked(execCommand).mockResolvedValueOnce(response)
    } else {
      vi.mocked(execCommand).mockRejectedValueOnce(new Error(response.reject))
    }
  }
}

function commandsRun(conn: ReturnType<typeof makeMockConnection>): string[] {
  const viaExecCommand = vi.mocked(execCommand).mock.calls.map((call) => String(call[1]))
  const viaChannel = vi.mocked(conn.exec).mock.calls.map((call) => String(call[0]))
  return [...viaExecCommand, ...viaChannel]
}

describe('deployAndLaunchRelay on a Bun host', () => {
  const sftpCapture: SftpWriteCapture = { paths: [], contents: {}, execCallCountAtWrite: {} }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(execCommand).mockReset().mockResolvedValue('')
    vi.mocked(uploadDirectory).mockResolvedValue(undefined)
    vi.mocked(parseUnameToRelayPlatform).mockReturnValue('linux-x64')
    sftpCapture.paths.length = 0
    for (const key of Object.keys(sftpCapture.contents)) {
      delete sftpCapture.contents[key]
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('installs only the watcher with Bun, never npm, and launches with --no-install', async () => {
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(false)
    const conn = makeMockConnection(sftpCapture)
    feed([
      // No shared-cache probe: Bun never attaches the Node-keyed native-deps cache.
      ...makeStagedFirstInstallExecPrefix().slice(0, -1),
      '', // bun install
      'ORCA-NATIVE-DEPS-OK\n', // watcher probe under Bun
      '', // clean stage root
      'DEAD',
      '', // publish the per-launch credential
      'READY'
    ])

    await deployAndLaunchRelay(conn)

    const commands = commandsRun(conn)
    expect(commands.some((command) => /\bnpm\b/.test(command))).toBe(false)
    expect(commands).toContainEqual(
      expect.stringContaining(`${BUN} install --production --ignore-scripts`)
    )
    const probe = commands.find((command) => command.includes('ORCA-NATIVE-DEPS-OK'))
    expect(probe).toContain(`${BUN} --no-install -e`)
    expect(probe).not.toContain('require("node-pty")')
    expect(commands).toContainEqual(expect.stringContaining(`${BUN} --no-install relay.js`))

    const packageJsonPath = sftpCapture.paths.find((path) => path.endsWith('/package.json'))
    const packageJson: unknown = JSON.parse(sftpCapture.contents[packageJsonPath ?? ''] ?? '{}')
    expect(packageJson).toMatchObject({ dependencies: { '@parcel/watcher': '2.5.6' } })
    expect(JSON.stringify(packageJson)).not.toContain('node-pty')
    expect(finalizeInstall).toHaveBeenCalled()
    expect(resolveRemoteNodePath).not.toHaveBeenCalled()
  })

  it('launches degraded and names the loader error when the watcher cannot load', async () => {
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(false)
    const conn = makeMockConnection(sftpCapture)
    feed([
      ...makeStagedFirstInstallExecPrefix().slice(0, -1),
      '', // bun install
      'ORCA-NATIVE-DEPS-MISSING:@parcel/watcher\nMISSING\n',
      'error: libstdc++.so.6: cannot open shared object file', // loader error for the warning
      '', // clean stage root
      'DEAD',
      '', // publish the per-launch credential
      'READY'
    ])

    await deployAndLaunchRelay(conn)

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/BUN-WATCHER-MISSING.*libstdc\+\+\.so\.6/)
    )
    expect(commandsRun(conn)).toContainEqual(
      expect.stringContaining(`${BUN} --no-install relay.js`)
    )
  })

  it('reuses a relay dir a Node deploy left behind without repairing node-pty', async () => {
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(true)
    const conn = makeMockConnection(sftpCapture)
    feed([
      '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
      '/home/u',
      'ORCA-NATIVE-DEPS-OK\n', // health probe: the watcher is all a Bun relay needs
      '', // SFTP-namespace install-owner marker
      'DEAD',
      '', // publish the per-launch credential
      'READY'
    ])

    await deployAndLaunchRelay(conn)

    const commands = commandsRun(conn)
    expect(commands.some((command) => command.includes(' install '))).toBe(false)
    expect(commands).toContainEqual(expect.stringContaining(`${BUN} --no-install relay.js`))
  })
})
