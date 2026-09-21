/**
 * Pattern Capabilities — static introspection of a pattern graph
 *
 * Pure helpers (no server-only deps) that walk the `children` of a
 * `ConfiguredPattern[]` to answer capability questions about a harness without
 * running it. Wrapping combinators (`chain`, `routes`, `parallel`,
 * `withReferences`) expose their sub-patterns via
 * `ConfiguredPattern.children`; leaves omit it. Execution never reads `children`
 * — it's introspection-only.
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

import type { ConfiguredPattern, PatternConfig } from './types'

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
