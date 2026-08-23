/**
 * `withSandbox` wrapper unit tests.
 *
 * Backend is mocked — these tests don't spawn containers. They verify the
 * wrapper's sequencing (boot → connectMcp → runWithSandbox(inner.fn) →
 * close + destroy), cleanup discipline on partial failure, and the
 * visibility guarantee that the inner pattern sees the transport via ALS.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

// The durable-workspace path (#89) talks to the document store through these;
// mocked so the sync tests assert *when* they run, not what they store (that
// is work-artifacts.test.ts's job).
const artifacts = vi.hoisted(() => ({
  hydrateWorkspace: vi.fn(
    async () => ({ written: 0, skipped: [] as Array<{ filename: string; error: string }> }),
  ),
  snapshotOutputs: vi.fn(async () => new Map<string, string>()),
  promoteOutputs: vi.fn(async () => ({
    promoted: [] as string[],
    skipped: [] as Array<{ filename: string; error: string }>,
  })),
}))
vi.mock('../../../lib/sandbox/work-artifacts.server', () => artifacts)

import {
  withSandbox,
  getDefaultAttachments,
  __resetSandboxDefaultsForTests,
} from '../../../lib/sandbox/with-sandbox.server'
import { getActiveSandbox } from '../../../lib/sandbox/scope.server'
import { WarmPool } from '../../../lib/sandbox/warm-pool.server'
import { SandboxScheduler } from '../../../lib/sandbox/scheduler.server'
import { AttachmentTable } from '../../../lib/sandbox/attachment-table.server'
import { DockerBackend } from '../../../lib/sandbox/docker-backend.server'
import { harnessUsesSyncWorkspace } from '../../../lib/harness-patterns/pattern-capabilities'
import type {
  ComputeBackend,
  HealthStatus,
  McpTransport,
  RootfsId,
  RuntimeConfig,
  VMHandle,
} from '../../../lib/sandbox/types'
import type {
  ConfiguredPattern,
  PatternScope,
  EventView,
} from '../../../lib/harness-patterns/types'

type Calls = {
  boot: Array<{ rootfs: RootfsId; runtime: RuntimeConfig }>
  destroy: VMHandle[]
  connectMcp: VMHandle[]
  closes: number
  reapOrphans: number
}

function fakeBackend(opts?: { connectMcpFails?: boolean }): ComputeBackend & { calls: Calls } {
  const calls: Calls = { boot: [], destroy: [], connectMcp: [], closes: 0, reapOrphans: 0 }
  const handle: VMHandle = {
    id: 'sbx-test',
    backend: 'docker',
    rootfs: 'base',
    bootedAt: Date.now(),
    native: { containerId: 'cid-test' },
  }
  const transport: McpTransport = {
    vmId: handle.id,
    toolNames: async () => ['sandbox_bash'],
    listTools: async () => [
      { name: 'sandbox_bash', description: 'run a shell command', inputSchema: {} },
    ],
    ownsTool: (name: string) => name === 'sandbox_bash',
    callTool: async () => ({ success: true, data: null }),
    close: async () => {
      calls.closes += 1
    },
  }
  const backend: ComputeBackend & { calls: Calls } = {
    kind: 'docker',
    calls,
    async boot(rootfs, runtime) {
      calls.boot.push({ rootfs, runtime })
      return handle
    },
    async destroy(vm) {
      calls.destroy.push(vm)
    },
    async reset() {
      throw new Error('not used')
    },
    async connectMcp(vm) {
      calls.connectMcp.push(vm)
      if (opts?.connectMcpFails) throw new Error('boom')
      return transport
    },
    async health(): Promise<HealthStatus> {
      return { state: 'healthy' }
    },
    async reapOrphans() {
      calls.reapOrphans += 1
      return 0
    },
  }
  return backend
}

function fakePattern<T extends Record<string, unknown>>(
  fn: (scope: PatternScope<T>, view: EventView) => Promise<PatternScope<T>>,
): ConfiguredPattern<T> {
  return {
    name: 'inner',
    fn,
    config: { patternId: 'inner', trackHistory: true, errorSeverity: 'irrecoverable' },
    estimateTurns: () => 3,
  }
}

function fakeScope<T>(data: T): PatternScope<T> {
  return { id: 'inner', events: [], data, startTime: Date.now() }
}

const fakeView = {} as unknown as EventView

describe('withSandbox', () => {
  it('boots, runs the inner pattern, then closes and destroys', async () => {
    const backend = fakeBackend()
    let innerRan = false
    const inner = fakePattern<{ ran?: boolean }>(async (scope) => {
      innerRan = true
      scope.data = { ...scope.data, ran: true }
      return scope
    })

    const wrapped = withSandbox({ backend, rootfs: 'base' })(inner)
    const out = await wrapped.fn(fakeScope({}), fakeView)

    expect(innerRan).toBe(true)
    expect(out.data.ran).toBe(true)
    expect(backend.calls.boot).toHaveLength(1)
    expect(backend.calls.boot[0].rootfs).toBe('base')
    expect(backend.calls.connectMcp).toHaveLength(1)
    expect(backend.calls.closes).toBe(1)
    expect(backend.calls.destroy).toHaveLength(1)
  })

  it('exposes the transport to the inner pattern via getActiveSandbox', async () => {
    const backend = fakeBackend()
    let seenVmId: string | undefined
    let seenOwns: boolean | undefined
    const inner = fakePattern(async (scope) => {
      const t = getActiveSandbox()
      seenVmId = t?.vmId
      seenOwns = t?.ownsTool('sandbox_bash')
      return scope
    })

    await withSandbox({ backend })(inner).fn(fakeScope({}), fakeView)

    expect(seenVmId).toBe('sbx-test')
    expect(seenOwns).toBe(true)
    expect(getActiveSandbox()).toBeUndefined()
  })

  it('destroys the VM if connectMcp fails (no leak)', async () => {
    const backend = fakeBackend({ connectMcpFails: true })
    const inner = fakePattern(async (scope) => scope)

    const wrapped = withSandbox({ backend })(inner)
    await expect(wrapped.fn(fakeScope({}), fakeView)).rejects.toThrow('boom')

    expect(backend.calls.boot).toHaveLength(1)
    expect(backend.calls.destroy).toHaveLength(1)
    // transport never opened, so no close call
    expect(backend.calls.closes).toBe(0)
  })

  it('runs cleanup even if the inner pattern throws', async () => {
    const backend = fakeBackend()
    const inner = fakePattern(async () => {
      throw new Error('inner failure')
    })

    const wrapped = withSandbox({ backend })(inner)
    await expect(wrapped.fn(fakeScope({}), fakeView)).rejects.toThrow('inner failure')

    expect(backend.calls.closes).toBe(1)
    expect(backend.calls.destroy).toHaveLength(1)
  })

  it('forwards rootfs and caller-supplied resources/egress to backend.boot', async () => {
    const backend = fakeBackend()
    const inner = fakePattern(async (scope) => scope)

    await withSandbox({
      backend,
      rootfs: 'base',
      resources: { cpus: 2, memoryMB: 1024 },
      egress: 'open',
    })(inner).fn(fakeScope({}), fakeView)

    // Caller-supplied wins; timeoutSec gets the settings default.
    expect(backend.calls.boot[0].rootfs).toBe('base')
    expect(backend.calls.boot[0].runtime).toMatchObject({
      cpus: 2,
      memoryMB: 1024,
      egress: 'open',
      timeoutSec: 60, // DEFAULT_SETTINGS.sandbox.defaultTimeoutSec
    })
  })

  it('fills missing resources/egress from settings.sandbox defaults', async () => {
    const backend = fakeBackend()
    const inner = fakePattern(async (scope) => scope)

    await withSandbox({ backend })(inner).fn(fakeScope({}), fakeView)

    expect(backend.calls.boot[0].runtime).toMatchObject({
      memoryMB: 512, // defaultMemoryMB
      timeoutSec: 60, // defaultTimeoutSec
      egress: 'mcp-only', // defaultEgress
    })
  })

  it('prefixes the inner pattern name and preserves config / estimateTurns', () => {
    const backend = fakeBackend()
    const inner = fakePattern(async (scope) => scope)
    const wrapped = withSandbox({ backend })(inner)

    expect(wrapped.name).toBe('withSandbox(inner)')
    expect(wrapped.config).toEqual(inner.config)
    expect(wrapped.estimateTurns?.({ maxToolTurns: 10, maxRetries: 3 })).toBe(3)
  })
})

describe('withSandbox scheduler + pool wiring', () => {
  it('routes acquire/release through the injected pool', async () => {
    const backend = fakeBackend()
    // Spy on a real WarmPool's methods so we see the wrapper's call sequence.
    const pool = new WarmPool(backend, { caps: { base: 2 }, idleEvictMs: 60_000 })
    const acquireSpy = vi.spyOn(pool, 'acquire')
    const releaseSpy = vi.spyOn(pool, 'release')

    const inner = fakePattern(async (scope) => scope)
    await withSandbox({ backend, pool, rootfs: 'base' })(inner).fn(fakeScope({}), fakeView)

    expect(acquireSpy).toHaveBeenCalledWith('base', expect.any(Object))
    expect(releaseSpy).toHaveBeenCalledTimes(1)
  })

  it('parks the VM in the pool when reset succeeds (subsequent acquire hits)', async () => {
    const backend = fakeBackend()
    // fakeBackend's default reset throws; install a working reset for this case.
    backend.reset = vi.fn(async (vm) => {
      ;(vm as { bootedAt: number }).bootedAt = Date.now()
    })
    const pool = new WarmPool(backend, { caps: { base: 1 }, idleEvictMs: 60_000 })
    const inner = fakePattern(async (scope) => scope)
    const wrap = withSandbox({ backend, pool, rootfs: 'base' })(inner)

    await wrap.fn(fakeScope({}), fakeView)
    expect(backend.calls.boot).toHaveLength(1)
    expect(pool.size('base')).toBe(1) // parked
    expect(backend.calls.destroy).toHaveLength(0)

    // Second invocation: pool-hit, no new boot.
    await wrap.fn(fakeScope({}), fakeView)
    expect(backend.calls.boot).toHaveLength(1)
    expect(pool.size('base')).toBe(1) // re-parked
  })

  it('allocates and releases scheduler slots with the provided sessionId', async () => {
    const backend = fakeBackend()
    backend.reset = vi.fn(async () => {})
    const pool = new WarmPool(backend, { caps: { base: 1 }, idleEvictMs: 60_000 })
    const scheduler = new SandboxScheduler({ globalCap: 4, perSessionCap: 2 })
    const allocSpy = vi.spyOn(scheduler, 'allocate')

    const inner = fakePattern(async (scope) => scope)
    await withSandbox({ backend, pool, scheduler, sessionId: 'sess-99' })(inner).fn(
      fakeScope({}),
      fakeView,
    )

    expect(allocSpy).toHaveBeenCalledWith('sess-99')
    expect(scheduler.inflightCount()).toBe(0) // slot released on cleanup
  })

  it('blocks a second invocation when the scheduler is at globalCap', async () => {
    const backend = fakeBackend()
    backend.reset = vi.fn(async () => {})
    const pool = new WarmPool(backend, { caps: { base: 2 }, idleEvictMs: 60_000 })
    const scheduler = new SandboxScheduler({ globalCap: 1, perSessionCap: 4 })

    let gateOpen = false
    const releaseGate = new Promise<void>((resolve) => {
      const id = setInterval(() => {
        if (gateOpen) {
          clearInterval(id)
          resolve()
        }
      }, 5)
    })

    const slow = fakePattern(async (scope) => {
      await releaseGate
      return scope
    })
    const fast = fakePattern(async (scope) => scope)

    const slowP = withSandbox({ backend, pool, scheduler, sessionId: 's1' })(slow).fn(
      fakeScope({}),
      fakeView,
    )
    // Give slow a tick to claim the slot.
    await new Promise((r) => setImmediate(r))
    expect(scheduler.inflightCount()).toBe(1)
    expect(scheduler.queueDepth()).toBe(0)

    const fastP = withSandbox({ backend, pool, scheduler, sessionId: 's2' })(fast).fn(
      fakeScope({}),
      fakeView,
    )
    await new Promise((r) => setImmediate(r))
    // fast is queued behind slow.
    expect(scheduler.queueDepth()).toBe(1)

    gateOpen = true
    await Promise.all([slowP, fastP])
    expect(scheduler.inflightCount()).toBe(0)
  })

  it('releases the scheduler slot even if the inner pattern throws', async () => {
    const backend = fakeBackend()
    backend.reset = vi.fn(async () => {})
    const pool = new WarmPool(backend, { caps: { base: 1 }, idleEvictMs: 60_000 })
    const scheduler = new SandboxScheduler({ globalCap: 1, perSessionCap: 1 })
    const inner = fakePattern(async () => {
      throw new Error('inner went pop')
    })

    await expect(
      withSandbox({ backend, pool, scheduler, sessionId: 's1' })(inner).fn(fakeScope({}), fakeView),
    ).rejects.toThrow('inner went pop')
    expect(scheduler.inflightCount()).toBe(0)
  })
})

describe('withSandbox id/fresh (step 6)', () => {
  function buildKit() {
    const backend = fakeBackend()
    backend.reset = vi.fn(async () => {})
    const pool = new WarmPool(backend, { caps: { base: 1 }, idleEvictMs: 60_000 })
    const scheduler = new SandboxScheduler({ globalCap: 4, perSessionCap: 4 })
    const attachments = new AttachmentTable(backend, pool, { idleMs: 60_000 })
    return { backend, pool, scheduler, attachments }
  }

  it('{ id } reuses the same VM across consecutive invocations', async () => {
    const kit = buildKit()
    const inner = fakePattern(async (scope) => scope)
    const wrap = withSandbox({ ...kit, id: 'session-42' })(inner)

    await wrap.fn(fakeScope({}), fakeView)
    await wrap.fn(fakeScope({}), fakeView)
    await wrap.fn(fakeScope({}), fakeView)

    // Only one boot — the attachment table reuses across calls.
    expect(kit.backend.calls.boot).toHaveLength(1)
    expect(kit.attachments.has('session-42')).toBe(true)
    expect(kit.attachments.size()).toBe(1)
  })

  it('{ id } isolates separate ids (different VMs per id)', async () => {
    const kit = buildKit()
    // Need pool cap big enough for two attachments parked at refCount=0
    // during overlap; but here we only have one in flight at a time, so
    // pool sees one acquire then another. Cap 1 means second acquire boots
    // since first hasn't been released to the pool. Bump cap to 2 to be safe.
    const pool = new WarmPool(kit.backend, { caps: { base: 2 }, idleEvictMs: 60_000 })
    const attachments = new AttachmentTable(kit.backend, pool, { idleMs: 60_000 })
    const inner = fakePattern(async (scope) => scope)

    await withSandbox({
      backend: kit.backend,
      pool,
      scheduler: kit.scheduler,
      attachments,
      id: 'a',
    })(inner).fn(fakeScope({}), fakeView)
    await withSandbox({
      backend: kit.backend,
      pool,
      scheduler: kit.scheduler,
      attachments,
      id: 'b',
    })(inner).fn(fakeScope({}), fakeView)

    expect(kit.backend.calls.boot).toHaveLength(2)
    expect(attachments.has('a')).toBe(true)
    expect(attachments.has('b')).toBe(true)
  })

  it('{ id, fresh: true } calls destroyById then reacquires under the same id', async () => {
    const kit = buildKit()
    const destroySpy = vi.spyOn(kit.attachments, 'destroyById')
    const inner = fakePattern(async (scope) => scope)

    await withSandbox({ ...kit, id: 'session-42' })(inner).fn(fakeScope({}), fakeView)
    expect(destroySpy).not.toHaveBeenCalled()

    await withSandbox({ ...kit, id: 'session-42', fresh: true })(inner).fn(fakeScope({}), fakeView)
    expect(destroySpy).toHaveBeenCalledWith('session-42')
    expect(kit.attachments.has('session-42')).toBe(true)
    // Note: a pool-recycled VM may serve the re-acquire, so we don't assert
    // boot was called twice — the user-visible semantic is "fresh state under
    // this id", and pool.reset already guarantees a fresh container.
  })

  it('{ fresh: true } (no id) bypasses pool and attachment table', async () => {
    const kit = buildKit()
    const poolAcquireSpy = vi.spyOn(kit.pool, 'acquire')
    const poolReleaseSpy = vi.spyOn(kit.pool, 'release')

    const inner = fakePattern(async (scope) => scope)
    await withSandbox({ ...kit, fresh: true })(inner).fn(fakeScope({}), fakeView)

    expect(poolAcquireSpy).not.toHaveBeenCalled()
    expect(poolReleaseSpy).not.toHaveBeenCalled()
    expect(kit.backend.calls.boot).toHaveLength(1)
    expect(kit.backend.calls.destroy).toHaveLength(1)
    expect(kit.attachments.size()).toBe(0)
    expect(kit.pool.size()).toBe(0)
  })

  it('{ fresh: true } (no id) destroys the VM when connectMcp fails', async () => {
    const backend = fakeBackend({ connectMcpFails: true })
    const wrap = withSandbox({ backend, fresh: true })(fakePattern(async (scope) => scope))

    await expect(wrap.fn(fakeScope({}), fakeView)).rejects.toThrow('boom')

    expect(backend.calls.boot).toHaveLength(1)
    expect(backend.calls.destroy).toHaveLength(1) // no orphaned container
    expect(backend.calls.closes).toBe(0) // transport never opened
  })

  it('{ fresh: true } (no id) destroys the VM even when the inner pattern throws', async () => {
    const kit = buildKit()
    const inner = fakePattern(async () => {
      throw new Error('boom')
    })

    await expect(
      withSandbox({ ...kit, fresh: true })(inner).fn(fakeScope({}), fakeView),
    ).rejects.toThrow('boom')
    expect(kit.backend.calls.destroy).toHaveLength(1)
  })

  it('{ id } refCount drops to 0 after release; reacquire reuses without booting', async () => {
    const kit = buildKit()
    const inner = fakePattern(async (scope) => scope)
    const wrap = withSandbox({ ...kit, id: 'session-42' })(inner)

    await wrap.fn(fakeScope({}), fakeView)
    // After release, refCount=0 but entry stays. Sweeper hasn't run.
    expect(kit.attachments.has('session-42')).toBe(true)
    const before = kit.backend.calls.boot.length

    await wrap.fn(fakeScope({}), fakeView)
    expect(kit.backend.calls.boot.length).toBe(before) // no extra boot
  })
})

describe('withSandbox default-singleton orphan reaper (#97 Gap 1)', () => {
  // These tests build the process-shared default singletons (everything else in
  // this file injects backends), so reset module state around each one and stub
  // the real reaper — it would otherwise shell out to `docker` (not hermetic).
  afterEach(() => {
    vi.restoreAllMocks()
    __resetSandboxDefaultsForTests()
  })

  it('reaps orphans exactly once when the default singletons are first built', async () => {
    __resetSandboxDefaultsForTests()
    const reapSpy = vi.spyOn(DockerBackend.prototype, 'reapOrphans').mockResolvedValue(0)

    // First default-singleton access constructs the shared DockerBackend and
    // fires the one-shot reaper before anything is allocated.
    getDefaultAttachments()
    expect(reapSpy).toHaveBeenCalledTimes(1)

    // Subsequent accesses reuse the singleton — the reaper does not re-fire.
    getDefaultAttachments()
    getDefaultAttachments()
    expect(reapSpy).toHaveBeenCalledTimes(1)

    // Let the fire-and-forget reap settle so the stub isn't torn down mid-flight.
    await Promise.resolve()
  })

  it('does not reap on the injected-backend path (tests / non-default)', async () => {
    __resetSandboxDefaultsForTests()
    const reapSpy = vi.spyOn(DockerBackend.prototype, 'reapOrphans').mockResolvedValue(0)

    const backend = fakeBackend()
    const inner = fakePattern(async (scope) => scope)
    await withSandbox({ backend })(inner).fn(fakeScope({}), fakeView)

    // Neither the default DockerBackend nor the injected backend was reaped —
    // withSandbox itself never reaps; only the default-singleton builder does.
    expect(reapSpy).not.toHaveBeenCalled()
    expect(backend.calls.reapOrphans).toBe(0)
  })
})

describe('withSandbox durable-workspace capability marker (#97 Gap 3)', () => {
  it('exposes the wrapped pattern as children', () => {
    const backend = fakeBackend()
    const inner = fakePattern(async (scope) => scope)
    const wrapped = withSandbox({ backend, id: 'sess-1', syncWorkspace: true })(inner)
    expect(wrapped.children).toEqual([inner])
  })

  it('stamps sandboxSyncWorkspace when id + syncWorkspace are both set', () => {
    const backend = fakeBackend()
    const inner = fakePattern(async (scope) => scope)
    const wrapped = withSandbox({ backend, id: 'sess-1', syncWorkspace: true })(inner)
    expect((wrapped.config as { sandboxSyncWorkspace?: boolean }).sandboxSyncWorkspace).toBe(true)
    // Detectable by the capability walker (the registry's agentUsesSyncWorkspace path).
    expect(harnessUsesSyncWorkspace([wrapped])).toBe(true)
  })

  it('does NOT stamp the marker without syncWorkspace (config stays transparent)', () => {
    const backend = fakeBackend()
    const inner = fakePattern(async (scope) => scope)
    const wrapped = withSandbox({ backend, id: 'sess-1' })(inner)
    expect(
      (wrapped.config as { sandboxSyncWorkspace?: boolean }).sandboxSyncWorkspace,
    ).toBeUndefined()
    expect(wrapped.config).toEqual(inner.config)
    expect(harnessUsesSyncWorkspace([wrapped])).toBe(false)
  })

  it('does NOT stamp the marker for syncWorkspace without an id (a no-op at runtime)', () => {
    const backend = fakeBackend()
    const inner = fakePattern(async (scope) => scope)
    const wrapped = withSandbox({ backend, syncWorkspace: true })(inner)
    expect(
      (wrapped.config as { sandboxSyncWorkspace?: boolean }).sandboxSyncWorkspace,
    ).toBeUndefined()
    expect(wrapped.config).toEqual(inner.config)
  })
})

describe('withSandbox durable workspace at runtime (#89)', () => {
  function buildKit() {
    const backend = fakeBackend()
    backend.reset = vi.fn(async () => {})
    const pool = new WarmPool(backend, { caps: { base: 1 }, idleEvictMs: 60_000 })
    const scheduler = new SandboxScheduler({ globalCap: 4, perSessionCap: 4 })
    const attachments = new AttachmentTable(backend, pool, { idleMs: 60_000 })
    return { backend, pool, scheduler, attachments }
  }

  beforeEach(() => {
    artifacts.hydrateWorkspace.mockClear().mockResolvedValue({ written: 0, skipped: [] })
    artifacts.snapshotOutputs.mockClear().mockResolvedValue(new Map())
    artifacts.promoteOutputs.mockClear().mockResolvedValue({ promoted: [], skipped: [] })
  })

  it('hydrates /work/in on the first boot only, and promotes outputs every turn', async () => {
    const kit = buildKit()
    const wrap = withSandbox({ ...kit, id: 'sess-1', sessionId: 'sess-1', syncWorkspace: true })(
      fakePattern(async (scope) => scope),
    )

    await wrap.fn(fakeScope({}), fakeView)
    await wrap.fn(fakeScope({}), fakeView)

    // Restore-from-store happens once per container, not once per turn...
    expect(artifacts.hydrateWorkspace).toHaveBeenCalledTimes(1)
    expect(artifacts.hydrateWorkspace).toHaveBeenCalledWith(expect.anything(), 'sess-1')
    // ...while the out-dir diff brackets every turn.
    expect(artifacts.snapshotOutputs).toHaveBeenCalledTimes(2)
    expect(artifacts.promoteOutputs).toHaveBeenCalledTimes(2)
  })

  it('promotes only what the turn produced, by diffing against the pre-turn snapshot', async () => {
    const kit = buildKit()
    const baseline = new Map([['old.csv', 'hash-1']])
    artifacts.snapshotOutputs.mockResolvedValue(baseline)
    const wrap = withSandbox({ ...kit, id: 'sess-1', sessionId: 'sess-1', syncWorkspace: true })(
      fakePattern(async (scope) => scope),
    )

    await wrap.fn(fakeScope({}), fakeView)

    expect(artifacts.promoteOutputs).toHaveBeenCalledWith(expect.anything(), 'sess-1', baseline)
  })

  it('still runs the turn when hydrate fails (store/gateway down), and says so', async () => {
    const kit = buildKit()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    artifacts.hydrateWorkspace.mockRejectedValue(new Error('gateway down'))
    const inner = vi.fn(async (scope: PatternScope<Record<string, unknown>>) => scope)
    const wrap = withSandbox({ ...kit, id: 'sess-1', sessionId: 'sess-1', syncWorkspace: true })(
      fakePattern(inner),
    )

    await expect(wrap.fn(fakeScope({}), fakeView)).resolves.toBeDefined()
    expect(inner).toHaveBeenCalledTimes(1)
    expect(err).toHaveBeenCalledWith(expect.stringContaining('hydrate failed'))
    err.mockRestore()
  })

  // sf-C3. A failed snapshot is not an empty one: `diffWorkFiles` compares
  // against the baseline, so an empty Map marks every pre-existing file as
  // produced-this-turn and re-stores the whole directory as duplicate stash
  // documents.
  it('SKIPS promotion when the pre-turn snapshot fails, instead of promoting against an empty baseline', async () => {
    const kit = buildKit()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    artifacts.snapshotOutputs.mockRejectedValue(new Error('no such directory'))
    const scope = fakeScope({})
    const wrap = withSandbox({ ...kit, id: 'sess-1', sessionId: 'sess-1', syncWorkspace: true })(
      fakePattern(async (s) => s),
    )

    // The turn still runs and still returns…
    await expect(wrap.fn(scope, fakeView)).resolves.toBeDefined()
    // …but nothing is promoted against a baseline we do not have.
    expect(artifacts.promoteOutputs).not.toHaveBeenCalled()
    // And the skip is recorded, on both channels.
    expect(err).toHaveBeenCalledWith(expect.stringContaining('snapshot failed'))
    expect(scope.events.filter((e) => e.type === 'error')).toHaveLength(1)
    err.mockRestore()
  })

  // sf-C2. This was a bare `.catch(() => {})`: the agent has already told the
  // user "I wrote report.xlsx", the container is about to be reaped, and the
  // file is gone with no event and no log line.
  it('records an error event when promotion throws, instead of losing the deliverable silently', async () => {
    const kit = buildKit()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    artifacts.promoteOutputs.mockRejectedValue(new Error('store write failed'))
    const scope = fakeScope({})
    const wrap = withSandbox({ ...kit, id: 'sess-1', sessionId: 'sess-1', syncWorkspace: true })(
      fakePattern(async (s) => s),
    )

    await expect(wrap.fn(scope, fakeView)).resolves.toBeDefined()

    const errors = scope.events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect((errors[0].data as { error: string }).error).toContain('store write failed')
    // The hint names the consequence, because "promotion failed" is not
    // actionable and "your file is gone" is.
    expect((errors[0].data as { hint?: string }).hint).toContain('will be lost')
    expect(err).toHaveBeenCalledWith(expect.stringContaining('promote failed'))
    err.mockRestore()
  })

  // Per-file failures don't throw — promoteOutputs returns them (sf-L8).
  it('reports per-file promotion failures by name', async () => {
    const kit = buildKit()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    artifacts.promoteOutputs.mockResolvedValue({
      promoted: ['ok.csv'],
      skipped: [{ filename: 'report.xlsx', error: 'content too large' }],
    })
    const scope = fakeScope({})
    const wrap = withSandbox({ ...kit, id: 'sess-1', sessionId: 'sess-1', syncWorkspace: true })(
      fakePattern(async (s) => s),
    )

    await wrap.fn(scope, fakeView)

    const errors = scope.events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect((errors[0].data as { error: string }).error).toContain('report.xlsx')
    err.mockRestore()
  })

  it('promotes deliverables even when the pattern throws mid-turn', async () => {
    const kit = buildKit()
    const wrap = withSandbox({ ...kit, id: 'sess-1', sessionId: 'sess-1', syncWorkspace: true })(
      fakePattern(async () => {
        throw new Error('actor gave up')
      }),
    )

    await expect(wrap.fn(fakeScope({}), fakeView)).rejects.toThrow('actor gave up')
    expect(artifacts.promoteOutputs).toHaveBeenCalledTimes(1)
  })

  it('surfaces the pattern result even when promotion fails', async () => {
    const kit = buildKit()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    artifacts.promoteOutputs.mockRejectedValue(new Error('store write failed'))
    const wrap = withSandbox({ ...kit, id: 'sess-1', sessionId: 'sess-1', syncWorkspace: true })(
      fakePattern(async (scope) => scope),
    )

    await expect(wrap.fn(fakeScope({}), fakeView)).resolves.toBeDefined()
    err.mockRestore()
  })

  it('skips the whole persistence path when syncWorkspace is off', async () => {
    const kit = buildKit()
    const wrap = withSandbox({ ...kit, id: 'sess-1' })(fakePattern(async (scope) => scope))

    await wrap.fn(fakeScope({}), fakeView)

    expect(artifacts.hydrateWorkspace).not.toHaveBeenCalled()
    expect(artifacts.snapshotOutputs).not.toHaveBeenCalled()
    expect(artifacts.promoteOutputs).not.toHaveBeenCalled()
  })
})

describe('withSandbox orphan-reap reporting (#97 Gap 1)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    __resetSandboxDefaultsForTests()
  })

  it('warns with the count when a prior process left containers behind', async () => {
    __resetSandboxDefaultsForTests()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reap = vi.spyOn(DockerBackend.prototype, 'reapOrphans').mockResolvedValue(3)

    getDefaultAttachments()
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())

    expect(reap).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('reaped 3 orphaned container(s)')
  })

  it('stays quiet when there was nothing to reap', async () => {
    __resetSandboxDefaultsForTests()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(DockerBackend.prototype, 'reapOrphans').mockResolvedValue(0)

    getDefaultAttachments()
    await Promise.resolve()
    await Promise.resolve()

    expect(warn).not.toHaveBeenCalled()
  })

  it('logs and carries on when the reaper itself fails (docker engine down)', async () => {
    __resetSandboxDefaultsForTests()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(DockerBackend.prototype, 'reapOrphans').mockRejectedValue(new Error('engine down'))

    // A failed reap must not break the singleton it was fired from.
    expect(getDefaultAttachments()).toBeDefined()
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())

    expect(warn.mock.calls[0][0]).toContain('orphan reap failed: engine down')
  })
})
