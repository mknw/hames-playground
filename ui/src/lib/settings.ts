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
  maxToolTurns: number        // simpleLoop max iterations (default: 5)
  maxRetries: number          // actorCritic max attempts (default: 3)
  maxResultChars: number      // tool result truncation chars (default: 2000)
  maxResultForSummary: number // summarizer input limit chars (default: 3000)
  priorTurnCount: number      // prior turns for tool result memory (default: 3)
  routerTurnWindow: number    // router history window in turns (default: 5)
  sandbox: SandboxSettings    // compute sandbox caps + defaults
}

export const DEFAULT_SETTINGS: HarnessSettings = {
  maxToolTurns: 5,
  maxRetries: 3,
  maxResultChars: 2000,
  maxResultForSummary: 3000,
  priorTurnCount: 3,
  routerTurnWindow: 5,
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

/** Context window limits per BAML client (tokens) */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Groq
  GroqFast: 32_768,              // openai/gpt-oss-20b
  GroqGPT120B: 131_072,          // openai/gpt-oss-120b
  GroqQwen3_32b: 32_768,         // qwen/qwen3-32b
  // OpenRouter
  OpenRouterNemotron120B: 131_072,  // nvidia/nemotron-3-super-120b-a12b
  OpenRouterNemotron3Nano30B: 32_768, // nvidia/nemotron-3-nano-30b-a3b
  OpenRouterGemma4: 131_072,     // google/gemma-4-31b-it
  OpenRouterMiniMax2_5: 1_000_000, // minimax/minimax-m2.5
  // OpenAI
  OpenAIGPT5: 1_000_000,
  OpenAIGPT5Mini: 1_000_000,
  OpenAIGPT5Nano: 1_000_000,
  OpenAIGPT5Chat: 1_000_000,
  // Anthropic
  CustomHaiku: 200_000,
  CustomOpus4: 200_000,
  CustomSonnet4: 200_000,
  AnthropicSonnet5: 1_000_000,
  // Cerebras — separate-quota safety nets at end of each fallback chain
  CerebrasGPT120B: 131_072,        // gpt-oss-120b
  CerebrasZaiGLM4_7: 131_072,      // zai-glm-4.7
  CerebrasQwen3_235B: 131_072,     // qwen-3-235b-a22b-instruct-2507
  // Local (local-client.baml, not used in chains)
  LocalGLM: 16_384,
  // Strategy-level chain clients — the names patterns actually pass to
  // getContextWindow() (via resolveClientForRole). Without these the lookup
  // fell through to the 16_384 default and over-trimmed prompts, dropping real
  // tool results before the LLM saw them (see .harness-logs/neo4j-no-results.json).
  // Anthropic-only chains (dev default) → Sonnet 4.6 / Haiku 4.5, 200K each.
  RouterAnthropic: 200_000,
  ControllerAnthropic: 200_000,
  CriticAnthropic: 200_000,
  SynthesizerAnthropic: 200_000,
  DescribeAnthropic: 200_000,
  // Mixed-provider fallback chains (USE_MIXED_CHAINS=1). Conservative floor =
  // the smallest window any client in the chain can fall back to (32_768), so
  // trimming never overflows a downstream model regardless of which one BAML
  // lands on.
  RouterFallback: 32_768,
  ControllerFallback: 32_768,
  CriticFallback: 32_768,
  SynthesizerFallback: 32_768,
  DescribeFallback: 32_768,
}

/**
 * Configured `max_tokens` per BAML client — MUST mirror `baml_src/clients.baml`.
 *
 * Used by the adapters' truncation detection: a response whose
 * `usage.outputTokens` reaches its client's cap was cut off mid-generation
 * (Anthropic reports exactly the cap on a max_tokens stop). A truncated
 * ControllerAction loses its trailing fields (`status`, `is_final`) or ends
 * mid-`tool_args` → BamlValidationError / invalid tool_args. Detection lets the
 * retry path tell the actor to produce a smaller response instead of blindly
 * regenerating the same oversized one (see `.harness-logs/baml-validation-sandbox.json`).
 *
 * Only clients with an explicit cap in clients.baml are listed; unknown clients
 * are treated as not-detectable (no false positives).
 */
export const CLIENT_MAX_OUTPUT_TOKENS: Record<string, number> = {
  AnthropicSonnet5: 32_768,
  AnthropicSonnet46: 16_384,
  AnthropicHaiku45: 16_384,
  AnthropicOpus4: 4_096,
}

export const SETTINGS_STORAGE_KEY = 'kg_agent_settings'
