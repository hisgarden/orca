import { MIN_RELAY_BUN_VERSION } from '../../shared/relay-bun-runtime'
import type { SshConnection } from './ssh-connection'
import { createSshOperationAbortError } from './ssh-connection-utils'
import type { RemoteNodeResolutionOptions } from './ssh-remote-node-install-guidance'
import { execCommand } from './ssh-relay-deploy-helpers'
import { isSshSessionLimitError } from './ssh-session-limit-error'

// Why one round trip: every candidate is versioned in the same exec, so a slow SSH link pays once.
// Why the directory list: sshd's exec channel skips the profile that puts ~/.bun/bin on PATH.
export const REMOTE_BUN_PROBE_SCRIPT = `
{
  command -v bun 2>/dev/null
  for candidate in "\${BUN_INSTALL:-$HOME/.bun}/bin/bun" "$HOME/.bun/bin/bun" /usr/local/bin/bun /usr/bin/bun /opt/homebrew/bin/bun /home/linuxbrew/.linuxbrew/bin/bun
  do
    [ -x "$candidate" ] && printf '%s\\n' "$candidate"
  done
} | while IFS= read -r candidate
do
  [ -n "$candidate" ] || continue
  version=$("$candidate" --version 2>/dev/null | head -n 1)
  printf '%s\\t%s\\n' "$candidate" "$version"
done
true
`

const MIN_BUN_PARTS = parseVersion(MIN_RELAY_BUN_VERSION)

function parseVersion(text: string): [number, number, number] | null {
  const match = text.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function meetsBunMinimum(version: string): boolean {
  const parts = parseVersion(version)
  if (!parts || !MIN_BUN_PARTS) {
    return false
  }
  for (let index = 0; index < 3; index++) {
    if (parts[index] !== MIN_BUN_PARTS[index]) {
      return parts[index]! > MIN_BUN_PARTS[index]!
    }
  }
  return true
}

/** First probed Bun new enough for Bun.Terminal, from `path\tversion` lines. */
export function selectRemoteBun(probeOutput: string): string | null {
  for (const line of probeOutput.split('\n')) {
    const [candidate, version] = line.split('\t')
    if (candidate && version && meetsBunMinimum(version)) {
      return candidate
    }
  }
  return null
}

/** Newest-enough Bun on the host, or null when none is proven usable. */
export async function resolveRemoteBunPath(
  conn: SshConnection,
  options?: RemoteNodeResolutionOptions
): Promise<string | null> {
  try {
    const output = await execCommand(
      conn,
      REMOTE_BUN_PROBE_SCRIPT,
      options?.signal ? { signal: options.signal } : undefined
    )
    return selectRemoteBun(output)
  } catch (err) {
    if (options?.rethrowSessionLimitErrors && isSshSessionLimitError(err)) {
      throw err
    }
    if (options?.signal?.aborted) {
      throw createSshOperationAbortError()
    }
    // A failed probe only means Bun is unproven here; Node resolution still decides.
    return null
  }
}
