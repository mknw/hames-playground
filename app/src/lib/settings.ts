/**
 * Shared settings types and defaults.
 *
 * Safe to import from both client and server — contains only types and plain constants.
 */

/**
 * Sandbox compute settings. See docs/plan/sandbox.md → "Settings".
 *
 * Process-scoped values (`globalCap`, `perSessionCap`, `warmPool`, `idleEvictMs`)
 * are read once when the harness lazily constructs its singleton scheduler
 * and pool; per-call defaults (`defaultTimeoutSec`, `defaultMemoryMB`,
 * `defaultEgress`) are read each time `withSandbox` boots a VM whose caller
 * didn't override them. The settings panel UI does not currently surface
 * these — they're programmatic for v0.
 */
export interface SandboxSettings {
  /** Max concurrent sandbox attachments across the harness. */
  globalCap: number
  /** Max concurrent sandbox attachments per session. */
  perSessionCap: number
  /** Hard ceiling on parked (at-rest) attachments in the AttachmentTable. When
   *  a new boot would exceed it, the least-recently-used idle attachment is
   *  evicted. Bounds at-rest VMs regardless of idleness; `globalCap` only
   *  bounds in-flight allocations. */
  maxAttachments: number
  /** Per-rootfs warm-pool depth. e.g. `{ base: 1 }`. */
  warmPool: Partial<Record<string, number>>
  /** Idle time before a pooled VM is destroyed (ms). */
  idleEvictMs: number
  /** Per-tool-call wall-clock cap when caller does not override. */
  defaultTimeoutSec: number
  /** Per-VM memory cap (MB) when caller does not override. */
  defaultMemoryMB: number
  /** Default egress profile when caller does not override. */
  defaultEgress: 'mcp-only' | 'pypi' | 'github-trusted' | 'open'
}

export interface HarnessSettings {
  maxToolTurns: number // simpleLoop max iterations (default: 5)
  maxRetries: number // actorCritic max attempts (default: 3)
  maxResultChars: number // tool result truncation chars (default: 8000)
  maxResultForSummary: number // summarizer input limit chars (default: 3000)
  priorTurnCount: number // prior turns for tool result memory (default: 3)
  routerTurnWindow: number // router history window in turns (default: 5)
  /**
   * How many conversations may stream at once (#105). Client-side policy —
   * the server places no such limit, so this rides along in the settings
   * payload without being read there. At the cap, a send into an *idle*
   * conversation is refused rather than queued or allowed to interrupt.
   */
  maxConcurrentRuns: number // concurrent streaming conversations (default: 3)
  sandbox: SandboxSettings // compute sandbox caps + defaults
}

export const DEFAULT_SETTINGS: HarnessSettings = {
  maxToolTurns: 5,
  maxRetries: 3,
  // Raised 2000 → 8000 (2026-07-30): at 2000 a 14-hit Graph search showed ~3
  // hits and the controller re-queried for data it already had (its own
  // reasoning: "only 3 were shown before truncation"). 8000 ≈ 2k tokens —
  // trivial against 200k windows and cache-absorbed on the Anthropic chains;
  // trimToFit still bounds the aggregate turn log on small-window chains.
  maxResultChars: 8000,
  maxResultForSummary: 3000,
  priorTurnCount: 3,
  routerTurnWindow: 5,
  maxConcurrentRuns: 3,
  sandbox: {
    globalCap: 16,
    perSessionCap: 4,
    // At-rest ceiling on the attachment table (#82). 8 = 2× perSessionCap, so a
    // handful of persistent-flavour sessions can coexist while a runaway
    // accumulation of parked VMs is capped even if the idle sweep hasn't fired.
    maxAttachments: 8,
    warmPool: { base: 1, 'image-processing': 1, data: 1, office: 1 },
    // Hot-cache window only: a parked VM is reused instantly within this window.
    // Durable workspace state lives in the document store (hydrated into /work on
    // first boot, promoted from /work/out on exit), so this need not be long — 1h.
    idleEvictMs: 3_600_000,
    defaultTimeoutSec: 60,
    defaultMemoryMB: 512,
    defaultEgress: 'mcp-only',
  },
}

/**
 * Server-side bounds for every client-settable knob — the SettingsPanel's own
 * slider `min`/`max`, restated where they can be enforced.
 *
 * `SettingsPanel.tsx` is the only legitimate producer of a settings payload and
 * it already cannot go outside these, so clamping to them changes nothing for a
 * real caller. Keep the two in step: a widened slider needs its bound widened
 * here or the panel's top end silently stops taking effect.
 */
const SETTINGS_BOUNDS = {
  maxToolTurns: [1, 15],
  maxRetries: [1, 10],
  maxResultChars: [500, 10_000],
  maxResultForSummary: [500, 10_000],
  priorTurnCount: [1, 10],
  routerTurnWindow: [1, 20],
  maxConcurrentRuns: [1, 10],
} as const satisfies Record<Exclude<keyof HarnessSettings, 'sandbox'>, readonly [number, number]>

function clampSetting(
  key: keyof typeof SETTINGS_BOUNDS,
  value: unknown,
): HarnessSettings[typeof key] {
  const fallback = DEFAULT_SETTINGS[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const [min, max] = SETTINGS_BOUNDS[key]
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * Reduce a settings payload that arrived over the wire to what a caller is
 * allowed to choose.
 *
 * `POST /api/events` reads `settings` straight off the request body and hands it
 * to `runWithSettings`, from where every pattern reads it at execution time — so
 * an unvalidated payload is a browser-controlled loop bound, not a preference.
 * `maxToolTurns` is the sharpest: it is the number of controller round-trips one
 * request may spend on the shared Anthropic key (`simpleLoop.server.ts`:
 * `config?.maxTurns ?? settings.maxToolTurns`), and the default `search` agent
 * pins `maxTurns` on neither of its loops.
 *
 * Two rules, and the second is the load-bearing one:
 *
 *  - **Numbers are clamped** to {@link SETTINGS_BOUNDS}, and a non-number falls
 *    back to its default rather than propagating `NaN`/`undefined` into a loop
 *    bound.
 *  - **`sandbox` is dropped outright.** It is host policy, not a preference: the
 *    panel does not surface it, and `defaultEgress` is what decides whether a
 *    container boots with `--network none` or on the default bridge with
 *    unrestricted outbound (`docker-backend.server.ts`, `runContainer`), while
 *    `defaultMemoryMB` / `defaultTimeoutSec` size and time-bound containers on
 *    the shared host (`with-sandbox.server.ts`). Every agent pins
 *    `egress: 'mcp-only'` at its own call site today, so the egress half is
 *    currently unreachable — this keeps it unreachable by construction rather
 *    than by the diligence of the next `withSandbox` caller.
 *
 * Returns `undefined` for an absent/non-object payload, which is what
 * `runWithSettings` already reads as "use the defaults".
 */
export function sanitizeHarnessSettings(input: unknown): HarnessSettings | undefined {
  if (input === null || typeof input !== 'object') return undefined
  const raw = input as Record<string, unknown>
  return {
    maxToolTurns: clampSetting('maxToolTurns', raw.maxToolTurns),
    maxRetries: clampSetting('maxRetries', raw.maxRetries),
    maxResultChars: clampSetting('maxResultChars', raw.maxResultChars),
    maxResultForSummary: clampSetting('maxResultForSummary', raw.maxResultForSummary),
    priorTurnCount: clampSetting('priorTurnCount', raw.priorTurnCount),
    routerTurnWindow: clampSetting('routerTurnWindow', raw.routerTurnWindow),
    maxConcurrentRuns: clampSetting('maxConcurrentRuns', raw.maxConcurrentRuns),
    sandbox: DEFAULT_SETTINGS.sandbox,
  }
}

/** Context window limits per BAML client (tokens) */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic
  CustomHaiku: 200_000,
  CustomOpus4: 200_000,
  CustomSonnet4: 200_000,
  AnthropicSonnet5: 1_000_000,
  AnthropicSonnet5NoThink: 1_000_000, // #139
  // Local (local-client.baml, not used in chains)
  LocalGLM: 16_384,
  // = the `--ctx-size` `make llm-small` serves it with; keep the two in step.
  LocalQwenSmall: 32_768,
  // Self-hosted (verda-client.baml) — vLLM was started with
  // `--max-model-len 131072`, so this is the server's hard ceiling on
  // prompt + completion, not a model-family marketing number. An earlier plan
  // for this client said 250k; the deployment says 131072 and the deployment
  // wins. Reached through resolveClientForRole() while USE_VERDA_INFERENCE=1.
  VerdaQwen: 131_072,
  // Strategy-level chain clients — the names patterns actually pass to
  // getContextWindow() (via resolveClientForRole). Without these the lookup
  // fell through to the 16_384 default and over-trimmed prompts, dropping real
  // tool results before the LLM saw them (see .harness-logs/neo4j-no-results.json).
  // The Anthropic chains → Sonnet 5 / Sonnet 4.6 / Haiku 4.5, 200K each.
  RouterAnthropic: 200_000,
  ControllerAnthropic: 200_000,
  ActorAnthropic: 200_000, // #139 — actor chain, split from ControllerAnthropic
  PlannerAnthropic: 200_000, // #27 — planner chain (thinking ON)
  CriticAnthropic: 200_000,
  SynthesizerAnthropic: 200_000,
  DescribeAnthropic: 200_000,
}

/**
 * Configured `max_tokens` per BAML client — MUST mirror `baml_src/*.baml`.
 *
 * Used by the adapters' truncation detection: a response whose
 * `usage.outputTokens` reaches its client's cap was cut off mid-generation
 * (providers report exactly the cap on a max_tokens/length stop). A truncated
 * ControllerAction loses its trailing fields (`status`, `is_final`) or ends
 * mid-`tool_args` → BamlValidationError / invalid tool_args. Detection lets the
 * retry path tell the actor to produce a smaller response instead of blindly
 * regenerating the same oversized one (see `.harness-logs/baml-validation-sandbox.json`).
 *
 * COMPLETENESS INVARIANT (SA-C2): every leaf client declaring `max_tokens` in
 * `baml_src/*.baml` must be listed here at the same value —
 * `client-output-caps.test.ts` parses the .baml sources and asserts it. A
 * missing entry does not error; it silently blinds truncation detection for
 * that client, which is how seven now-removed Groq/OpenRouter leaves skipped
 * the corrective retry for months. A client declaring no `max_tokens` at all
 * is deliberately absent rather than guessed at: an unknown client is treated
 * as not-detectable, never as a false positive.
 */
export const CLIENT_MAX_OUTPUT_TOKENS: Record<string, number> = {
  AnthropicSonnet5: 32_768,
  AnthropicSonnet46: 16_384,
  // #139 thinking-disabled twins — same models, so same caps. Missing entries
  // here would make llmCallHitOutputCap() blind and silently disable the
  // truncation retry for the controller.
  AnthropicSonnet5NoThink: 32_768,
  AnthropicSonnet46NoThink: 16_384,
  AnthropicHaiku45: 16_384,
  AnthropicOpus4: 4_096,
  // Local (local-client.baml — manual wiring only, not in any chain).
  LocalGLM: 2_048,
  LocalQwenSmall: 2_048,
  // Self-hosted (verda-client.baml). Mirrors the `max_tokens` declared there;
  // without this entry the truncation retry is blind on every Verda-routed
  // controller turn, which is the failure this map exists for.
  VerdaQwen: 16_384,
  // Strategy-chain FLOORS — the smallest cap of any leaf in the chain, the
  // same conservative-floor pattern as the chain entries in
  // MODEL_CONTEXT_WINDOWS above. Truncation detection never consults these
  // (it sees leaf names); they exist for OUTPUT-side budgeting keyed by
  // resolveClientForRole(), which returns chain names — compactBulkData
  // derives its describe batch size here (SA-M6).
  DescribeAnthropic: 16_384, // = AnthropicHaiku45, the chain's only leaf
}

// ============================================================================
// LLM pricing (#122 / #132 — token & cost metrics)
// ============================================================================

/**
 * $ per MTok per BAML client. A client with no entry reads as cost "unknown"
 * rather than silently wrong, so a newly added one must be listed here.
 *
 * AnthropicSonnet5 uses the INTRO pricing in force through 2026-08-31
 * (standard: 3.00 / 15.00) — update after.
 *
 * `VerdaQwen` is deliberately ABSENT: the self-hosted deployment is billed by
 * the second the GPU is awake, not by the token, so any per-token rate here
 * would be invented — and a `0` would render as "this call was free" on a box
 * that is being paid for while it answers. "Unknown" is the honest reading.
 */
export const CLIENT_PRICING: Record<string, { inPerMTok: number; outPerMTok: number }> = {
  AnthropicSonnet5: { inPerMTok: 2.0, outPerMTok: 10.0 },
  AnthropicSonnet46: { inPerMTok: 3.0, outPerMTok: 15.0 },
  // #139 thinking-disabled twins — identical models, identical rates.
  AnthropicSonnet5NoThink: { inPerMTok: 2.0, outPerMTok: 10.0 },
  AnthropicSonnet46NoThink: { inPerMTok: 3.0, outPerMTok: 15.0 },
  AnthropicHaiku45: { inPerMTok: 1.0, outPerMTok: 5.0 },
  AnthropicOpus4: { inPerMTok: 15.0, outPerMTok: 75.0 },
}

/** Anthropic cache pricing multipliers on the base input rate. */
export const CACHE_WRITE_MULT = 1.25
export const CACHE_READ_MULT = 0.1

/** Cost of one call given its token buckets, at `clientName`'s rates.
 *  Returns undefined for clients without a pricing entry. `noCacheUsd` is the
 *  same tokens priced as if nothing were cached — the savings baseline. */
export function estimateLlmCostUsd(
  tokens: {
    inputUncachedTokens: number
    inputCacheReadTokens: number
    inputCacheWriteTokens: number
    outputTokens: number
  },
  clientName?: string,
):
  | { costUsd: number; noCacheUsd: number; rates: { inPerMTok: number; outPerMTok: number } }
  | undefined {
  const rates = clientName ? CLIENT_PRICING[clientName] : undefined
  if (!rates) return undefined
  const inUsd =
    (tokens.inputUncachedTokens +
      tokens.inputCacheWriteTokens * CACHE_WRITE_MULT +
      tokens.inputCacheReadTokens * CACHE_READ_MULT) *
    rates.inPerMTok
  const allIn =
    tokens.inputUncachedTokens + tokens.inputCacheWriteTokens + tokens.inputCacheReadTokens
  return {
    costUsd: (inUsd + tokens.outputTokens * rates.outPerMTok) / 1_000_000,
    noCacheUsd: (allIn * rates.inPerMTok + tokens.outputTokens * rates.outPerMTok) / 1_000_000,
    rates,
  }
}

export const SETTINGS_STORAGE_KEY = 'kg_agent_settings'
