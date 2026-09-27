// Why this exists: a host without Node/npm used to fail with "Node.js not found on remote host".
// This drives the real deploy at Docker sshds on Chainguard Wolfi -- one with only Bun, one with no
// JS runtime at all (Orca uploads its pinned Bun) -- then opens a terminal through the relay to
// prove Bun.Terminal, not node-pty, is serving it.
//
// Run: ORCA_REVIEW_SSH_BUN_HOST=1 pnpm test src/main/ssh/ssh-relay-bun-host.docker.test.ts
// Needs Docker and `pnpm build:relay`. ORCA_REVIEW_SSH_TARGET_HOST overrides the address the app
// connects to (default 127.0.0.1).
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))

import { ORCAD_BUN_RELEASE_ASSETS } from '../../shared/orcad-bun-runtime'
import { setAppEnvironment } from '../../shared/app-environment'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { SshConnection } from './ssh-connection'
import { deployAndLaunchRelay } from './ssh-relay-deploy'
import type { SshTarget } from '../../shared/ssh-types'

const RUN_REVIEW_ORACLE = process.env.ORCA_REVIEW_SSH_BUN_HOST === '1'
const TARGET_HOST = process.env.ORCA_REVIEW_SSH_TARGET_HOST ?? '127.0.0.1'
const WOLFI_IMAGE =
  'cgr.dev/chainguard/wolfi-base@sha256:08df5982c3d27e70a4ce1607e3bb9af09d746f8722cf135a7694afef879fc5a2'

type TargetFixture = {
  containerName: string
  identityFile: string
  port: number
  tempDir: string
}

function run(command: string, args: string[], timeout = 30_000, input?: string): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    timeout,
    input
  }).trim()
}

function dockerExec(fixture: TargetFixture, command: string): string {
  return run('docker', ['exec', fixture.containerName, 'sh', '-c', command], 60_000)
}

async function startTarget(packages: string): Promise<TargetFixture> {
  const image = `orca-review-bun-host:${packages.replace(/[^a-z0-9]+/g, '-')}`
  run(
    'docker',
    ['build', '-q', '-t', image, '-'],
    600_000,
    [
      `FROM ${WOLFI_IMAGE}`,
      `RUN apk add --no-cache ${packages} openssh-server openssh-sftp-server && ssh-keygen -A && mkdir -p /root/.ssh && chmod 700 /root/.ssh`,
      ''
    ].join('\n')
  )
  const tempDir = mkdtempSync(join(tmpdir(), 'orca-bun-host-ssh-'))
  const identityFile = join(tempDir, 'id_ed25519')
  run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', identityFile, '-q'])
  const publicKey = readFileSync(`${identityFile}.pub`, 'utf8').trim()
  const containerName = `orca-bun-host-${randomUUID().slice(0, 12)}`
  run(
    'docker',
    [
      'run',
      '-d',
      '--name',
      containerName,
      '-p',
      '0.0.0.0::22',
      '-e',
      `AUTHORIZED_KEY=${publicKey}`,
      image,
      'sh',
      '-c',
      'printf "%s\\n" "$AUTHORIZED_KEY" > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && exec /usr/sbin/sshd -D -e'
    ],
    120_000
  )
  const port = Number(run('docker', ['port', containerName, '22/tcp']).split(':').at(-1))
  await waitForSshBanner(port)
  return { containerName, identityFile, port, tempDir }
}

async function waitForSshBanner(port: number, deadlineMs = 60_000): Promise<void> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const gotBanner = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: TARGET_HOST, port })
      const done = (value: boolean): void => {
        socket.destroy()
        resolve(value)
      }
      socket.setTimeout(2_000, () => done(false))
      socket.once('data', (chunk) => done(chunk.toString('utf8').startsWith('SSH-')))
      socket.once('error', () => done(false))
    })
    if (gotBanner) {
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`sshd on port ${port} did not answer within ${deadlineMs / 1000}s`)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

function stopTarget(fixture: TargetFixture | null): void {
  if (!fixture) {
    return
  }
  spawnSync('docker', ['rm', '-f', fixture.containerName], { stdio: 'ignore', timeout: 30_000 })
  rmSync(fixture.tempDir, { recursive: true, force: true })
}

function createConnection(fixture: TargetFixture): SshConnection {
  const target: SshTarget = {
    id: `bun-host-${randomUUID()}`,
    label: 'Bun-only Docker SSH target',
    source: 'manual',
    host: TARGET_HOST,
    port: fixture.port,
    username: 'root',
    identityFile: fixture.identityFile,
    identitiesOnly: true
  }
  return new SshConnection(target, { onStateChange: vi.fn() })
}

async function waitForRemoteFile(fixture: TargetFixture, file: string): Promise<string> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const text = dockerExec(fixture, `cat '${file}' 2>/dev/null || true`)
    if (text) {
      return text
    }
    if (Date.now() > deadline) {
      throw new Error(`${file} was never written`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

async function expectBunRelayServesTerminal(
  activeFixture: TargetFixture,
  connection: SshConnection,
  expectedRuntime: RegExp
): Promise<void> {
  const mux: { current: SshChannelMultiplexer | null } = { current: null }
  try {
    const result = await deployAndLaunchRelay(connection, undefined, 60)
    expect(result.nodePath).toMatch(expectedRuntime)
    const relayDir = result.remoteRelayDir ?? ''
    const evidence = dockerExec(
      activeFixture,
      [
        `cd '${relayDir}'`,
        `'${result.nodePath}' --no-install -e 'require("@parcel/watcher"); console.log("WATCHER=loadable")'`,
        'test -e node_modules/node-pty && echo NODE_PTY=present || echo NODE_PTY=absent',
        'grep -q node-pty package.json && echo MANIFEST=node-pty || echo MANIFEST=watcher-only',
        "ps -eo args | grep '[r]elay.js --detached'"
      ].join('; ')
    )
    console.log(`[bun-host] ${evidence.replace(/\n/g, ' | ')}`)
    expect(evidence).toContain('WATCHER=loadable')
    expect(evidence).toContain('NODE_PTY=absent')
    expect(evidence).toContain('MANIFEST=watcher-only')
    expect(evidence).toMatch(/bun --no-install relay\.js --detached/)

    mux.current = new SshChannelMultiplexer(result.transport)
    const spawned = await mux.current.request('pty.spawn', { cols: 80, rows: 24, cwd: '/root' })
    const ptyId: unknown = Reflect.get(Object(spawned), 'id')
    expect(typeof ptyId).toBe('string')
    mux.current.notify('pty.data', {
      id: ptyId,
      data: 'echo $((20+22)) > /tmp/orca-bun-eval; stty size > /tmp/orca-bun-size\n'
    })
    expect(await waitForRemoteFile(activeFixture, '/tmp/orca-bun-eval')).toBe('42')
    expect(await waitForRemoteFile(activeFixture, '/tmp/orca-bun-size')).toBe('24 80')
  } finally {
    mux.current?.dispose()
    await connection.disconnect()
  }
}

describe.skipIf(!RUN_REVIEW_ORACLE)('SSH relay deploy on a host with Bun and no Node', () => {
  let fixture: TargetFixture | null = null

  beforeAll(async () => {
    fixture = await startTarget('bun libstdc++')
  }, 900_000)

  afterAll(() => {
    stopTarget(fixture)
  })

  it('deploys without npm and serves a terminal from Bun.Terminal', async () => {
    if (!fixture) {
      throw new Error('fixture did not start')
    }
    expect(dockerExec(fixture, 'command -v node npm || echo NO_NODE')).toBe('NO_NODE')
    const connection = createConnection(fixture)
    await connection.connect()
    await expectBunRelayServesTerminal(fixture, connection, /^\/usr\/bin\/bun$/)
  }, 600_000)
})

describe.skipIf(!RUN_REVIEW_ORACLE)('SSH relay deploy on a host with neither Bun nor Node', () => {
  let fixture: TargetFixture | null = null
  let cacheRoot = ''

  beforeAll(async () => {
    cacheRoot = mkdtempSync(join(tmpdir(), 'orca-bun-host-cache-'))
    setAppEnvironment({
      getPath: () => cacheRoot,
      getAppPath: () => process.cwd(),
      getVersion: () => '0.0.0-test',
      isPackaged: () => false,
      onWillQuit: () => {},
      exit: () => {},
      getAppMetrics: () => []
    })
    fixture = await startTarget('libstdc++')
  }, 900_000)

  afterAll(() => {
    stopTarget(fixture)
    if (cacheRoot) {
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  })

  it("uploads Orca's pinned Bun, verifies it on the host, and runs the relay on it", async () => {
    if (!fixture) {
      throw new Error('fixture did not start')
    }
    expect(dockerExec(fixture, 'command -v bun node npm || echo NO_RUNTIME')).toBe('NO_RUNTIME')
    const hashes = Object.values(ORCAD_BUN_RELEASE_ASSETS).map((asset) => asset.executableSha256)
    const connection = createConnection(fixture)
    await connection.connect()
    await expectBunRelayServesTerminal(
      fixture,
      connection,
      new RegExp(`/\\.orca-remote/vault-sqlite/(${hashes.join('|')})/bun$`)
    )
  }, 600_000)
})
