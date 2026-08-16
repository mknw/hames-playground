/**
 * PtyManager unit tests — the #97 Gap 3 hydrate-on-first-boot logic, plus the
 * shell's fan-out and lifetime contract.
 *
 * Hermetic: node-pty (a native addon), the shared AttachmentTable, and
 * `hydrateWorkspace` are all mocked, so no Docker / MCP SDK / pseudo-TTY is
 * involved. The first block asserts the hydrate decision — whether the Shell
 * hydrates /work/in when it is the first to boot the session container —
 * across the sync/non-sync and first-boot/reused axes. The rest cover what the
 * terminal route depends on: scrollback replay on re-mount, output fan-out that
 * survives a dead subscriber, and a PTY lifetime decoupled from subscribers
 * (tab switches must not kill the shell; idle eventually must, releasing the
 * attachment hold on the VM).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// vi.mock factories are hoisted above imports; build the spies in a hoisted
// block so the factories can close over them without a TDZ error.
const mocks = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  hydrateMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn(),
}))

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

vi.mock('node-pty', () => ({ spawn: mocks.spawnMock }))

vi.mock('../../../lib/sandbox/work-artifacts.server', () => ({
  hydrateWorkspace: mocks.hydrateMock,
}))

vi.mock('../../../lib/sandbox/with-sandbox.server', () => ({
  getDefaultAttachments: () => ({ acquire: mocks.acquireMock, release: mocks.releaseMock }),
}))

import { PtyManager } from '../../../lib/sandbox/pty-manager.server'

// ---- fakes ---------------------------------------------------------------

/** node-pty stand-in. `emit`/`exit` drive the callbacks the manager registers,
 *  so tests can act like the container's shell without a real pseudo-TTY. */
function makeFakeIPty() {
  let onData: (chunk: string) => void = () => {}
  let onExit: () => void = () => {}
  return {
    onData: vi.fn((cb: (chunk: string) => void) => {
      onData = cb
    }),
    onExit: vi.fn((cb: () => void) => {
      onExit = cb
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    emit: (chunk: string) => onData(chunk),
    exit: () => onExit(),
  }
}

type FakeIPty = ReturnType<typeof makeFakeIPty>

/** The IPty handed to the manager for the most recent spawn. */
const lastPty = (): FakeIPty => mocks.spawnMock.mock.results.at(-1)!.value as FakeIPty

type FakeAttachment = {
  id: string
  refCount: number
  lastUsedAt: number
  isFirstBoot: boolean
  vm: { native: { containerId: string } }
  transport: Record<string, unknown>
}

let attachment: FakeAttachment

beforeEach(() => {
  mocks.spawnMock.mockReset().mockImplementation(() => makeFakeIPty())
  mocks.hydrateMock.mockReset().mockResolvedValue(0)
  mocks.acquireMock.mockReset()
  mocks.releaseMock.mockReset()

  attachment = {
    id: 's1',
    refCount: 1,
    lastUsedAt: 0,
    isFirstBoot: true,
    vm: { native: { containerId: 'cid-1' } },
    transport: { vmId: 's1' },
  }
  mocks.acquireMock.mockResolvedValue(attachment)
})

// ---- tests ---------------------------------------------------------------

describe('PtyManager.ensure — hydrate on first boot (#97 Gap 3)', () => {
  it('hydrates /work/in when the session uses durable workspaces and this is the first boot', async () => {
    const mgr = new PtyManager()
    await mgr.ensure('s1', { syncWorkspace: true })

    expect(mocks.hydrateMock).toHaveBeenCalledTimes(1)
    expect(mocks.hydrateMock).toHaveBeenCalledWith(attachment.transport, 's1')
    expect(attachment.isFirstBoot).toBe(false) // flipped so the agent turn won't re-hydrate
    expect(mocks.spawnMock).toHaveBeenCalledTimes(1) // shell still spawned
  })

  it('does not hydrate when the container was already booted (agent ran first)', async () => {
    attachment.isFirstBoot = false
    const mgr = new PtyManager()
    await mgr.ensure('s1', { syncWorkspace: true })

    expect(mocks.hydrateMock).not.toHaveBeenCalled()
    expect(mocks.spawnMock).toHaveBeenCalledTimes(1)
  })

  it('does not hydrate for a non-durable-workspace session', async () => {
    const mgr = new PtyManager()
    await mgr.ensure('s1', { syncWorkspace: false })

    expect(mocks.hydrateMock).not.toHaveBeenCalled()
    expect(attachment.isFirstBoot).toBe(true) // untouched
    expect(mocks.spawnMock).toHaveBeenCalledTimes(1)
  })

  it('defaults to no hydrate when opts are omitted (older client / no agentId)', async () => {
    const mgr = new PtyManager()
    await mgr.ensure('s1')

    expect(mocks.hydrateMock).not.toHaveBeenCalled()
    expect(mocks.spawnMock).toHaveBeenCalledTimes(1)
  })

  it('opens the shell even if hydrate fails (best-effort), flipping isFirstBoot like the agent path', async () => {
    mocks.hydrateMock.mockRejectedValueOnce(new Error('gateway down'))
    const mgr = new PtyManager()
    await expect(mgr.ensure('s1', { syncWorkspace: true })).resolves.toBeUndefined()

    expect(mocks.spawnMock).toHaveBeenCalledTimes(1)
    expect(attachment.isFirstBoot).toBe(false)
  })

  it('only boots/hydrates once even across concurrent ensure calls', async () => {
    const mgr = new PtyManager()
    await Promise.all([
      mgr.ensure('s1', { syncWorkspace: true }),
      mgr.ensure('s1', { syncWorkspace: true }),
    ])
    expect(mocks.acquireMock).toHaveBeenCalledTimes(1)
    expect(mocks.hydrateMock).toHaveBeenCalledTimes(1)
    expect(mocks.spawnMock).toHaveBeenCalledTimes(1)
  })

  it('spawns an interactive bash inside the session container', async () => {
    const mgr = new PtyManager()
    await mgr.ensure('s1')

    const [bin, argv] = mocks.spawnMock.mock.calls[0]
    expect(bin).toBe('docker')
    expect(argv).toEqual(['exec', '-it', 'cid-1', 'bash'])
    expect(mgr.has('s1')).toBe(true)
  })

  it('is a no-op for a session that already has a live shell', async () => {
    const mgr = new PtyManager()
    await mgr.ensure('s1')
    await mgr.ensure('s1')

    expect(mocks.spawnMock).toHaveBeenCalledTimes(1)
    expect(mocks.acquireMock).toHaveBeenCalledTimes(1)
  })

  it('reports no shell for an unknown session', () => {
    expect(new PtyManager().has('nope')).toBe(false)
  })
})

describe('PtyManager — output fan-out and scrollback', () => {
  it('replays scrollback to a tab that re-mounts, and streams live output', async () => {
    const mgr = new PtyManager()
    await mgr.ensure('s1')
    lastPty().emit('$ echo hi\r\n')

    // A terminal tab mounting later redraws from scrollback...
    expect(mgr.getScrollback('s1')).toBe('$ echo hi\r\n')

    // ...then receives subsequent output live.
    const chunks: string[] = []
    mgr.subscribe('s1', (c) => chunks.push(c))
    lastPty().emit('hi\r\n')

    expect(chunks).toEqual(['hi\r\n'])
    expect(mgr.getScrollback('s1')).toBe('$ echo hi\r\nhi\r\n')
  })

  it('caps scrollback so a chatty shell cannot grow memory without bound', async () => {
    const mgr = new PtyManager()
    await mgr.ensure('s1')

    lastPty().emit('a'.repeat(70_000))
    lastPty().emit('TAIL')

    const sb = mgr.getScrollback('s1')
    expect(sb.length).toBe(64 * 1024)
    expect(sb.endsWith('TAIL')).toBe(true) // the newest bytes are the ones kept
  })

  it('returns empty scrollback for a session with no shell', () => {
    expect(new PtyManager().getScrollback('nope')).toBe('')
  })

  it('keeps fanning out when one subscriber throws', async () => {
    const mgr = new PtyManager()
    await mgr.ensure('s1')
    const healthy = vi.fn()
    mgr.subscribe('s1', () => {
      throw new Error('dead SSE stream')
    })
    mgr.subscribe('s1', healthy)

    expect(() => lastPty().emit('out')).not.toThrow()
    expect(healthy).toHaveBeenCalledWith('out')
  })

  it('stops delivering after unsubscribe', async () => {
    const mgr = new PtyManager()
    await mgr.ensure('s1')
    const cb = vi.fn()
    const off = mgr.subscribe('s1', cb)

    off()
    lastPty().emit('out')

    expect(cb).not.toHaveBeenCalled()
  })

  it('tolerates an SSE stream unsubscribing after the shell already exited', async () => {
    const mgr = new PtyManager()
    await mgr.ensure('s1')
    const off = mgr.subscribe('s1', vi.fn())

    lastPty().exit() // container died first
    expect(() => off()).not.toThrow() // then the route tears down its stream
    expect(mocks.releaseMock).toHaveBeenCalledTimes(1) // no second release
  })

  it('hands back an inert unsubscribe when there is no shell to subscribe to', () => {
    const mgr = new PtyManager()
    const off = mgr.subscribe('nope', vi.fn())
    expect(() => off()).not.toThrow()
  })
})

describe('PtyManager — input', () => {
  it('writes keystrokes to the session shell', async () => {
    const mgr = new PtyManager()
    await mgr.ensure('s1')

    mgr.write('s1', 'ls\r')

    expect(lastPty().write).toHaveBeenCalledWith('ls\r')
  })

  it('drops writes for an unknown session instead of throwing', () => {
    expect(() => new PtyManager().write('nope', 'ls\r')).not.toThrow()
  })

  it('resizes the pty, flooring and clamping to at least 1×1', async () => {
    const mgr = new PtyManager()
    await mgr.ensure('s1')

    mgr.resize('s1', 120.7, 40.2)
    expect(lastPty().resize).toHaveBeenCalledWith(120, 40)

    mgr.resize('s1', 0, -5)
    expect(lastPty().resize).toHaveBeenLastCalledWith(1, 1)
  })

  it('ignores non-finite dimensions and unknown sessions', async () => {
    const mgr = new PtyManager()
    await mgr.ensure('s1')

    mgr.resize('s1', Number.NaN, 40)
    mgr.resize('nope', 80, 24)

    expect(lastPty().resize).not.toHaveBeenCalled()
  })

  it('survives a resize that races teardown', async () => {
    const mgr = new PtyManager()
    await mgr.ensure('s1')
    lastPty().resize.mockImplementation(() => {
      throw new Error('pty already gone')
    })

    expect(() => mgr.resize('s1', 80, 24)).not.toThrow()
  })
})

describe('PtyManager — lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('outlives a tab switch, then closes once idle long enough', async () => {
    const mgr = new PtyManager()
    await mgr.ensure('s1')
    const term = lastPty()
    const off = mgr.subscribe('s1', vi.fn())

    off() // tab unmounted — the shell must survive so cwd/jobs persist
    vi.advanceTimersByTime(4 * 60_000)
    expect(mgr.has('s1')).toBe(true)
    expect(mocks.releaseMock).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2 * 60_000)
    expect(mgr.has('s1')).toBe(false)
    expect(term.kill).toHaveBeenCalledTimes(1)
    expect(mocks.releaseMock).toHaveBeenCalledWith(attachment) // VM hold released
  })

  it('cancels the idle close when the tab re-mounts in time', async () => {
    const mgr = new PtyManager()
    await mgr.ensure('s1')
    const off = mgr.subscribe('s1', vi.fn())

    off()
    vi.advanceTimersByTime(60_000)
    mgr.subscribe('s1', vi.fn()) // re-mounted
    vi.advanceTimersByTime(10 * 60_000)

    expect(mgr.has('s1')).toBe(true)
    expect(mocks.releaseMock).not.toHaveBeenCalled()
  })

  it('tells subscribers why the terminal closed when the shell exits', async () => {
    const mgr = new PtyManager()
    await mgr.ensure('s1')
    const chunks: string[] = []
    mgr.subscribe('s1', (c) => chunks.push(c))

    lastPty().exit()

    expect(chunks.join('')).toContain('[sandbox terminal closed: shell exited]')
    expect(mgr.has('s1')).toBe(false)
    expect(mocks.releaseMock).toHaveBeenCalledWith(attachment)
  })

  it('releases the attachment even if the close notice and kill both fail', async () => {
    const mgr = new PtyManager()
    await mgr.ensure('s1')
    const term = lastPty()
    term.kill.mockImplementation(() => {
      throw new Error('already gone')
    })
    mgr.subscribe('s1', () => {
      throw new Error('dead SSE stream')
    })

    expect(() => term.exit()).not.toThrow()
    expect(mocks.releaseMock).toHaveBeenCalledWith(attachment)
  })

  it('a second dispose (exit after idle close) is a no-op', async () => {
    const mgr = new PtyManager()
    await mgr.ensure('s1')
    const term = lastPty()

    term.exit()
    term.exit()

    expect(mocks.releaseMock).toHaveBeenCalledTimes(1)
  })
})
