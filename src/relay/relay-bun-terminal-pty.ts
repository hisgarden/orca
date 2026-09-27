import type { IDisposable, IPty, IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty'
import { constants as osConstants } from 'node:os'
import { signalPosixPtyProcessGroups } from '../main/pty/posix-pty-process-groups'

/** The subset of node-pty's module the relay calls; Bun.Terminal implements the same shape. */
export type RelayPtyModule = {
  spawn(
    file: string,
    args: string[] | string,
    options: IPtyForkOptions | IWindowsPtyForkOptions
  ): IPty
}

// Structural types for Bun's PTY API (Bun >= 1.3.5) so the relay needs no Bun type package.
type BunTerminal = {
  readonly closed: boolean
  write(data: string): number
  resize(cols: number, rows: number): void
  close(): void
}

type BunSubprocess = {
  readonly pid: number
  readonly terminal: BunTerminal
  readonly exited: Promise<number>
  readonly exitCode: number | null
  readonly signalCode: string | null
  kill(signal?: string | number): void
}

export type BunTerminalRuntime = {
  Terminal: unknown
  spawn(
    command: string[],
    options: {
      cwd?: string
      env: Record<string, string>
      terminal: {
        cols: number
        rows: number
        name: string
        data(terminal: BunTerminal, data: Uint8Array): void
        exit?(terminal: BunTerminal, exitCode: number, signal: string | null): void
      }
    }
  ): BunSubprocess
}

// Why: a background job can hold the PTY open after the shell exits; don't let it pin onExit.
const OUTPUT_EOF_GRACE_MS = 250

/** Bun's PTY runtime when this relay runs under Bun on POSIX, else null (Node keeps node-pty). */
export function getBunTerminalRuntime(
  scope: object = globalThis,
  platform: NodeJS.Platform = process.platform
): BunTerminalRuntime | null {
  if (platform === 'win32') {
    return null
  }
  const bun: unknown = Reflect.get(scope, 'Bun')
  if (typeof bun !== 'object' || bun === null) {
    return null
  }
  const spawn: unknown = Reflect.get(bun, 'spawn')
  if (typeof spawn !== 'function' || Reflect.get(bun, 'Terminal') === undefined) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Bun.spawn and Bun.Terminal both exist, which is the Bun >= 1.3.5 PTY API this type describes.
  return bun as BunTerminalRuntime
}

export function createBunTerminalPtyModule(runtime: BunTerminalRuntime): RelayPtyModule {
  return {
    spawn: (file, args, options) => spawnBunTerminalPty(runtime, file, args, options)
  }
}

function toSpawnEnv(env: IPtyForkOptions['env'] | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env ?? process.env)) {
    if (typeof value === 'string') {
      result[key] = value
    }
  }
  return result
}

function spawnBunTerminalPty(
  runtime: BunTerminalRuntime,
  file: string,
  args: string[] | string,
  options: IPtyForkOptions | IWindowsPtyForkOptions
): IPty {
  if (typeof args === 'string') {
    throw new Error('Bun terminals take an argv array; a command-line string is Windows-only')
  }
  const env = toSpawnEnv(options.env)
  const name = options.name ?? env.TERM ?? 'xterm-256color'
  // node-pty sets TERM from `name`; keep that contract.
  env.TERM = name
  let cols = options.cols ?? 80
  let rows = options.rows ?? 24

  const dataListeners = new Set<(data: string) => void>()
  const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>()
  const decoder = new TextDecoder()
  let exitEvent: { exitCode: number; signal?: number } | null = null
  let paused = false
  let markOutputEnded: () => void = () => {}
  const outputEnded = new Promise<void>((resolve) => {
    markOutputEnded = resolve
  })

  const emitData = (data: string): void => {
    if (data) {
      for (const listener of dataListeners) {
        listener(data)
      }
    }
  }

  const child = runtime.spawn([file, ...args], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env,
    terminal: {
      cols,
      rows,
      name,
      data: (_terminal, chunk) => emitData(decoder.decode(chunk, { stream: true })),
      exit: () => markOutputEnded()
    }
  })

  const finish = async (): Promise<void> => {
    await child.exited.catch(() => undefined)
    await Promise.race([outputEnded, new Promise((r) => setTimeout(r, OUTPUT_EOF_GRACE_MS))])
    emitData(decoder.decode())
    const signal = child.signalCode ? Reflect.get(osConstants.signals, child.signalCode) : undefined
    exitEvent =
      typeof signal === 'number' ? { exitCode: 0, signal } : { exitCode: child.exitCode ?? 0 }
    if (!child.terminal.closed) {
      child.terminal.close()
    }
    const event = exitEvent
    for (const listener of exitListeners) {
      listener(event)
    }
    dataListeners.clear()
    exitListeners.clear()
  }
  void finish()

  const terminalOpen = (): boolean => exitEvent === null && !child.terminal.closed
  const signalGroups = (signal: 'SIGSTOP' | 'SIGCONT'): void =>
    signalPosixPtyProcessGroups(child.pid, signal, () => child.kill(signal))

  const pty: IPty = {
    pid: child.pid,
    process: file,
    handleFlowControl: false,
    get cols() {
      return cols
    },
    get rows() {
      return rows
    },
    onData(listener): IDisposable {
      if (exitEvent) {
        return { dispose() {} }
      }
      dataListeners.add(listener)
      return { dispose: () => void dataListeners.delete(listener) }
    },
    onExit(listener): IDisposable {
      if (exitEvent) {
        listener(exitEvent)
        return { dispose() {} }
      }
      exitListeners.add(listener)
      return { dispose: () => void exitListeners.delete(listener) }
    },
    write(data) {
      if (terminalOpen()) {
        child.terminal.write(typeof data === 'string' ? data : data.toString())
      }
    },
    resize(nextCols, nextRows) {
      if (terminalOpen()) {
        child.terminal.resize(nextCols, nextRows)
        cols = nextCols
        rows = nextRows
      }
    },
    clear() {},
    kill(signal) {
      if (paused) {
        pty.resume()
      }
      child.kill(signal ?? 'SIGHUP')
    },
    // Why: Bun.Terminal has no read pause, so backpressure stops the producers instead.
    pause() {
      if (!paused && exitEvent === null) {
        signalGroups('SIGSTOP')
        paused = true
      }
    },
    resume() {
      if (paused) {
        paused = false
        if (exitEvent === null) {
          signalGroups('SIGCONT')
        }
      }
    }
  }
  return pty
}
