import { BUN_RELAY_RUNTIME_FLAGS } from '../../shared/relay-bun-runtime'
import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { resolveRemoteBunPath } from './ssh-remote-bun-resolution'
import type { RemoteNodeResolutionOptions } from './ssh-remote-node-install-guidance'
import { resolveRemoteNodePath } from './ssh-remote-node-resolution'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'

/** The executable that runs relay.js on the remote host. Bun needs no npm and no node-pty. */
export type RemoteRelayRuntime = Readonly<{ kind: 'node' | 'bun'; path: string }>

/** Host Bun when it can run the relay, else Node (which throws install guidance when absent). */
export async function resolveRemoteRelayRuntime(
  conn: SshConnection,
  host?: RemoteHostPlatform,
  options?: RemoteNodeResolutionOptions
): Promise<RemoteRelayRuntime> {
  const bunAllowed =
    host !== undefined &&
    !isWindowsRemoteHost(host) &&
    process.env.ORCA_SSH_RELAY_RUNTIME !== 'node'
  const bunPath = bunAllowed ? await resolveRemoteBunPath(conn, host, options) : null
  if (bunPath) {
    console.log(`[ssh-relay] Relay will run on Bun: ${bunPath}`)
    return { kind: 'bun', path: bunPath }
  }
  return { kind: 'node', path: await resolveRemoteNodePath(conn, host, options) }
}

/** Shell-escaped argv prefix that runs relay.js on a POSIX host. */
export function posixRelayRuntimeCommand(runtime: RemoteRelayRuntime): string {
  const executable = shellEscape(runtime.path)
  return runtime.kind === 'bun' ? [executable, ...BUN_RELAY_RUNTIME_FLAGS].join(' ') : executable
}

/**
 * Installs package.json's deps with Bun. Why no npm: Bun hosts have none. Why --ignore-scripts:
 * the only dep left without node-pty is @parcel/watcher, whose prebuilt platform package needs no
 * lifecycle script, so nothing third-party executes on the host.
 */
export function bunRelayDepsInstallCommand(runtime: RemoteRelayRuntime): string {
  return `${shellEscape(runtime.path)} install --production --ignore-scripts --no-progress 2>&1`
}
