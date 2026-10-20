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
import { amendRunFrame, type RunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import { DEFAULT_SANDBOX_SETTINGS } from './settings'
import { AttachmentTable, type Attachment } from './attachment-table.server'
import { DockerBackend } from './docker-backend.server'
import { SandboxScheduler } from './scheduler.server'
import { WarmPool } from './warm-pool.server'
import { hydrateWorkspace, snapshotOutputs, promoteOutputs } from './work-artifacts.server'
import { syncSkills } from './skills.server'
import {
  SKILLS_INDEX_TOOL,
  SKILLS_PENDING_NOTICE,
  renderSkillsIndex,
  type SandboxSkill,
  type SandboxSkillsResolver,
} from './skills'
import { V0_IN_VM_SERVERS } from './types'
import { IN_VM_TOOL_DESCRIPTORS } from './in-vm-tools'
import { classifySandboxFailure, type SandboxFailure } from './failure'
import type { ComputeBackend, McpTransport, RootfsId, RuntimeConfig } from './types'
import type { ToolTransport } from '@hames-ai/harness-patterns/tool-transport.server'
import type {
  ConfiguredPattern,
  ErrorEventData,
  WarningEventData,
  PatternCapabilities,
  PatternScope,
  EventView,
  ToolCallResult,
} from '@hames-ai/harness-patterns/types'

assertServerOnImport()

/** Every in-VM tool a sandbox exposes, by its exposed (`sandbox_`-prefixed) name. */
const IN_VM_TOOL_NAMES: readonly string[] = V0_IN_VM_SERVERS.flatMap((server) =>
  Object.values(server.tools),
)

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
 *
 * `skillsIndex` is the run's skills index (#415), when skills were mounted. It
 * rides the transport as `promptContext`, which the adapters render in the
 * request's `user`-role CONTEXT block — not in the tool list, which stays the
 * transport's own byte for byte, and not in the system message (see
 * `skills.ts` for the two defects the earlier placement had).
 */
function runWithSandbox<T>(
  transport: McpTransport,
  fn: () => Promise<T>,
  skillsIndex?: string,
): Promise<T> {
  return amendRunFrame(
    {
      transports: [
        {
          id: `sandbox:${transport.vmId}`,
          ownsTool: (name) => transport.ownsTool(name),
          callTool: (name, args) => transport.callTool(name, args),
          listTools: () => transport.listTools(),
          ...(skillsIndex ? { promptContext: skillsIndex } : {}),
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
  /**
   * Skills to mount for each run (#415): resolved per run, written into the
   * container as `/skills/<name>/SKILL.md`, and indexed (name + description)
   * as the transport's `promptContext` — a delimited `<skills>` block in the
   * request's `user`-role context — so the actor reads a file only when its
   * description fits the task. See `skills.ts` / `skills.server.ts`.
   *
   * A RESOLVER for `tenantId`'s reason: the patterns are built once per
   * conversation, the user — whose skills these are — is known only inside a
   * turn. The host decides which skills a run gets and is responsible for
   * resolving them server-side from the run's owner, never from client input.
   *
   * Absent, nothing about the run changes: no `/skills` traffic, no index.
   * Present, the sync runs on every path (pool, fresh, id), and a failure is
   * reported as a `warning` event (#420) and the run proceeds without the
   * skills it could not mount — fail-open on availability, and never an index
   * line for a file that is not there.
   */
  skills?: SandboxSkillsResolver
  /**
   * Start the sandbox on the FIRST `sandbox_*` call instead of at the turn's entry
   * (id-addressable path only: it needs an `id`). A turn that never calls an
   * in-VM tool — a Graph-only one — then touches no container engine at all: no
   * scheduler slot, no boot, no hydrate, no promote, and no singleton construction.
   * Default off, and off is the behaviour that existed before this option.
   *
   * What changes while it is on, all deliberate:
   *  - The prompt lists {@link IN_VM_TOOL_DESCRIPTORS} (a package-static table)
   *    rather than what the booted servers reported — there is no VM to ask.
   *  - With `skills`, the index appears on the prompt only after the first boot has
   *    mounted them; until then the prompt carries {@link SKILLS_PENDING_NOTICE}.
   *  - Concurrent first calls share ONE boot, and a failed boot is remembered for
   *    the rest of the run (the next turn tries again), so a retrying actor costs
   *    one failed boot, not one per attempt.
   *  - A boot that fails answers the call with a CLASSIFIED failure
   *    (`classifySandboxFailure`): fixed text, never the engine's own words, which go
   *    to the server log only. Eager mode throws the raw error instead.
   */
  lazy?: boolean
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

interface SandboxResources {
  backend: ComputeBackend
  pool: WarmPool
  scheduler: SandboxScheduler
  attachments: AttachmentTable
}

function buildResources(config: WithSandboxConfig | undefined): SandboxResources {
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
  return { backend, pool, scheduler, attachments }
}

export function withSandbox(config?: WithSandboxConfig) {
  return <T>(pattern: ConfiguredPattern<T>): ConfiguredPattern<T> => {
    const lazy = config?.lazy === true
    if (lazy && config?.id === undefined) {
      throw new Error(
        `withSandbox({ lazy: true }) requires an \`id\` (pattern "${pattern.name}"): only the ` +
          'id-addressable path can defer its boot.',
      )
    }
    // The backend, pool, scheduler and attachment table. Eager mode builds them
    // HERE, at wrap time, exactly as before (the default singletons' first build
    // also arms the orphan reaper). Lazy mode builds them on the first boot, so a
    // turn that never needs a sandbox never constructs a container backend.
    let resources: SandboxResources | undefined
    const resolveResources = (): SandboxResources => (resources ??= buildResources(config))
    if (!lazy) resolveResources()

    const rootfs: RootfsId = config?.rootfs ?? 'base'
    const sessionId = config?.sessionId ?? 'default'
    const id = config?.id
    const fresh = config?.fresh === true
    const syncWorkspace = config?.syncWorkspace === true
    const skills = config?.skills
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

    // The capabilities this wrapper DECLARES, in core's own vocabulary. Core
    // does not know what a sandbox is (see the `runWithSandbox` note above);
    // what it knows is that some pattern's subtree runs against a workspace
    // that outlives its container, and `PatternCapabilities.workspaceSync` is the
    // typed field it owns for saying so. The annotation is what makes this
    // package fail to compile if core renames the field — the
    // `sandboxSyncWorkspace` config key it replaced was a string both sides
    // declared independently, so a rename typechecked in both packages and
    // silently turned Shell hydration off.
    //
    // `tools` (#507) is the in-VM surface by exact name, so a planner's agent
    // map can say what a sandboxed route can DO. It is the curated registry's
    // static list, not a probe of a live VM: the names are the contract, and the
    // transport refuses anything else at call time. It is MERGED over the
    // wrapped pattern's own declaration rather than replacing it, because this
    // wrapper's own `capabilities` shadows the one `...pattern` would otherwise
    // inherit.
    const capabilities: PatternCapabilities = {
      ...pattern.capabilities,
      tools: [...new Set([...(pattern.capabilities?.tools ?? []), ...IN_VM_TOOL_NAMES])],
      ...(willSyncWorkspace ? { workspaceSync: true } : {}),
    }

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

      if (lazy) {
        return await runWithLazyIdAttachment({
          resolveResources,
          id: id!,
          fresh,
          rootfs,
          runtime,
          scope,
          view,
          pattern,
          sessionId,
          syncWorkspace,
          skills,
        })
      }
      const { backend, pool, scheduler, attachments } = resolveResources()
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
            skills,
          )
        }
        if (fresh) {
          return await runWithFreshVm(backend, rootfs, runtime, scope, view, pattern, skills)
        }
        return await runWithPool(backend, pool, rootfs, runtime, scope, view, pattern, skills)
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
      capabilities,
    }
  }
}

// ============================================================================
// Skills (#415) — resolve, sync into /skills, render the index.
// ============================================================================

/**
 * Report a skills step that did not go to plan, on both channels: a `warning`
 * event (#420's side-failure scheme — the turn ran on a fallback, so no error
 * reader may treat it as a statement about the turn: not `settleTurn`, not the
 * synthesizer's `hasErrors()`) and a console copy, which survives a pattern
 * that later throws and discards the scope's events.
 */
function reportSkillsFailure<T>(
  scope: PatternScope<T>,
  warning: Omit<WarningEventData, 'task'>,
): void {
  console.error(`[sandbox] skills: ${warning.error ?? warning.message}`)
  trackEvent(
    scope,
    'warning',
    { task: 'skills_mount', ...warning } satisfies WarningEventData,
    true,
  )
}

/**
 * Make the container's `/skills` match what the host resolved for this run,
 * and return the index of what actually landed (or `undefined`).
 *
 * Failure policy, named: every step fails OPEN on availability (the run goes on
 * without the skills it could not mount) and CLOSED on the index (a skill is
 * listed only once its file is confirmed written). A resolver that throws is
 * treated as "no skills", and the sync still runs with the empty set — an
 * id-addressable container may hold skills from an earlier turn, and an
 * unknown set must not leave a withdrawn skill readable.
 */
async function prepareSkills<T>(
  transport: McpTransport,
  scope: PatternScope<T>,
  resolver: SandboxSkillsResolver | undefined,
): Promise<string | undefined> {
  if (!resolver) return undefined
  let skills: readonly SandboxSkill[]
  try {
    skills = await resolver()
  } catch (err) {
    reportSkillsFailure(scope, {
      message: 'Your skills could not be loaded for this sandbox.',
      fallback: 'The agent ran without skills.',
      error: `could not resolve this run's skills: ${err instanceof Error ? err.message : String(err)}`,
    })
    skills = []
  }
  // Every mount command is a `sandbox_bash` call, and the index tells the actor
  // to read a skill with it: a transport without it can do neither.
  if (!transport.ownsTool(SKILLS_INDEX_TOOL)) {
    if (skills.length > 0) {
      reportSkillsFailure(scope, {
        message: 'This sandbox cannot mount skills.',
        fallback: 'The agent ran without skills.',
        error: `this sandbox has no ${SKILLS_INDEX_TOOL} tool, so ${skills.length} skill(s) were not mounted`,
      })
    }
    return undefined
  }
  try {
    const { mounted, skipped, removalError } = await syncSkills(transport, skills)
    if (skipped.length > 0) {
      reportSkillsFailure(scope, {
        message: `${skipped.length} skill(s) could not be mounted in the sandbox.`,
        fallback: 'The agent ran with the skills that did mount.',
        error:
          `${skipped.length} skill(s) not mounted: ` +
          skipped.map((s) => `${s.name || '(unnamed)'} (${s.error})`).join(', '),
      })
    }
    if (removalError) {
      reportSkillsFailure(scope, {
        message:
          'A skill removed or hidden since the last turn could not be cleared from the sandbox.',
        fallback: 'It may still be readable in this sandbox; the agent is not told about it.',
        error: removalError,
      })
    }
    return renderSkillsIndex(mounted)
  } catch (err) {
    reportSkillsFailure(scope, {
      message: 'Your skills could not be mounted in the sandbox.',
      fallback: 'The agent ran without skills.',
      error: `mounting failed: ${err instanceof Error ? err.message : String(err)}`,
    })
    return undefined
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
  skills?: SandboxSkillsResolver,
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
    const index = await prepareSkills(transport, scope, skills)
    return await runWithSandbox(transport, () => pattern.fn(scope, view), index)
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
  skills?: SandboxSkillsResolver,
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
    const index = await prepareSkills(transport, scope, skills)
    return await runWithSandbox(transport, () => pattern.fn(scope, view), index)
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
  opts: { withholdDetail?: boolean } = {},
): void {
  const detail = err instanceof Error ? err.message : String(err)
  const message = WORKSPACE_FAILURE_MESSAGE[step]
  // The server log always carries the raw detail. The EVENT is what the
  // synthesizer's `lastError()` reads, so where the detail holds stash-derived
  // text (a stored filename) it is withheld from the event: a document's name is
  // attacker-controlled and an error event is not passed through the guard
  // (#599 review F1).
  console.error(`[sandbox] ${step} failed for session ${sessionId}: ${detail}`)
  trackEvent(
    scope,
    'error',
    {
      error: opts.withholdDetail
        ? `sandbox workspace ${step} failed (details withheld; see the server log)`
        : `sandbox workspace ${step} failed: ${detail}`,
      severity: 'recoverable',
      hint: message,
    } as ErrorEventData,
    true,
  )
}

/**
 * Re-hydrate `/work/in` after a tool call in this scope stored a stash document
 * (#507 N4). `/work/in` is otherwise filled once, on entry, so a file ingested
 * mid-run — `graph_file_ingest` — is in the stash and not on disk until the
 * route is entered again, and the actor is told the file exists that it cannot
 * open.
 *
 * TIMING: EAGER, on the storing call itself — dispatch and stash write → guard →
 * this scope's after-call hook → `hydrateWorkspace` → the result returns to the
 * caller. Not on a later call: a restore deferred to the next non-sandbox call
 * would leave the sandbox read that follows an ingest stale, or never run when
 * the actor returns straight after it.
 *
 * Two run-frame seams, both concatenating: an observer on core's `storeDocument`
 * and an after-call hook. The observer records, per `callId`, the ids of
 * documents stored under THIS sandbox's own `sessionId` (a write to any other
 * conversation's stash is heard and ignored); the hook of that same call takes
 * its ids and restores. Pending writes belong to the call that made them, so a
 * nested `sandbox_*` call, a parallel storing call or an unrelated lookup can
 * neither consume them nor inherit their failure, and every storing call awaits
 * and receives its own restore outcome (#599 review F3).
 *
 * Failure policy, named: FAIL CLOSED. The call stored its document; unless a
 * strict read says each stored document is now accounted for in `/work/in`
 * (`hydrateWorkspace`'s `accounted` ids — an empty listing proves nothing), the
 * call's result becomes a FIXED failure text and an `error` event with the
 * detail withheld. The raw detail (which may carry stash filenames) goes to the
 * server log only; and since `callTool` guards the replacement as well, neither
 * path can carry stash-derived text to the model (#599 review F1).
 *
 * LIFETIME: the callbacks are inherited by anything created inside the scope —
 * a detached promise outlives `AsyncLocalStorage.run`. `close()` marks the scope
 * closed, after which both callbacks are inert, and drains a restore already in
 * flight; `runWithIdAttachment` calls it before it releases the attachment
 * (#599 review F4).
 */
const RESTORE_FAILED =
  'The document was stored in the Data Stash but could not be copied into /work/in. ' +
  'It is NOT available to the sandbox. Do not repeat the call; tell the user the file ' +
  'could not be loaded.'

interface RestoreScope {
  frame: RunFrame
  close(): Promise<void>
}

function restoreAfterStashWrite<T>(
  /** The VM to restore into, or `undefined` when there is none (yet): a lazy
   *  sandbox that has not started has no `/work/in` to be stale, and its boot
   *  hydrates every stored document anyway. */
  resolveTransport: () => Promise<McpTransport | undefined>,
  scope: PatternScope<T>,
  sessionId: string,
): RestoreScope {
  let closed = false
  const pending = new Map<string, Set<string>>()
  let queue: Promise<unknown> = Promise.resolve()
  const restore = async (ids: Set<string>): Promise<ToolCallResult | void> => {
    if (closed) return
    try {
      const transport = await resolveTransport()
      if (!transport) return
      const { skipped, accounted } = await hydrateWorkspace(transport, sessionId)
      const seen = new Set(accounted)
      const unaccounted = [...ids].filter((id) => !seen.has(id))
      if (skipped.length === 0 && unaccounted.length === 0) return
      throw new Error(
        `${skipped.length} file(s) not restored: ` +
          skipped.map((f) => `${f.filename} (${f.error})`).join(', ') +
          (unaccounted.length > 0
            ? ` ${unaccounted.length} stored document(s) not found by the restore: ${unaccounted.join(', ')}`
            : ''),
      )
    } catch (err) {
      reportWorkspaceFailure(scope, 'hydrate', sessionId, err, { withholdDetail: true })
      return { success: false, data: null, error: RESTORE_FAILED }
    }
  }
  return {
    frame: {
      stashWriteObservers: [
        (write) => {
          if (closed || write.sessionId !== sessionId || write.callId === undefined) return
          let ids = pending.get(write.callId)
          if (!ids) pending.set(write.callId, (ids = new Set()))
          ids.add(write.documentId)
        },
      ],
      afterToolCall: [
        ({ id, name }) => {
          // The VM's own tools never store a stash document: skipped outright,
          // and without touching anything pending for the call that wraps them.
          if (closed || name.startsWith('sandbox_')) return Promise.resolve()
          const ids = pending.get(id)
          if (!ids) return Promise.resolve()
          pending.delete(id)
          const next = queue.then(() => restore(ids))
          queue = next.catch(() => {})
          return next
        },
      ],
    },
    async close() {
      closed = true
      pending.clear()
      await queue
    },
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
  skills?: SandboxSkillsResolver,
): Promise<PatternScope<T>> {
  if (fresh) {
    await attachments.destroyById(id).catch(() => {})
  }
  const att = await attachments.acquire(id, rootfs, runtime)
  try {
    const index = await prepareSkills(att.transport, scope, skills)
    const run = <R>(fn: () => Promise<R>): Promise<R> => runWithSandbox(att.transport, fn, index)
    // Without workspace sync (the default), run the pattern directly — no
    // document-store / extra transport traffic. Keeps plain `{ id }` sandboxes
    // (and their tests) free of the persistence machinery.
    if (!syncWorkspace) {
      return await run(() => pattern.fn(scope, view))
    }
    return await run(async () => {
      const baseline = await hydrateAndSnapshot(att, scope, sessionId)
      const restoring = restoreAfterStashWrite(async () => att.transport, scope, sessionId)
      try {
        return await amendRunFrame(restoring.frame, () => pattern.fn(scope, view))
      } finally {
        // Before promotion and before the attachment is released: nothing
        // inherited from the pattern may restore into it from here on (F4).
        await restoring.close()
        await promoteTurn(att.transport, scope, sessionId, baseline)
      }
    })
  } finally {
    attachments.release(att)
  }
}

/**
 * The entry half of the durable-workspace sync: restore stored documents into
 * `/work/in` and take the pre-turn `/work/out` baseline. Returns `null` when the
 * snapshot failed — "no baseline", which skips promotion. Never throws: every step
 * reports a `warning`-class failure and the turn goes on.
 */
async function hydrateAndSnapshot<T>(
  att: Attachment,
  scope: PatternScope<T>,
  sessionId: string,
): Promise<Map<string, string> | null> {
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
  return baseline
}

/** The exit half: promote what the turn produced since `baseline`. Never throws. */
async function promoteTurn<T>(
  transport: McpTransport,
  scope: PatternScope<T>,
  sessionId: string,
  baseline: Map<string, string> | null,
): Promise<void> {
  if (baseline) {
    try {
      const { skipped } = await promoteOutputs(transport, sessionId, baseline)
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

// ============================================================================
// Lazy boot (`lazy: true`) — the sandbox starts on the first sandbox_* call.
// ============================================================================

const IN_VM_TOOL_SET: ReadonlySet<string> = new Set(IN_VM_TOOL_NAMES)

interface LazyLive {
  att: Attachment
  slot: { release(): void }
  baseline: Map<string, string> | null
  /** The skills index the boot produced, rendered into the prompt from then on. */
  index: string | undefined
}

type LazyBoot = { ok: true; live: LazyLive } | { ok: false; failure: SandboxFailure }

interface LazyRun<T> {
  resolveResources: () => SandboxResources
  id: string
  fresh: boolean
  rootfs: RootfsId
  runtime: RuntimeConfig
  scope: PatternScope<T>
  view: EventView
  pattern: ConfiguredPattern<T>
  sessionId: string
  syncWorkspace: boolean
  skills?: SandboxSkillsResolver
}

/**
 * Run `pattern` with an in-VM transport that boots its VM on first use.
 *
 * The transport is registered on the run frame at ENTRY, so the allowlist and the
 * prompt see the `sandbox_*` tools; what is deferred is everything that needs a
 * container engine — scheduler slot, acquire, skills, hydrate, snapshot. That whole
 * sequence is {@link LazyRun}'s `boot`, run at most once per run (concurrent first
 * calls await the same promise) and remembered whether it succeeded or not.
 *
 * A boot that fails never throws into the pattern: the call returns a tool failure
 * whose text is the CLASSIFIED sentence ({@link classifySandboxFailure}); the raw
 * error is logged and goes no further. Whatever had been acquired before the failure
 * is released, so a failed boot holds no slot and no attachment.
 *
 * Exit mirrors eager: promote only if a boot happened and succeeded, then release the
 * attachment and the slot. A run that never booted has nothing to release.
 */
async function runWithLazyIdAttachment<T>(run: LazyRun<T>): Promise<PatternScope<T>> {
  const { scope, view, pattern, sessionId, skills } = run
  let boot: Promise<LazyBoot> | undefined
  let live: LazyLive | undefined

  const doBoot = async (): Promise<LazyBoot> => {
    let slot: { release(): void } | undefined
    let att: Attachment | undefined
    try {
      const { scheduler, attachments } = run.resolveResources()
      slot = await scheduler.allocate(sessionId)
      if (run.fresh) await attachments.destroyById(run.id).catch(() => {})
      att = await attachments.acquire(run.id, run.rootfs, run.runtime)
      const index = await prepareSkills(att.transport, scope, skills)
      const baseline = run.syncWorkspace ? await hydrateAndSnapshot(att, scope, sessionId) : null
      live = { att, slot, baseline, index }
      return { ok: true, live }
    } catch (err) {
      // Raw detail to the server log only; the model gets the fixed sentence.
      console.error(
        `[sandbox] lazy boot failed for session ${sessionId}: ` +
          (err instanceof Error ? err.message : String(err)),
      )
      if (att) run.resolveResources().attachments.release(att)
      slot?.release()
      return { ok: false, failure: classifySandboxFailure(err) }
    }
  }
  const startBoot = (): Promise<LazyBoot> => (boot ??= doBoot())

  const transport: ToolTransport = {
    id: `sandbox:${run.id}`,
    ownsTool: (name) => IN_VM_TOOL_SET.has(name),
    // Always the static table, so the prompt's tool catalog is byte-stable
    // across the boot (a changing catalog would also churn the prompt cache).
    listTools: async () => IN_VM_TOOL_DESCRIPTORS.map((t) => ({ ...t })),
    async callTool(name, args) {
      const booted = await startBoot()
      if (!booted.ok) return { success: false, data: null, error: booted.failure.message }
      return booted.live.att.transport.callTool(name, args)
    },
    // Read per prompt: the pending notice until the boot lands, then the index.
    get promptContext() {
      return live ? live.index : skills ? SKILLS_PENDING_NOTICE : undefined
    },
  }

  const restoring = run.syncWorkspace
    ? restoreAfterStashWrite(
        async () => {
          const booted = await boot
          return booted?.ok ? booted.live.att.transport : undefined
        },
        scope,
        sessionId,
      )
    : undefined

  try {
    return await amendRunFrame(
      { transports: [transport], ...(restoring ? restoring.frame : {}) },
      () => pattern.fn(scope, view),
    )
  } finally {
    // A boot still in flight (the pattern threw mid-call) is awaited, so the
    // release below is of what it actually acquired.
    const booted = boot ? await boot : undefined
    await restoring?.close()
    if (booted?.ok) {
      try {
        await promoteTurn(booted.live.att.transport, scope, sessionId, booted.live.baseline)
      } finally {
        run.resolveResources().attachments.release(booted.live.att)
        booted.live.slot.release()
      }
    }
  }
}
