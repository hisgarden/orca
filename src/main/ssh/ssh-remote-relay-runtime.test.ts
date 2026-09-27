import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const resolveRemoteBunPathMock = vi.hoisted(() => vi.fn())
const resolveRemoteNodePathMock = vi.hoisted(() => vi.fn())

vi.mock('./ssh-remote-bun-resolution', () => ({
  resolveRemoteBunPath: resolveRemoteBunPathMock
}))
vi.mock('./ssh-remote-node-resolution', () => ({
  resolveRemoteNodePath: resolveRemoteNodePathMock
}))

const { bunRelayDepsInstallCommand, posixRelayRuntimeCommand, resolveRemoteRelayRuntime } =
  await import('./ssh-remote-relay-runtime')

const conn: SshConnection = Object.create(null)
const linux = getRemoteHostPlatform('linux-x64')

describe('resolveRemoteRelayRuntime', () => {
  const savedOverride = process.env.ORCA_SSH_RELAY_RUNTIME

  beforeEach(() => {
    resolveRemoteBunPathMock.mockReset()
    resolveRemoteNodePathMock.mockReset()
    resolveRemoteNodePathMock.mockResolvedValue('/usr/bin/node')
    delete process.env.ORCA_SSH_RELAY_RUNTIME
  })

  afterEach(() => {
    if (savedOverride === undefined) {
      delete process.env.ORCA_SSH_RELAY_RUNTIME
    } else {
      process.env.ORCA_SSH_RELAY_RUNTIME = savedOverride
    }
  })

  it('prefers a qualifying host Bun and never asks for Node', async () => {
    resolveRemoteBunPathMock.mockResolvedValueOnce('/home/u/.bun/bin/bun')
    await expect(resolveRemoteRelayRuntime(conn, linux)).resolves.toEqual({
      kind: 'bun',
      path: '/home/u/.bun/bin/bun'
    })
    expect(resolveRemoteNodePathMock).not.toHaveBeenCalled()
  })

  it('falls back to Node when no Bun qualifies', async () => {
    resolveRemoteBunPathMock.mockResolvedValueOnce(null)
    await expect(resolveRemoteRelayRuntime(conn, linux)).resolves.toEqual({
      kind: 'node',
      path: '/usr/bin/node'
    })
  })

  it('lets ORCA_SSH_RELAY_RUNTIME=node skip Bun entirely', async () => {
    process.env.ORCA_SSH_RELAY_RUNTIME = 'node'
    await expect(resolveRemoteRelayRuntime(conn, linux)).resolves.toMatchObject({ kind: 'node' })
    expect(resolveRemoteBunPathMock).not.toHaveBeenCalled()
  })

  it('keeps Windows hosts on Node, where Bun.Terminal does not exist', async () => {
    const windows = getRemoteHostPlatform('win32-x64')
    await expect(resolveRemoteRelayRuntime(conn, windows)).resolves.toMatchObject({
      kind: 'node'
    })
    expect(resolveRemoteBunPathMock).not.toHaveBeenCalled()
  })
})

describe('relay runtime commands', () => {
  it('launches Bun without registry auto-install and Node unchanged', () => {
    expect(posixRelayRuntimeCommand({ kind: 'bun', path: "/home/o'k/.bun/bin/bun" })).toBe(
      `'/home/o'\\''k/.bun/bin/bun' --no-install`
    )
    expect(posixRelayRuntimeCommand({ kind: 'node', path: '/usr/bin/node' })).toBe(
      `'/usr/bin/node'`
    )
  })

  it('installs Bun deps from package.json with lifecycle scripts off', () => {
    expect(bunRelayDepsInstallCommand({ kind: 'bun', path: '/usr/bin/bun' })).toBe(
      `'/usr/bin/bun' install --production --ignore-scripts --no-progress 2>&1`
    )
  })
})
