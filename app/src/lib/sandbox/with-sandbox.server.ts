/**
 * `withSandbox` — outer wrapper that attaches a sandbox VM to a controller
 * pattern for its lifetime. See docs/plan/sandbox.md → "What withSandbox is".
 *
 * Four acquire paths, picked by `id` and `fresh`:
 *
 *   {}                      anonymous pool. acquire/release through `WarmPool`.
 *   { id }                  id-addressable. `AttachmentTable.acquire(id)`
 *                           reuses or boots; release decrements refCount and
 *                           parks under the id. Sweeper destroys on idle.
 *   { id, fresh: true }     destroy any existing entry for `id`, then acquire
 *                           anew. Stores under id like the plain `id` case.
 *   { fresh: true }         direct `backend.boot/destroy`, bypassing both pool
 *                           and attachment table. One-shot private VM.
 *
 * All four go through the scheduler first (`scheduler.allocate(sessionId)`)
 * and release the slot in the outer finally regardless of branch.
 */
import { assertServerOnImport } from '../harness-patterns/assert.server'
import { DEFAULT_SETTINGS } from '../settings'
import { getRequestSettings } from '../settings-context.server'
import { AttachmentTable } from './attachment-table.server'
import { DockerBackend } from './docker-backend.server'
import { runWithSandbox } from './scope.server'
import { SandboxScheduler } from './scheduler.server'
import { WarmPool } from './warm-pool.server'
import { hydrateWorkspace, snapshotOutputs, promoteOutputs } from './work-artifacts.server'
import type { ComputeBackend, RootfsId, RuntimeConfig } from './types'
import type {
  ConfiguredPattern,
  PatternConfig,
  PatternScope,
  EventView,
} from '../harness-patterns/types'

assertServerOnImport()

export interface WithSandboxConfig {
  /**
   * Id-addressable attachment. Two calls with the same id share one VM /
   * transport; the attachment stays parked under the id between calls.
   * Without `fresh`, an existing entry is reused.
   */
  id?: string
  /**
   * Force a fresh VM. With `id`: destroy any existing entry first, then
   * acquire a new one for the id. Without `id`: bypass both the pool and the
   * attachment table — one-shot `backend.boot/destroy` for a private VM.
   */
  fresh?: boolean
  /** Rootfs flavor. v0: `'base'` only. */
  rootfs?: RootfsId
  /** Per-VM runtime knobs. Defaults come from `settings.sandbox.*`. */
  resources?: Pick<RuntimeConfig, 'cpus' | 'memoryMB' | 'timeoutSec'>
  /** Egress profile. Defaults to `settings.sandbox.defaultEgress`. */
  egress?: RuntimeConfig['egress']
  /** Session id for `SandboxScheduler` per-session-cap accounting. */
  sessionId?: string
  /** Backend override. Defaults to a process-shared `DockerBackend`. */
  backend?: ComputeBackend
  /** Pool override. Defaults to a process-shared `WarmPool` from settings. */
  pool?: WarmPool
  /** Scheduler override. Defaults to a process-shared `SandboxScheduler`. */
  scheduler?: SandboxScheduler
  /** Attachment table override. Defaults to a process-shared instance. */
  attachments?: AttachmentTable
  /**
   * Durable workspace sync (#89). When true (id-addressable path only), the
   * session's stored documents are hydrated into `/work/in` on first boot and
   * new/changed files under `/work/out` are promoted back to the document store
   * on each turn's exit. Off by default — opt in per agent (Sandbox · Session
   * does). Requires the MCP gateway (document store lives in Redis).
   */
  syncWorkspace?: boolean
}

/** How often the default attachment table sweeps idle parked VMs (#82). This is
 *  a check *cadence*, not the idle threshold — eviction still respects
 *  `idleEvictMs`. The per-acquire lazy sweep covers active harnesses; this timer
 *  covers a fully idle one whose parked VMs would otherwise never be reaped. */
const SANDBOX_SWEEP_INTERVAL_MS = 60_000

// Process-shared singletons, lazily constructed from DEFAULT_SETTINGS. Cap
// values are read once at first use; the settings panel can't reshape an
// already-built scheduler/pool/table at runtime (those caps are process-
// scoped, not per-request — see docs/plan/sandbox.md → "Settings").
let defaultBackend: ComputeBackend | null = null
let defaultPool: WarmPool | null = null
let defaultScheduler: SandboxScheduler | null = null
let defaultAttachments: AttachmentTable | null = null
let orphansReaped = false

function getDefaultBackend(): ComputeBackend {
  if (!defaultBackend) {
    defaultBackend = new DockerBackend()
    // First default-singleton build == process start. Clear any sandbox
    // containers a previous (crashed / kill -9'd) process orphaned before we
    // start allocating against the cap. Only the default (production) backend
    // is reaped; tests inject their own backend and never reach here.
    reapOrphansOnce(defaultBackend)
  }
  return defaultBackend
}

/**
 * Fire the backend's orphan reaper exactly once per process, fire-and-forget
 * so the first acquire isn't latency-bound by it (#97 Gap 1). The reaper is
 * safe by construction (label-scoped); see `DockerBackend.reapOrphans` for the
 * multi-process caveat. Logs the count when it removes anything.
 */
function reapOrphansOnce(backend: ComputeBackend): void {
  if (orphansReaped) return
  orphansReaped = true
  void backend
    .reapOrphans()
    .then((n) => {
      if (n > 0) {
        console.warn(`[sandbox] reaped ${n} orphaned container(s) from a prior process`)
      }
    })
    .catch((err) => {
      console.warn(
        `[sandbox] orphan reap failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
}
function getDefaultPool(): WarmPool {
  if (!defaultPool) {
    defaultPool = new WarmPool(getDefaultBackend(), {
      caps: DEFAULT_SETTINGS.sandbox.warmPool,
      idleEvictMs: DEFAULT_SETTINGS.sandbox.idleEvictMs,
    })
  }
  return defaultPool
}
function getDefaultScheduler(): SandboxScheduler {
  if (!defaultScheduler) {
    defaultScheduler = new SandboxScheduler({
      globalCap: DEFAULT_SETTINGS.sandbox.globalCap,
      perSessionCap: DEFAULT_SETTINGS.sandbox.perSessionCap,
    })
  }
  return defaultScheduler
}
export function getDefaultAttachments(): AttachmentTable {
  if (!defaultAttachments) {
    defaultAttachments = new AttachmentTable(getDefaultBackend(), getDefaultPool(), {
      idleMs: DEFAULT_SETTINGS.sandbox.idleEvictMs,
      maxAttachments: DEFAULT_SETTINGS.sandbox.maxAttachments,
    })
    // Timer-driven sweep (#82): reap parked VMs even on a fully idle harness,
    // which the per-acquire lazy sweep never reaches. Only the default
    // (production) singleton is armed; tests inject their own table and opt in
    // explicitly. The timer is unref'd, so it never blocks process exit.
    defaultAttachments.startSweepTimer(SANDBOX_SWEEP_INTERVAL_MS)
  }
  return defaultAttachments
}

/**
 * Test seam: drop the lazy default singletons and re-arm the one-shot orphan
 * reaper so a test can observe a fresh first-build. Production never calls this.
 */
export function __resetSandboxDefaultsForTests(): void {
  defaultAttachments?.stopSweepTimer()
  defaultBackend = null
  defaultPool = null
  defaultScheduler = null
  defaultAttachments = null
  orphansReaped = false
}

/**
 * Wrap a pattern so its lifetime owns a sandbox VM. Composes orthogonally
 * with everything in the harness — `chain(withSandbox(actorCritic), synth)`,
 * `withSandbox(chain(simpleLoop, …, actorCritic))`, `router → routes`, etc.
 * The sandbox handle propagates to nested tool-calling controllers via ALS;
 * `chain` / `router` / `withReferences` don't need to be sandbox-aware.
 */
export function withSandbox(config?: WithSandboxConfig) {
  return <T>(pattern: ConfiguredPattern<T>): ConfiguredPattern<T> => {
    const backend = config?.backend ?? getDefaultBackend()
    // When the caller injects a custom backend (test scenario), build per-call
    // pool/scheduler/attachments so test state doesn't bleed through the
    // singletons. Tests can still inject any of them explicitly to share
    // state across multiple withSandbox invocations.
    const usingDefaultBackend = !config?.backend
    const pool =
      config?.pool ??
      (usingDefaultBackend
        ? getDefaultPool()
        : new WarmPool(backend, {
            caps: DEFAULT_SETTINGS.sandbox.warmPool,
            idleEvictMs: DEFAULT_SETTINGS.sandbox.idleEvictMs,
          }))
    const scheduler =
      config?.scheduler ??
      (usingDefaultBackend
        ? getDefaultScheduler()
        : new SandboxScheduler({
            globalCap: DEFAULT_SETTINGS.sandbox.globalCap,
            perSessionCap: DEFAULT_SETTINGS.sandbox.perSessionCap,
          }))
    const attachments =
      config?.attachments ??
      (usingDefaultBackend
        ? getDefaultAttachments()
        : new AttachmentTable(backend, pool, {
            idleMs: DEFAULT_SETTINGS.sandbox.idleEvictMs,
          }))

    const rootfs: RootfsId = config?.rootfs ?? 'base'
    const sessionId = config?.sessionId ?? 'default'
    const id = config?.id
    const fresh = config?.fresh === true
    const syncWorkspace = config?.syncWorkspace === true
    // Durable-workspace sync only runs on the id-addressable path (hydrate on
    // first boot, promote on exit — see runWithIdAttachment). The capability
    // marker below reflects that reality: syncWorkspace without an id is a no-op.
    const willSyncWorkspace = syncWorkspace && id !== undefined

    const fn = async (
      scope: PatternScope<T>,
      view: EventView,
    ): Promise<PatternScope<T>> => {
      const settings = getRequestSettings()
      const runtime: RuntimeConfig = {
        cpus: config?.resources?.cpus,
        memoryMB: config?.resources?.memoryMB ?? settings.sandbox.defaultMemoryMB,
        timeoutSec: config?.resources?.timeoutSec ?? settings.sandbox.defaultTimeoutSec,
        egress: config?.egress ?? settings.sandbox.defaultEgress,
      }

      const slot = await scheduler.allocate(sessionId)
      try {
        if (id) {
          return await runWithIdAttachment(
            attachments,
            id,
            fresh,
            rootfs,
            runtime,
            scope,
            view,
            pattern,
            sessionId,
            syncWorkspace,
          )
        }
        if (fresh) {
          return await runWithFreshVm(backend, rootfs, runtime, scope, view, pattern)
        }
        return await runWithPool(backend, pool, rootfs, runtime, scope, view, pattern)
      } finally {
        slot.release()
      }
    }

    return {
      ...pattern,
      name: `withSandbox(${pattern.name})`,
      fn,
      // Expose the wrapped pattern so static introspection (pattern-capabilities)
      // can see patterns nested inside a sandbox wrapper.
      children: [pattern],
      // When durable workspaces are active, stamp a marker the registry's
      // `agentUsesSyncWorkspace` reads so the interactive Shell knows to hydrate
      // /work on a first boot it triggers (#97 Gap 3). Stamped only when it will
      // sync, so the wrapper stays config-transparent otherwise; the spread
      // suppresses the excess-property check (mirrors the retriever's
      // `backendKinds`).
      ...(willSyncWorkspace
        ? { config: { ...pattern.config, sandboxSyncWorkspace: true } as PatternConfig }
        : {}),
    }
  }
}

// ============================================================================
// Branch implementations — extracted so the main `fn` reads top-to-bottom.
// ============================================================================

async function runWithPool<T>(
  backend: ComputeBackend,
  pool: WarmPool,
  rootfs: RootfsId,
  runtime: RuntimeConfig,
  scope: PatternScope<T>,
  view: EventView,
  pattern: ConfiguredPattern<T>,
): Promise<PatternScope<T>> {
  const vm = await pool.acquire(rootfs, runtime)
  let transport
  try {
    transport = await backend.connectMcp(vm)
  } catch (err) {
    await pool.release(vm).catch(() => {})
    throw err
  }
  try {
    return await runWithSandbox(transport, () => pattern.fn(scope, view))
  } finally {
    await transport.close().catch(() => {})
    await pool.release(vm).catch(() => {})
  }
}

async function runWithFreshVm<T>(
  backend: ComputeBackend,
  rootfs: RootfsId,
  runtime: RuntimeConfig,
  scope: PatternScope<T>,
  view: EventView,
  pattern: ConfiguredPattern<T>,
): Promise<PatternScope<T>> {
  const vm = await backend.boot(rootfs, runtime)
  let transport
  try {
    transport = await backend.connectMcp(vm)
  } catch (err) {
    await backend.destroy(vm).catch(() => {})
    throw err
  }
  try {
    return await runWithSandbox(transport, () => pattern.fn(scope, view))
  } finally {
    await transport.close().catch(() => {})
    await backend.destroy(vm).catch(() => {})
  }
}

async function runWithIdAttachment<T>(
  attachments: AttachmentTable,
  id: string,
  fresh: boolean,
  rootfs: RootfsId,
  runtime: RuntimeConfig,
  scope: PatternScope<T>,
  view: EventView,
  pattern: ConfiguredPattern<T>,
  sessionId: string,
  syncWorkspace: boolean,
): Promise<PatternScope<T>> {
  if (fresh) {
    await attachments.destroyById(id).catch(() => {})
  }
  const att = await attachments.acquire(id, rootfs, runtime)
  try {
    // Without workspace sync (the default), run the pattern directly — no
    // document-store / extra transport traffic. Keeps plain `{ id }` sandboxes
    // (and their tests) free of the persistence machinery.
    if (!syncWorkspace) {
      return await runWithSandbox(att.transport, () => pattern.fn(scope, view))
    }
    return await runWithSandbox(att.transport, async () => {
      // First boot of a fresh container → restore the session's stored
      // documents into /work/in. Reused live attachments skip this (#89).
      if (att.isFirstBoot) {
        await hydrateWorkspace(att.transport, sessionId).catch(() => {})
        att.isFirstBoot = false
      }
      // Promote only what THIS turn produces: snapshot /work/out before the
      // turn, diff after. In `finally` so deliverables are saved even if the
      // pattern throws.
      const baseline = await snapshotOutputs(att.transport).catch(
        () => new Map<string, string>(),
      )
      try {
        return await pattern.fn(scope, view)
      } finally {
        await promoteOutputs(att.transport, sessionId, baseline).catch(() => {})
      }
    })
  } finally {
    attachments.release(att)
  }
}
