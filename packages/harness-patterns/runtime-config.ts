/**
 * HarnessRuntimeConfig — the library-owned runtime settings (client-safe).
 *
 * The pattern library asks the environment it runs in for its loop budgets and
 * truncation limits at execution time (via `runtimeConfig()`, the ALS reader in
 * `runtime-config.server.ts`) instead of importing them from a host app — a
 * consumer's installed tarball cannot resolve app code. This file carries the
 * TYPE, the BOUNDS and the DEFAULTS; it must stay importable from the client,
 * so it imports nothing from `node:*`. The AsyncLocalStorage scope that makes
 * those readers request-scoped lives in `runtime-config.server.ts`.
 *
 * A host app extends this shape with its own settings (the app's
 * `HarnessSettings` adds `maxConcurrentRuns` and `sandbox`) and opens this
 * scope with its full settings object, overriding these defaults. The defaults
 * live HERE — the library is what ships working out of the box; the app's
 * values below were lifted verbatim from its former `DEFAULT_SETTINGS` so the
 * move changed no behaviour.
 */

export interface HarnessRuntimeConfig {
  /** simpleLoop round budget for a loop that declares no `maxTurns` of its own.
   *  A pattern that DOES declare one wins — see {@link resolveTurnBudget}, the
   *  only place either value is read. */
  maxToolTurns: number;
  /** actorCritic max attempts. */
  maxRetries: number;
  /** Tool result truncation chars. */
  maxResultChars: number;
  /** Summarizer input limit chars. */
  maxResultForSummary: number;
  /** Prior turns for tool result memory. */
  priorTurnCount: number;
  /** Router history window in turns. */
  routerTurnWindow: number;
}

/**
 * Server-side bounds for the runtime knobs — the ceiling/floor
 * {@link resolveTurnBudget} clamps a pattern's own declaration against.
 *
 * The clamp is load-bearing rather than hygiene: a host app derives the longest
 * turn it can legitimately run from these ceilings for its stuck-run reaper, so
 * an agent pinning `maxTurns: 40` must not raise that threshold as a side
 * effect — raising a budget past the ceiling is a deliberate edit to THIS
 * table, never a config value. A host app restates these bounds alongside its
 * own extra settings rather than duplicating the numbers.
 */
export const RUNTIME_CONFIG_BOUNDS = {
  maxToolTurns: [1, 15],
  maxRetries: [1, 10],
  maxResultChars: [500, 10_000],
  maxResultForSummary: [500, 10_000],
  priorTurnCount: [1, 10],
  routerTurnWindow: [1, 20],
} as const satisfies Record<
  keyof HarnessRuntimeConfig,
  readonly [number, number]
>;

export const DEFAULT_RUNTIME_CONFIG: HarnessRuntimeConfig = {
  // maxToolTurns raised 5 → 8 (#269, 2026-08-27). 5 was the value no tuned
  // agent kept: both agents that hand a model more than one namespace pinned 8
  // at their own call site, so the fallback only ever bound the loops nobody
  // had measured yet — including the DEFAULT `search` agent, which pins
  // `maxTurns` on neither of its loops.
  maxToolTurns: 8,
  maxRetries: 3,
  // maxResultChars raised 2000 → 8000 (2026-07-30): at 2000 a 14-hit Graph
  // search showed ~3 hits and the controller re-queried for data it already
  // had. 8000 ≈ 2k tokens — trivial against 200k windows.
  maxResultChars: 8000,
  maxResultForSummary: 3000,
  priorTurnCount: 3,
  routerTurnWindow: 5,
};

/**
 * Resolve the round budget one loop pattern may spend this turn — the ONE place
 * `maxTurns` / `maxRetries` are read, so the loop body, the progress bar's
 * denominator (`estimateTurns`) and the exhaustion event cannot disagree about
 * how many rounds the loop had.
 *
 * Two rules, in this order:
 *
 *  - **A pattern's own declaration wins over the runtime config** (`declared ??
 *    fromConfig`), in both directions. A loop that pins a SMALL budget means
 *    it, and a user's setting does not get to widen it; a loop that pins a
 *    large one keeps it when the setting sits at the default.
 *
 *  - **The declaration is clamped to {@link RUNTIME_CONFIG_BOUNDS}**, which a
 *    call-site literal otherwise bypasses entirely — see the bounds comment for
 *    why this is not optional hygiene.
 */
export function resolveTurnBudget(
  key: "maxToolTurns" | "maxRetries",
  declared: number | undefined,
  fromConfig: number,
): number {
  const fallback = DEFAULT_RUNTIME_CONFIG[key];
  const value = declared ?? fromConfig;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const [min, max] = RUNTIME_CONFIG_BOUNDS[key];
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
