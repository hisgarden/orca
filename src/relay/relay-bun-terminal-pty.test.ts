import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBunTerminalPtyModule,
  getBunTerminalRuntime,
  type BunTerminalRuntime
} from './relay-bun-terminal-pty'

type TerminalOptions = Parameters<BunTerminalRuntime['spawn']>[1]['terminal']
type FakeChild = {
  -readonly [K in keyof ReturnType<BunTerminalRuntime['spawn']>]: ReturnType<
    BunTerminalRuntime['spawn']
  >[K]
} & { terminal: { closed: boolean } }

function fakeRuntime() {
  let resolveExited: (code: number) => void = () => {}
  const child: FakeChild = {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    exited: new Promise<number>((resolve) => {
      resolveExited = resolve
    }),
    kill: vi.fn(),
    terminal: {
      closed: false,
      write: vi.fn(() => 0),
      resize: vi.fn(),
      close: vi.fn(() => {
        child.terminal.closed = true
      })
    }
  }
  let terminal: TerminalOptions | null = null
  const runtime: BunTerminalRuntime = {
    Terminal: class {},
    spawn: vi.fn((_command, options) => {
      terminal = options.terminal
      return child
    })
  }
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
  return {
    runtime,
    child,
    emit: (text: string) => terminal?.data(child.terminal, bytes(text)),
    endOutput: () => terminal?.exit?.(child.terminal, 0, null),
    exit(code: number | null, signal: string | null = null) {
      child.exitCode = code
      child.signalCode = signal
      resolveExited(code ?? 128)
    }
  }
}

function spawnWith(runtime: BunTerminalRuntime) {
  return createBunTerminalPtyModule(runtime).spawn('/bin/sh', ['-l'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    env: { PATH: '/bin', UNSET: undefined }
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('getBunTerminalRuntime', () => {
  it('is null under Node, on Windows, and on Bun builds without Terminal', () => {
    const bun = { spawn() {}, Terminal: class {} }
    expect(getBunTerminalRuntime({}, 'linux')).toBeNull()
    expect(getBunTerminalRuntime({ Bun: bun }, 'win32')).toBeNull()
    expect(getBunTerminalRuntime({ Bun: { spawn() {} } }, 'linux')).toBeNull()
    expect(getBunTerminalRuntime({ Bun: bun }, 'linux')).toBe(bun)
  })
})

describe('Bun terminal PTY', () => {
  it('spawns argv with TERM from name and drops unset env values', () => {
    const fake = fakeRuntime()
    spawnWith(fake.runtime)
    expect(fake.runtime.spawn).toHaveBeenCalledWith(
      ['/bin/sh', '-l'],
      expect.objectContaining({
        cwd: '/tmp',
        env: { PATH: '/bin', TERM: 'xterm-256color' },
        terminal: expect.objectContaining({ cols: 80, rows: 24, name: 'xterm-256color' })
      })
    )
  })

  it('decodes UTF-8 split across chunks', () => {
    const fake = fakeRuntime()
    const pty = spawnWith(fake.runtime)
    const seen: string[] = []
    pty.onData((data) => seen.push(data))
    const euro = new TextEncoder().encode('€')
    const terminal = vi.mocked(fake.runtime.spawn).mock.calls[0]![1].terminal
    terminal.data(fake.child.terminal, euro.subarray(0, 1))
    terminal.data(fake.child.terminal, euro.subarray(1))
    expect(seen.join('')).toBe('€')
  })

  it('reports a signal death the way node-pty does and closes the terminal', async () => {
    const fake = fakeRuntime()
    const pty = spawnWith(fake.runtime)
    const onExit = vi.fn()
    pty.onExit(onExit)
    fake.endOutput()
    fake.exit(null, 'SIGTERM')
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith({ exitCode: 0, signal: 15 }))
    expect(vi.mocked(fake.child.terminal.close)).toHaveBeenCalled()
  })

  it('delivers output before exit and ignores writes afterwards', async () => {
    const fake = fakeRuntime()
    const pty = spawnWith(fake.runtime)
    const events: string[] = []
    pty.onData((data) => events.push(`data:${data}`))
    pty.onExit(({ exitCode }) => events.push(`exit:${exitCode}`))
    fake.exit(3)
    fake.emit('late')
    fake.endOutput()
    await vi.waitFor(() => expect(events).toEqual(['data:late', 'exit:3']))
    pty.write('ignored')
    pty.resize(10, 10)
    expect(vi.mocked(fake.child.terminal.write)).not.toHaveBeenCalled()
    expect(vi.mocked(fake.child.terminal.resize)).not.toHaveBeenCalled()
  })

  it('does not wait forever for EOF when a background job holds the terminal', async () => {
    vi.useFakeTimers()
    const fake = fakeRuntime()
    const pty = spawnWith(fake.runtime)
    const onExit = vi.fn()
    pty.onExit(onExit)
    fake.exit(0)
    await vi.advanceTimersByTimeAsync(249)
    expect(onExit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onExit).toHaveBeenCalledWith({ exitCode: 0 })
  })

  it('tracks size only when the kernel resize succeeds', () => {
    const fake = fakeRuntime()
    const pty = spawnWith(fake.runtime)
    pty.resize(120, 40)
    expect(vi.mocked(fake.child.terminal.resize)).toHaveBeenCalledWith(120, 40)
    expect([pty.cols, pty.rows]).toEqual([120, 40])
  })

  it('defaults kill to SIGHUP like node-pty', () => {
    const fake = fakeRuntime()
    const pty = spawnWith(fake.runtime)
    pty.kill()
    pty.kill('SIGKILL')
    expect(vi.mocked(fake.child.kill).mock.calls).toEqual([['SIGHUP'], ['SIGKILL']])
  })
})
