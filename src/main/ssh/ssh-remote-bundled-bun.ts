import { randomBytes } from 'node:crypto'
import { copyFile, link, mkdtemp, realpath, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { ORCAD_BUN_RELEASE_ASSETS, ORCAD_BUN_VERSION } from '../../shared/orcad-bun-runtime'
import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { resolveOrcadDeploymentTarget } from './orcad-deployment-target'
import { materializeCachedOrcadBunRuntime } from './orcad-bun-runtime-materializer'
import { execCommand } from './ssh-relay-deploy-helpers'
import { uploadRelayDirectory } from './ssh-relay-install-transfers'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'

// Why a separate budget: the first upload is ~90 MB; a slow link must fall back to Node, not
// spend the whole deploy deadline.
const BUNDLED_BUN_SETUP_TIMEOUT_MS = 180_000
const RESULT = 'ORCA_BUNDLED_BUN:'

// Why shell and not a JS hash: a host that needs the bundled runtime has no JS runtime yet.
// Why --version too: a matching hash on a host whose libc is too old still cannot run it.
const SHA256_SHELL = `orca_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d ' ' -f 1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 -r "$1" | cut -d ' ' -f 1
  else return 3; fi
}
orca_bun_ok() {
  [ -f "$1" ] && [ "$(orca_sha256 "$1")" = "$2" ] && chmod 755 "$1" && [ "$("$1" --version 2>/dev/null)" = "$3" ]
}
`

type BundledBunTarget = { executableSha256: string }

function runtimeDir(expectedSha: string): string {
  // Shared with the OpenCode SQLite runtime, which keeps the same pinned Bun at this path.
  return `"$HOME"/.orca-remote/vault-sqlite/${shellEscape(expectedSha)}`
}

export function probeBundledBunCommand(target: BundledBunTarget): string {
  const sha = shellEscape(target.executableSha256)
  return `${SHA256_SHELL}
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || command -v openssl >/dev/null 2>&1 || { echo ${RESULT}NO_SHA_TOOL; exit 0; }
bin=${runtimeDir(target.executableSha256)}/bun
if orca_bun_ok "$bin" ${sha} ${shellEscape(ORCAD_BUN_VERSION)}; then echo "${RESULT}READY:$bin"; else echo "${RESULT}MISSING:$HOME"; fi`
}

export function promoteBundledBunCommand(target: BundledBunTarget, stageDir: string): string {
  const sha = shellEscape(target.executableSha256)
  const stage = shellEscape(stageDir)
  return `${SHA256_SHELL}
dir=${runtimeDir(target.executableSha256)}
if orca_bun_ok ${stage}/bun ${sha} ${shellEscape(ORCAD_BUN_VERSION)} && mkdir -p "$dir" && mv -f ${stage}/bun "$dir/bun"; then
  rm -rf ${stage}; echo "${RESULT}READY:$dir/bun"
else
  rm -rf ${stage}; echo ${RESULT}REJECTED
fi`
}

export function parseBundledBunResult(
  output: string
):
  | { status: 'ready'; path: string }
  | { status: 'missing'; home: string }
  | { status: 'unusable' } {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(RESULT))
  const body = line?.slice(RESULT.length) ?? ''
  if (body.startsWith('READY:/')) {
    return { status: 'ready', path: body.slice('READY:'.length) }
  }
  if (body.startsWith('MISSING:/')) {
    return { status: 'missing', home: body.slice('MISSING:'.length) }
  }
  return { status: 'unusable' }
}

/**
 * The pinned Bun Orca ships, verified on the host by hash and version; uploaded on first use.
 * Null whenever it cannot be proven runnable, so the caller falls back to host Node.
 */
export async function ensureRemoteBundledBun(
  conn: SshConnection,
  host: RemoteHostPlatform,
  options: { signal?: AbortSignal; cacheRoot?: string } = {}
): Promise<string | null> {
  if (isWindowsRemoteHost(host)) {
    return null
  }
  const timeout = AbortSignal.timeout(BUNDLED_BUN_SETUP_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const exec = (command: string): Promise<string> => execCommand(conn, command, { signal })
  const target = await resolveOrcadDeploymentTarget({ conn, host, signal, exec })
  const asset = ORCAD_BUN_RELEASE_ASSETS[target]
  const probed = parseBundledBunResult(await exec(probeBundledBunCommand(asset)))
  if (probed.status !== 'missing') {
    return probed.status === 'ready' ? probed.path : null
  }
  const cacheRoot =
    options.cacheRoot ?? join(getAppEnvironment().getPath('userData'), 'orcad-artifacts')
  const localRuntime = await materializeCachedOrcadBunRuntime(target, cacheRoot, { signal })
  // Why realpath: the upload guard compares real paths, and a userData under a symlinked temp
  // dir (macOS /var -> /private/var) otherwise reads as a stage outside its own root.
  const localStage = await realpath(await mkdtemp(join(dirname(localRuntime), '.relay-upload-')))
  const remoteStage = `${probed.home}/.orca-remote/vault-sqlite/.upload-${randomBytes(8).toString('hex')}`
  try {
    await link(localRuntime, join(localStage, 'bun')).catch(() =>
      copyFile(localRuntime, join(localStage, 'bun'))
    )
    await exec(`mkdir -p ${shellEscape(remoteStage)}`)
    try {
      await uploadRelayDirectory(conn, localStage, remoteStage, host, { signal })
    } catch (error) {
      await execCommand(conn, `rm -rf ${shellEscape(remoteStage)}`).catch(() => {})
      throw error
    }
    const promoted = parseBundledBunResult(await exec(promoteBundledBunCommand(asset, remoteStage)))
    return promoted.status === 'ready' ? promoted.path : null
  } finally {
    await rm(localStage, { recursive: true, force: true }).catch(() => {})
  }
}
