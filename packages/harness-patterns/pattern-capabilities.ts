/**
 * Pattern Capabilities — static introspection of a pattern graph
 *
 * Pure helpers (no server-only deps) that walk the `children` of a
 * `ConfiguredPattern[]` to answer capability questions about a harness without
 * running it. Wrapping combinators (`chain`, `routes`, `parallel`, `guardrail`,
 * `hook`, `withReferences`) expose their sub-patterns via
 * `ConfiguredPattern.children`; leaves omit it. Execution never reads `children`
 * — it's introspection-only.
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

/** True when a retriever config is wired to the redis/local-vector backend —
 *  the `retriever` stamps `backendKinds: string[]` (backend names) onto its
 *  resolved config; `'redis'` means the local Data Stash vector path. */
function isRedisRetrieverConfig(config: PatternConfig): boolean {
  if (!isRetrieverConfig(config)) return false
  const kinds = (config as PatternConfig & { backendKinds?: string[] }).backendKinds
  return Array.isArray(kinds) && kinds.includes('redis')
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
  return patterns.some(
    (p) => isRedisRetrieverConfig(p.config) || harnessHasRedisRetriever(p.children),
  )
}

/** True when a pattern's resolved config carries the durable-workspace marker
 *  that `withSandbox({ id, syncWorkspace: true })` stamps. The marker rides on
 *  the wrapped pattern's config (the wrapper is not a leaf factory), so read it
 *  via a widening cast like the retriever's `backendKinds`. */
export function isSyncWorkspaceConfig(config: PatternConfig): boolean {
  return (
    (config as PatternConfig & { sandboxSyncWorkspace?: boolean }).sandboxSyncWorkspace === true
  )
}

/**
 * True when any pattern in the (nested) graph is a durable-workspace sandbox
 * wrapper. The interactive Shell uses this (via `agentUsesSyncWorkspace`) to
 * decide whether to hydrate `/work/in` when it is the first to boot the
 * session container (#97 Gap 3).
 */
export function harnessUsesSyncWorkspace<T>(patterns: ConfiguredPattern<T>[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false
  return patterns.some(
    (p) => isSyncWorkspaceConfig(p.config) || harnessUsesSyncWorkspace(p.children),
  )
}
