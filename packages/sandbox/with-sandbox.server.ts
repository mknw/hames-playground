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
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { trackEvent } from '@hames-ai/harness-patterns/context.server'
import { amendRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import { DEFAULT_SANDBOX_SETTINGS } from './settings'
import { AttachmentTable } from './attachment-table.server'
import { DockerBackend } from './docker-backend.server'
import { SandboxScheduler } from './scheduler.server'
import { WarmPool } from './warm-pool.server'
import { hydrateWorkspace, snapshotOutputs, promoteOutputs } from './work-artifacts.server'
import type { ComputeBackend, McpTransport, RootfsId, RuntimeConfig } from './types'
import type {
  ConfiguredPattern,
  ErrorEventData,
  PatternCapabilities,
  PatternScope,
  EventView,
} from '@hames-ai/harness-patterns/types'

assertServerOnImport()

/**
 * Run `fn` with this VM's in-VM MCP transport scoped to it.
 *
 * This is the sandbox's SCOPED registration on core's tool-transport seam, and
 * it replaced a sandbox-owned AsyncLocalStorage of its own. Core no longer knows
 * what a sandbox is: what it knows is that a transport supplied this way is
 * consulted before any process-registered transport and before the gateway,
 * innermost first. The `sandbox_*` prefix in `types.ts` is now the only thing
 * tying dispatch to this package.
 *
 * It amends the RUN FRAME rather than opening a scope of its own (issue #374):
 * `withSandbox` is one of exactly two combinators that legitimately scope below
 * a run, and `amendRunFrame` is where the per-slot merge rules live — the
 * `transports` slot PREPENDS, which is what makes the stack innermost-first,
 * and is deliberately the opposite of the guard slot's widening rule. Amending
 * requires an open frame, so a sandbox outside a run refuses instead of quietly
 * attaching a VM to nothing.
 *
 * `McpTransport` is `ToolTransport` plus a VM identity and a lifecycle
 * (`vmId` / `toolNames` / `close`), none of which core has any use for, so the
 * adaptation is a narrowing rather than a new capability.
 */
function runWithSandbox<T>(transport: McpTransport, fn: () => Promise<T>): Promise<T> {
  return amendRunFrame(
    {
      transports: [
        {
          id: `sandbox:${transport.vmId}`,
          ownsTool: (name) => transport.ownsTool(name),
          callTool: (name, args) => transport.callTool(name, args),
          listTools: () => transport.listTools(),
        },
      ],
    },
    fn,
  )
}

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
  /**
   * Tenant identity for per-tenant resource naming (the `/cache` volume).
   * Resolved server-side by the caller from the conversation's owner — never
   * accepted from client input; `'default'` (or absent) is the single-operator
   * tenant and keeps today's volume name verbatim. See `RuntimeConfig`.
   *
   * **A literal OR a resolver, and the agent path needs the resolver.**
   * `withSandbox(config)` is called when a host BUILDS its patterns, and a
   * built chain is cached for the conversation's life (the app's
   * `getOrBuildPatterns`); the authenticated user, meanwhile, is only in scope
   * for the duration of one turn. A literal read at wrap time therefore freezes
   * whichever tenant happened to be in scope during the build — including
   * `'default'` for a build that ran outside a request, e.g. a capability
   * probe — onto every later turn of that conversation, silently, on the one
   * field the poisoned-wheel channel (#348) is scoped by. A function is called
   * instead on EVERY run, inside the request scope, which is where the answer
   * is actually knowable. Direct callers that already hold the owner (the Shell
   * path's `PtyManager.start`) pass the string.
   */
  tenantId?: string | (() => string | undefined)
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
   * session's stored documents are hydrated into `/work/in` at each turn's
   * entry (diff-wise — only what is missing, #206 §6.1) and new/changed files
   * under `/work/out` are promoted back to the document store on each turn's
   * exit. Off by default — opt in per agent (Sandbox · Session
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
        // The count covers containers AND pruned per-boot networks (the
        // labeled sweep reaps both) — hence "resources", not "containers".
        console.warn(
          `[sandbox] reaped ${n} orphaned sandbox resource(s) (containers + per-boot egress networks) from a prior process`,
        )
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
      caps: DEFAULT_SANDBOX_SETTINGS.warmPool,
      idleEvictMs: DEFAULT_SANDBOX_SETTINGS.idleEvictMs,
    })
  }
  return defaultPool
}
function getDefaultScheduler(): SandboxScheduler {
  if (!defaultScheduler) {
    defaultScheduler = new SandboxScheduler({
      globalCap: DEFAULT_SANDBOX_SETTINGS.globalCap,
      perSessionCap: DEFAULT_SANDBOX_SETTINGS.perSessionCap,
    })
  }
  return defaultScheduler
}
export function getDefaultAttachments(): AttachmentTable {
  if (!defaultAttachments) {
    defaultAttachments = new AttachmentTable(getDefaultBackend(), getDefaultPool(), {
      idleMs: DEFAULT_SANDBOX_SETTINGS.idleEvictMs,
      maxAttachments: DEFAULT_SANDBOX_SETTINGS.maxAttachments,
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
/** Read {@link WithSandboxConfig.tenantId} — a literal, or a resolver called
 *  per run. A resolver that throws must not take the turn down with it: the
 *  caller's tenant is unknowable, which is exactly the `'default'` case, so it
 *  is reported and degraded rather than propagated (the boot still happens, on
 *  the verbatim-name tenant, which is what an unauthenticated boot gets). */
function resolveTenantId(tenantId: WithSandboxConfig['tenantId']): string | undefined {
  if (typeof tenantId !== 'function') return tenantId
  try {
    return tenantId()
  } catch (err) {
    console.warn(
      `[sandbox] tenant resolver threw; booting on the 'default' tenant: ` +
        (err instanceof Error ? err.message : String(err)),
    )
    return undefined
  }
}

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
            caps: DEFAULT_SANDBOX_SETTINGS.warmPool,
            idleEvictMs: DEFAULT_SANDBOX_SETTINGS.idleEvictMs,
          }))
    const scheduler =
      config?.scheduler ??
      (usingDefaultBackend
        ? getDefaultScheduler()
        : new SandboxScheduler({
            globalCap: DEFAULT_SANDBOX_SETTINGS.globalCap,
            perSessionCap: DEFAULT_SANDBOX_SETTINGS.perSessionCap,
          }))
    const attachments =
      config?.attachments ??
      (usingDefaultBackend
        ? getDefaultAttachments()
        : new AttachmentTable(backend, pool, {
            idleMs: DEFAULT_SANDBOX_SETTINGS.idleEvictMs,
          }))

    const rootfs: RootfsId = config?.rootfs ?? 'base'
    const sessionId = config?.sessionId ?? 'default'
    const id = config?.id
    const fresh = config?.fresh === true
    const syncWorkspace = config?.syncWorkspace === true
    // Durable-workspace sync only runs on the id-addressable path (hydrate on
    // entry, promote on exit — see runWithIdAttachment). The capability
    // declaration below reflects that reality: syncWorkspace without an id is a
    // no-op, and declaring a capability the run does not honour is worse than
    // declaring none — the Shell would skip a hydration nobody performs.
    const willSyncWorkspace = syncWorkspace && id !== undefined
    // …and a no-op is exactly what the caller did NOT ask for. Asking for a
    // durable workspace and silently getting none is how #243's follow-up bug
    // presented: a route with no `id` ran in a container where /work/in never
    // existed, so a file ingested on another turn was invisible and the actor
    // burned its retries on `ls: cannot access '/work/in'`. Config error, not a
    // runtime one — say so at wrap time rather than leaving it to a log trace.
    if (syncWorkspace && id === undefined) {
      console.warn(
        `[sandbox] withSandbox({ syncWorkspace: true }) ignored for pattern "${pattern.name}": ` +
          'it requires an `id` (the anonymous-pool and `{ fresh }` paths have no durable ' +
          'workspace). Pass `id` — e.g. `${sessionId}:${rootfs}` — to hydrate /work/in.',
      )
    }

    // The capability this wrapper DECLARES, in core's own vocabulary. Core does
    // not know what a sandbox is (see the `runWithSandbox` note above); what it
    // knows is that some pattern's subtree runs against a workspace that
    // outlives its container, and `PatternCapabilities.workspaceSync` is the
    // typed field it owns for saying so. The annotation is what makes this
    // package fail to compile if core renames the field — the
    // `sandboxSyncWorkspace` config key it replaced was a string both sides
    // declared independently, so a rename typechecked in both packages and
    // silently turned Shell hydration off.
    const capabilities: PatternCapabilities | undefined = willSyncWorkspace
      ? { workspaceSync: true }
      : undefined

    const fn = async (scope: PatternScope<T>, view: EventView): Promise<PatternScope<T>> => {
      // The per-call defaults were read from the app's request-scoped settings
      // before the extraction. That scope never carried a sandbox block of its
      // own — the app's `resolveSettings` assigned `DEFAULT_SETTINGS.sandbox`
      // unconditionally and its reader spread the same defaults back in — so
      // this reads the package's own constants and the three values are
      // unchanged. A host that wants different ones passes `resources` /
      // `egress` per call, which is the override that always won anyway.
      const runtime: RuntimeConfig = {
        cpus: config?.resources?.cpus,
        memoryMB: config?.resources?.memoryMB ?? DEFAULT_SANDBOX_SETTINGS.defaultMemoryMB,
        timeoutSec: config?.resources?.timeoutSec ?? DEFAULT_SANDBOX_SETTINGS.defaultTimeoutSec,
        egress: config?.egress ?? DEFAULT_SANDBOX_SETTINGS.defaultEgress,
        // Tenant seam: 'default' when the caller has no authenticated user —
        // the backend treats it (and absent) as the verbatim-name tenant.
        // Resolved HERE, per run, not at wrap time: see `WithSandboxConfig.tenantId`.
        tenantId: resolveTenantId(config?.tenantId) ?? 'default',
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
      // Declared so the registry's `agentUsesSyncWorkspace` can read it and the
      // interactive Shell knows to hydrate /work on a first boot it triggers
      // (#97 Gap 3). A TYPED SIBLING FIELD, not a config key: the wrapper stays
      // config-transparent — `pattern.config` is still the inner pattern's own
      // object, identity included — which is the same charter `injectionGuard`
      // has. It used to clone the config to carry a `sandboxSyncWorkspace` key,
      // which broke that transparency for exactly the agents that need the
      // capability, and did it through a cast that hid the key from both
      // packages' compilers.
      ...(capabilities ? { capabilities } : {}),
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

const WORKSPACE_FAILURE_MESSAGE: Record<'hydrate' | 'snapshot' | 'promote', string> = {
  hydrate: 'Stored documents were not restored into /work/in — this turn ran without prior files.',
  snapshot:
    'The pre-turn /work/out snapshot failed, so promotion was skipped to avoid re-storing ' +
    'the whole directory as duplicates. Files stay in the container until a later turn.',
  promote:
    'Files under /work/out were NOT saved to the Data Stash and will be lost when the ' +
    'container is reaped. Re-run the file operation or copy the file out of the sandbox.',
}

/**
 * Report a durable-workspace (#89) step that failed, on BOTH channels.
 *
 * `trackEvent` puts it in the observability timeline (and streams it live);
 * `console.error` is the copy that survives a pattern throw, which skips
 * `commitEvents` and discards the scope's events entirely. Every one of these
 * was a bare `.catch(() => {})` before — and `promote` is the one that loses a
 * deliverable the agent has already claimed to have written, seconds before
 * the container is reaped.
 */
function reportWorkspaceFailure<T>(
  scope: PatternScope<T>,
  step: 'hydrate' | 'snapshot' | 'promote',
  sessionId: string,
  err: unknown,
): void {
  const detail = err instanceof Error ? err.message : String(err)
  const message = WORKSPACE_FAILURE_MESSAGE[step]
  console.error(`[sandbox] ${step} failed for session ${sessionId}: ${detail}`)
  trackEvent(
    scope,
    'error',
    {
      error: `sandbox workspace ${step} failed: ${detail}`,
      severity: 'recoverable',
      hint: message,
    } as ErrorEventData,
    true,
  )
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
      // Restore the session's stored documents into /work/in — EVERY turn, not
      // just on a fresh container (#206 §6.1). `hydrateWorkspace` diffs against
      // what /work/in already holds (the mirror of the snapshot/promote pair
      // below), so a steady-state turn costs one document list plus one in-VM
      // `find` and writes nothing. Gating this on `att.isFirstBoot` made turn 1
      // work only by accident of ordering — a document ingested during turn 2,
      // or before the container booted for a Shell the user opened first, never
      // reached the actor.
      try {
        const { skipped } = await hydrateWorkspace(att.transport, sessionId)
        if (skipped.length > 0) {
          reportWorkspaceFailure(
            scope,
            'hydrate',
            sessionId,
            new Error(
              `${skipped.length} file(s) not restored: ` +
                skipped.map((f) => `${f.filename} (${f.error})`).join(', '),
            ),
          )
        }
      } catch (err) {
        // Non-fatal: the turn still runs, but the agent cannot see prior
        // uploads or earlier deliverables, so say which turn was blind.
        reportWorkspaceFailure(scope, 'hydrate', sessionId, err)
      }
      // The Shell's own first-boot hydrate (#97 Gap 3) would now be redundant
      // for this container — the flag still coordinates the two, it just no
      // longer gates the agent side.
      att.isFirstBoot = false
      // Promote only what THIS turn produces: snapshot /work/out before the
      // turn, diff after. In `finally` so deliverables are saved even if the
      // pattern throws.
      //
      // A FAILED snapshot is not an empty one. `diffWorkFiles` compares against
      // the baseline, so substituting an empty Map would mark every pre-existing
      // file as produced-this-turn and re-store the whole directory as duplicate
      // stash documents. `null` means "no baseline" and skips promotion for this
      // turn instead — the files stay in the container and the next turn (which
      // snapshots successfully) promotes whatever changed.
      let baseline: Map<string, string> | null = null
      try {
        baseline = await snapshotOutputs(att.transport)
      } catch (err) {
        reportWorkspaceFailure(scope, 'snapshot', sessionId, err)
      }
      try {
        return await pattern.fn(scope, view)
      } finally {
        if (baseline) {
          try {
            const { skipped } = await promoteOutputs(att.transport, sessionId, baseline)
            if (skipped.length > 0) {
              // Per-file failures: the turn survived, individual deliverables
              // did not. Name them, since the agent has already reported
              // writing them (sf-L8).
              reportWorkspaceFailure(
                scope,
                'promote',
                sessionId,
                new Error(
                  `${skipped.length} file(s) not stored: ` +
                    skipped.map((f) => `${f.filename} (${f.error})`).join(', '),
                ),
              )
            }
          } catch (err) {
            // The deliverable the agent just told the user about is about to
            // be reaped with the container. This was a bare `.catch(() => {})`
            // and is the one failure in this file that silently loses data.
            reportWorkspaceFailure(scope, 'promote', sessionId, err)
          }
        }
      }
    })
  } finally {
    attachments.release(att)
  }
}
