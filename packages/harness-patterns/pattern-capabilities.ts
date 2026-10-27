/**
 * Pattern Capabilities — static introspection of a pattern graph
 *
 * Pure helpers (no server-only deps) that walk the `children` of a
 * `ConfiguredPattern[]` to answer capability questions about a harness without
 * running it. Wrapping combinators (`chain`, `routes`, `parallel`,
 * `withReferences`) expose their sub-patterns via
 * `ConfiguredPattern.children`; leaves omit it. Execution never reads `children`
 * — it describes the graph, never a dispatch mechanism. decisionLoop also
 * probes declarations before supplying roster-only child data (#507 G14).
 *
 * What a pattern declares, it declares in `ConfiguredPattern.capabilities`
 * ({@link PatternCapabilities}) — a field core owns and other packages fill in.
 * The probes below therefore read a TYPED field rather than widening
 * `PatternConfig` with a cast: renaming a capability is a compile error in the
 * declaring package and in this one, instead of two casts that keep agreeing
 * with the compiler while silently disagreeing with each other.
 *
 * Consumers: the upload route's auto-ingest gate and the interactive Shell's
 * `/work/in` hydration, both via `harness-client/registry.server.ts`
 * (`agentUsesRedisRetriever` / `agentUsesSyncWorkspace`).
 */

import type {
  ConfiguredPattern,
  ContinuationSegment,
  PatternConfig,
  ResumableCapability,
} from './types'

/** True when a pattern's resolved config is a `retriever` (it stamps
 *  `patternId: 'retriever'`). */
export function isRetrieverConfig(config: PatternConfig): boolean {
  return config.patternId === 'retriever'
}

/** True when a pattern is a retriever wired to the redis/local-vector backend
 *  — `retriever` declares `capabilities.retrievalBackends` (its backend names);
 *  `'redis'` means the local Data Stash vector path. */
function isRedisRetriever<T>(pattern: ConfiguredPattern<T>): boolean {
  if (!isRetrieverConfig(pattern.config)) return false
  return pattern.capabilities?.retrievalBackends?.includes('redis') === true
}

/** True when any pattern in the (nested) graph is a `retriever`. */
export function harnessHasRetriever<T>(patterns: ConfiguredPattern<T>[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false
  return patterns.some((p) => isRetrieverConfig(p.config) || harnessHasRetriever(p.children))
}

/**
 * True when the harness contains a `retriever` wired to the redis/local-vector
 * backend — the gate for auto-ingesting uploaded docs into the local vector
 * store (a Supabase-only retriever reads from Supabase, so it doesn't trigger
 * local ingest).
 */
export function harnessHasRedisRetriever<T>(patterns: ConfiguredPattern<T>[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false
  return patterns.some((p) => isRedisRetriever(p) || harnessHasRedisRetriever(p.children))
}

/** True when a pattern declares the durable-workspace capability — the one a
 *  sandbox wrapper declares when it will actually hydrate on entry and promote
 *  on exit. It rides the wrapper's own `capabilities`, never the wrapped
 *  pattern's `config`, so the wrapper stays config-transparent. */
export function declaresWorkspaceSync<T>(pattern: ConfiguredPattern<T>): boolean {
  return pattern.capabilities?.workspaceSync === true
}

/**
 * True when any pattern in the (nested) graph declares a durable workspace.
 * The interactive Shell uses this (via `agentUsesSyncWorkspace`) to decide
 * whether to hydrate `/work/in` when it is the first to boot the session
 * container (#97 Gap 3).
 */
export function harnessUsesSyncWorkspace<T>(patterns: ConfiguredPattern<T>[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false
  return patterns.some((p) => declaresWorkspaceSync(p) || harnessUsesSyncWorkspace(p.children))
}

/** Decision keys declared anywhere in the nested pattern graph. */
export function harnessDecisionKeys<T>(patterns: ConfiguredPattern<T>[] | undefined): string[] {
  if (!patterns || patterns.length === 0) return []
  const keys: string[] = []
  const seen = new Set<string>()
  for (const pattern of patterns) {
    for (const key of pattern.capabilities?.decisionKeys ?? []) {
      if (seen.has(key)) continue
      seen.add(key)
      keys.push(key)
    }
    for (const key of harnessDecisionKeys(pattern.children)) {
      if (seen.has(key)) continue
      seen.add(key)
      keys.push(key)
    }
  }
  return keys
}

/**
 * True when any pattern in the (nested) graph declared the memory capability
 * (#419) — the ONE opt-in probe. A host gates two things on it: starting the
 * joint memory wake before the chain's first pattern (an agent that never opted
 * in must not spend GPU seconds waking the memory boxes) and the post-reply
 * store. `memoryRecall` declares it; `withMemory` prepends `memoryRecall`, so
 * wrapping an agent in memory is what opts it in.
 */
export function harnessUsesMemory<T>(patterns: ConfiguredPattern<T>[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false
  return patterns.some((p) => p.capabilities?.memory === true || harnessUsesMemory(p.children))
}

/** Whether a route consumes the roster-only input before its inner pattern. */
export function harnessPseudonymisesInputs<T>(
  patterns: ConfiguredPattern<T>[] | undefined,
): boolean {
  return (
    patterns?.some(
      (p) => p.capabilities?.pseudonymisedInputs === true || harnessPseudonymisesInputs(p.children),
    ) ?? false
  )
}

/**
 * A pattern's OWN resumable capability (slice 6). Most wrappers build
 * themselves by spreading the pattern they wrap, which copies its
 * `capabilities` — `resumable` included — onto a wrapper that implements none
 * of it. A capability that is the very object one of its children declares was
 * copied that way, and counts as absent: such a wrapper is not resumable, and
 * a path through it is not either.
 */
export function ownResumable<T>(pattern: ConfiguredPattern<T>): ResumableCapability | undefined {
  const capability = pattern.capabilities?.resumable
  if (!capability) return undefined
  return pattern.children?.some((c) => c.capabilities?.resumable === capability)
    ? undefined
    : capability
}

/**
 * Does a recorded continuation still lead from `top` to a gate (resume inside a
 * route, slice 6)? Each segment must match its pattern's own fingerprint, each
 * next pattern must be a DIRECT child of the one before it, and the path must
 * end at a pattern that raises or dispatches the gate itself. `checkResume`
 * refuses anything else as `chain-changed`, before any `resolve`.
 */
export function followContinuation<T>(
  top: ConfiguredPattern<T>,
  continuation: readonly ContinuationSegment[],
): boolean {
  let node: ConfiguredPattern<T> | undefined = top
  for (let i = 0; i < continuation.length; i++) {
    const segment = continuation[i]
    const capability: ResumableCapability | undefined = node ? ownResumable(node) : undefined
    if (!node || !capability || capability.fingerprint !== segment.fingerprint) return false
    const last = i === continuation.length - 1
    if (last) return capability.next === undefined
    const next: ConfiguredPattern<T> | undefined = capability.next?.(segment)
    if (!next || !node.children?.includes(next)) return false
    node = next
  }
  return false
}

/**
 * Refuse, at construction, a gated tool name (`capabilities.gatedTools`, slice
 * 6) offered anywhere a pause could not be resumed inside the run: in any
 * allowlist whose path from the root is not resumable all the way down, or in
 * one that is not where the gate is dispatched (a loop that does not record its
 * history declares no `resumable`, so it is refused here too). A walk of
 * `children` cannot see an `askHuman` inside a tool executor, so the check
 * matches allowlist NAMES (`capabilities.tools`). `inherited` is what the
 * caller already declares gated above `patterns`.
 */
export function refuseUnresumableGates<T>(
  patterns: readonly ConfiguredPattern<T>[] | undefined,
  inherited: readonly string[] = [],
): void {
  const walk = (
    pattern: ConfiguredPattern<T>,
    gated: ReadonlySet<string>,
    blocker: string | undefined,
  ): void => {
    const capability = ownResumable(pattern)
    const here = new Set([...gated, ...(pattern.capabilities?.gatedTools ?? [])])
    const stop = blocker ?? (capability ? undefined : pattern.name)
    // Only the allowlist this pattern dispatches from: a wrapper that spread
    // its inner pattern carries the inner list by reference, and is not where
    // the call is made.
    const tools = pattern.capabilities?.tools
    const own = tools && !pattern.children?.some((c) => c.capabilities?.tools === tools)
    const offered = own ? tools.filter((name) => here.has(name)) : []
    if (offered.length > 0 && (stop !== undefined || capability?.next !== undefined)) {
      throw new Error(
        `'${offered[0]}' may pause for a person (it is a gated tool), but '${pattern.name}' offers it ` +
          `on a path that cannot be resumed inside a run${stop ? ` ('${stop}' is not resumable)` : ''}. ` +
          'Offer a gated tool only from a simpleLoop that records its history, under resumable patterns all the way from the root.',
      )
    }
    for (const child of pattern.children ?? []) walk(child, here, stop)
  }
  for (const pattern of patterns ?? []) walk(pattern, new Set(inherited), undefined)
}
