/**
 * BAML Adapters - Server Only
 *
 * Adapters that bridge the pattern's expected function signatures
 * with the new generic BAML functions.
 *
 * The new BAML has generic functions:
 * - LoopController(user_message, intent, tools, turns, context?)
 * - ActorController(user_message, intent, tools, attempts)
 * - Critic(intent, attempts)
 * - Router(message, routes, history)
 * - Synthesize(user_message, intent, turns)
 *
 * The patterns expect:
 * - ControllerFn(user_message, intent, previous_results, n_turn, ...extra)
 * - CriticFn(intent, previous_attempts)
 */

import { assertServerOnImport } from './assert.server'
import type {
  ControllerAction,
  CriticResult,
  ScriptExecutionEvent,
  LLMCallData,
  EventMetrics,
  ReturnStyle,
} from './types'
import type {
  ToolDescription,
  LoopTurn,
  Attempt,
  PriorResult,
  FewShot,
  PlanResult,
} from '../../../baml_client/types'
import type { InjectionScreen } from './injection-guard'
import { listTools as mcpListTools } from './mcp-client.server'
import { getActiveSandbox } from '../sandbox/scope.server'
import { Collector, BamlValidationError } from '@boundaryml/baml'
import { getBamlFiles } from '../../../baml_client/inlinedbaml'
import { clientOverrideFor } from './clients.server'
import { CLIENT_MAX_OUTPUT_TOKENS, estimateLlmCostUsd } from '../settings'
import { coerceControllerActionText } from './controller-action'
import { runBamlClientCheckOnce } from './baml-version-check.server'

assertServerOnImport()

// Boot-time staleness warning (#154), fired once per process from the first
// module every BAML path goes through — the same lazy one-shot seam the
// sandbox orphan reaper uses (#97). Fire-and-forget; never blocks.
runBamlClientCheckOnce()

// ============================================================================
// Types for LLM Call Results
// ============================================================================

/** Result from a controller call with optional LLM observability data */
export interface ControllerCallResult {
  action: ControllerAction
  llmCall?: LLMCallData
}

/** Result from a critic call with optional LLM observability data */
export interface CriticCallResult {
  result: CriticResult
  llmCall?: LLMCallData
}

/** Result from a planner call with optional LLM observability data */
export interface PlanCallResult {
  plan: PlanResult
  llmCall?: LLMCallData
  /** How many tool descriptions the model was ACTUALLY shown — the resolved
   *  catalog (an active sandbox scope's in-VM tools + the gateway tools that
   *  resolved), not the raw name list the factory was handed. The pattern
   *  records this on `plan_created.toolCount`, which documents itself as
   *  "number of tools the planner was shown". */
  toolCount: number
}

/** Controller function that returns action + observability data.
 *
 *  `planContext` is LAST and optional on purpose (#27): the generated BAML
 *  functions take their arguments POSITIONALLY, so inserting a parameter
 *  anywhere but the end silently shifts every later argument — the failure
 *  mode `warnIfCollectorEmpty` exists to catch (#154). */
export type ControllerFnWithLLMData = (
  user_message: string,
  intent: string,
  previous_results: string,
  n_turn: number,
  schema?: string,
  collector?: Collector,
  priorResults?: PriorResult[],
  fewShots?: FewShot[],
  multiCallMode?: 'parallel' | 'sequential',
  planContext?: string,
  /** Terminal-action style (#149), from `SimpleLoopConfig.returnStyle`.
   *  Trailing + optional for the positional-args reason spelled out below. */
  returnStyle?: ReturnStyle,
) => Promise<ControllerCallResult>

/** Critic function that returns result + observability data */
export type CriticFnWithLLMData = (
  intent: string,
  previous_attempts: ScriptExecutionEvent[],
  collector?: Collector,
) => Promise<CriticCallResult>

/**
 * Loud signal that a BAML call captured NOTHING despite being handed a
 * collector — `collector.last` is still null after the call returned.
 *
 * This is a proven data-loss signal and never a normal state on a call that
 * succeeded: BAML populates the collector for every request it actually issues,
 * so a null `last` means the collector never reached BAML at all. The known
 * cause is a STALE `baml_client/` (it is git-ignored and generated). The
 * generated functions take their arguments POSITIONALLY, so appending a
 * parameter to a BAML function signature and then running new adapter code
 * against an old client shifts every later argument by one slot and pushes the
 * `__baml_options__` object — which carries both the collector and the
 * `clientOverrideFor(...)` routing — off the end. The calls still succeed, so
 * nothing in the logs or the UI hints at it: issue #154 lost ~18 hours of
 * prompt/output/metrics/cost data exactly this way before anyone noticed.
 *
 * Remedy when this fires: `pnpm baml-generate`.
 *
 * Call this on SUCCESS paths only. After a thrown call the collector may
 * legitimately be empty (e.g. a pre-request network failure), which is why
 * `extractFailureLLMCallData` deliberately stays silent.
 *
 * @returns true when a warning was emitted (i.e. observability data was lost).
 */
export function warnIfCollectorEmpty(
  collector: Collector | undefined,
  functionName: string,
): boolean {
  if (!collector || collector.last) return false
  console.warn(
    `[baml] ${functionName} was called WITH a collector but captured nothing ` +
      '(collector.last === null): no prompt, output, metrics or cost for this step. ' +
      'This is a data-loss signal, never a normal state — the usual cause is a stale ' +
      'baml_client after a BAML signature change (#154). Run `pnpm baml-generate`.',
  )
  return true
}

/** Extract LLM call data from a collector */
export function extractLLMCallData(
  collector: Collector,
  functionName: string,
  variables: Record<string, unknown>,
  startTime: number,
  parsedOutput?: unknown,
): LLMCallData | undefined {
  const last = collector.last
  if (!last) {
    // Not a benign miss — see warnIfCollectorEmpty. This is the shared choke
    // point for LoopController / ActorController / Critic / Router /
    // RetrieveQuery / CompactIntent; the sites that build their own
    // LLMCallData call the helper directly.
    warnIfCollectorEmpty(collector, functionName)
    return undefined
  }
  const llmCall = buildLLMCallDataFromLog(last, functionName, variables, startTime, parsedOutput)
  llmCall.metrics = computeEventMetrics(collector)
  return llmCall
}

/** Build LLMCallData from a collector log entry. Used for both success and
 *  failure paths — on failure `parsedOutput` is omitted, `rawOutput` may be
 *  empty, and `usage` may be absent, but `promptTemplate`/`variables` are
 *  always populated so the failed-call drill-down has something to render. */
/** Shape of a collector call as this module reads it (native class, so all
 *  property access is via getters — hence the loose cast). */
type CollectorCall = {
  selected?: boolean
  provider?: string
  clientName?: string
  httpRequest?: { body?: unknown }
  httpResponse?: { body?: { json?: () => unknown } } | null
  usage?: {
    inputTokens?: number | null
    outputTokens?: number | null
    cachedInputTokens?: number | null
  } | null
}

/** Provider-side usage from a call's raw HTTP response. Needed because the
 *  Collector's Usage has no cache-WRITE bucket (only read); Anthropic reports
 *  `cache_creation_input_tokens` only in the response body. Best-effort. */
function usageFromResponse(call: CollectorCall | undefined):
  | {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  | undefined {
  try {
    const json = call?.httpResponse?.body?.json?.() as
      | {
          usage?: {
            input_tokens?: number
            output_tokens?: number
            cache_read_input_tokens?: number
            cache_creation_input_tokens?: number
          }
        }
      | undefined
    return json?.usage
  } catch {
    return undefined // absent/malformed body (e.g. stream call, network failure)
  }
}

/** One call's token buckets: raw response usage first (has the cache-write
 *  bucket), Collector usage as fallback (write reads as 0). Undefined when
 *  the call never produced usage (pre-flight failures). */
function callTokenBuckets(call: CollectorCall | undefined):
  | {
      inputUncachedTokens: number
      inputCacheReadTokens: number
      inputCacheWriteTokens: number
      outputTokens: number
    }
  | undefined {
  const raw = usageFromResponse(call)
  if (raw && (raw.input_tokens != null || raw.output_tokens != null)) {
    return {
      inputUncachedTokens: raw.input_tokens ?? 0,
      inputCacheReadTokens: raw.cache_read_input_tokens ?? 0,
      inputCacheWriteTokens: raw.cache_creation_input_tokens ?? 0,
      outputTokens: raw.output_tokens ?? 0,
    }
  }
  const u = call?.usage
  if (!u || (u.inputTokens == null && u.outputTokens == null)) return undefined
  return {
    inputUncachedTokens: u.inputTokens ?? 0,
    inputCacheReadTokens: u.cachedInputTokens ?? 0,
    inputCacheWriteTokens: 0,
    outputTokens: u.outputTokens ?? 0,
  }
}

/** Step-level accounting (#122): sum token buckets and cost across EVERY
 *  call in the collector — all BAML invocations (truncation retry, manual
 *  Groq escalation re-invoke) and all attempts within each (client fallback,
 *  retry policies). One collector == one harness step by construction (the
 *  loops create a fresh Collector per turn/attempt), so this is the step's
 *  true bill; `llmCall.usage` remains the selected exchange only.
 *  Cost is omitted (not zeroed) when any token-bearing attempt has no
 *  pricing entry — unknown beats silently wrong. */
export function computeEventMetrics(collector: Collector | undefined): EventMetrics | undefined {
  if (!collector) return undefined
  const totals = {
    inputUncachedTokens: 0,
    inputCacheReadTokens: 0,
    inputCacheWriteTokens: 0,
    outputTokens: 0,
  }
  let attempts = 0
  let costUsd = 0
  let noCacheUsd = 0
  let costKnown = true
  let rates: { inPerMTok: number; outPerMTok: number } | undefined
  for (const log of collector.logs ?? []) {
    for (const call of (log.calls ?? []) as CollectorCall[]) {
      const buckets = callTokenBuckets(call)
      if (!buckets) continue
      attempts++
      totals.inputUncachedTokens += buckets.inputUncachedTokens
      totals.inputCacheReadTokens += buckets.inputCacheReadTokens
      totals.inputCacheWriteTokens += buckets.inputCacheWriteTokens
      totals.outputTokens += buckets.outputTokens
      const est = estimateLlmCostUsd(buckets, call.clientName)
      if (est) {
        costUsd += est.costUsd
        noCacheUsd += est.noCacheUsd
        rates = est.rates
      } else {
        costKnown = false
      }
    }
  }
  if (attempts === 0) return undefined
  return {
    ...totals,
    attempts,
    ...(costKnown ? { costUsd, noCacheUsd, rates } : {}),
  }
}

function buildLLMCallDataFromLog(
  last: NonNullable<Collector['last']>,
  functionName: string,
  variables: Record<string, unknown>,
  startTime: number,
  parsedOutput?: unknown,
): LLMCallData {
  // Prefer the call BAML actually selected (handles fallbacks); fall back to the last attempted call.
  // For failures, `selected` is rarely set — we want the last attempt that actually went out.
  const calls = (last.calls ?? []) as CollectorCall[]
  const selectedCall = calls.find((c) => c.selected) ?? calls[calls.length - 1]

  // BAML's httpRequest.body is an HttpBody class instance with .text()/.json()/.raw() methods.
  // JSON.stringify on the class returns "{}" because it has no enumerable own properties.
  let rawInput: string | undefined
  const body = selectedCall?.httpRequest?.body as
    { text?: () => string } | string | Record<string, unknown> | undefined
  if (typeof body === 'string') {
    rawInput = body
  } else if (body && typeof (body as { text?: () => string }).text === 'function') {
    try {
      rawInput = (body as { text: () => string }).text()
    } catch {
      // body.text() may throw on malformed bodies — leave undefined
    }
  } else if (body && typeof body === 'object') {
    rawInput = JSON.stringify(body, null, 2)
  }

  const provider = selectedCall?.provider
  const clientName = selectedCall?.clientName

  // Selected-exchange usage: prefer the raw response (carries the cache-write
  // bucket); fall back to the Collector's aggregate for this log.
  // totalTokens = ALL tokens processed (uncached + cache read + write + out).
  const buckets = callTokenBuckets(selectedCall)
  const usage = buckets
    ? {
        inputTokens: buckets.inputUncachedTokens,
        outputTokens: buckets.outputTokens,
        cachedInputTokens: buckets.inputCacheReadTokens,
        cacheCreationInputTokens: buckets.inputCacheWriteTokens,
        totalTokens:
          buckets.inputUncachedTokens +
          buckets.inputCacheReadTokens +
          buckets.inputCacheWriteTokens +
          buckets.outputTokens,
      }
    : last.usage
      ? {
          inputTokens: last.usage.inputTokens ?? 0,
          outputTokens: last.usage.outputTokens ?? 0,
          cachedInputTokens: last.usage.cachedInputTokens ?? 0,
          totalTokens:
            (last.usage.inputTokens ?? 0) +
            (last.usage.cachedInputTokens ?? 0) +
            (last.usage.outputTokens ?? 0),
        }
      : undefined

  return {
    functionName,
    variables,
    promptTemplate: getPromptTemplate(functionName),
    rawInput,
    rawOutput: last.rawLlmResponse ?? undefined,
    parsedOutput,
    usage,
    durationMs: Date.now() - startTime,
    provider,
    clientName,
  }
}

/** Extract LLM call data after a BAML call threw. Always returns a record
 *  carrying at least `functionName`, `variables`, and `promptTemplate` so the
 *  panel can render the Template/Variables sections even when the collector
 *  never saw a response (e.g. pre-call network failure). HTTP body /
 *  rawOutput / usage are best-effort and may be absent. */
export function extractFailureLLMCallData(
  collector: Collector | undefined,
  functionName: string,
  variables: Record<string, unknown>,
  startTime: number,
): LLMCallData {
  const last = collector?.last
  if (last) {
    const llmCall = buildLLMCallDataFromLog(last, functionName, variables, startTime)
    // Failed steps still spent tokens (e.g. a truncated 32k-output response
    // before the retry also failed) — account for them.
    llmCall.metrics = computeEventMetrics(collector)
    return llmCall
  }
  return {
    functionName,
    variables,
    promptTemplate: getPromptTemplate(functionName),
    durationMs: Date.now() - startTime,
  }
}

// ============================================================================
// Output-cap truncation detection (#see .harness-logs/baml-validation-sandbox.json)
// ============================================================================

/**
 * Whether an LLM call's output was cut off at its client's `max_tokens` cap.
 * Providers report `outputTokens` == the cap exactly on a cap stop (Anthropic's
 * `max_tokens` stop_reason, the OpenAI-compatible `length` finish_reason on the
 * Groq/OpenRouter leaves), so `>= cap` is a precise signal, not a heuristic.
 * Unknown clients (no entry in CLIENT_MAX_OUTPUT_TOKENS) → false, never a
 * false positive — which is why that map must stay complete (SA-C2): a missing
 * leaf entry silently disables this detection for that client.
 *
 * Why it matters: a truncated ControllerAction either loses its trailing
 * required fields (`status`, `is_final`) → hard BamlValidationError, or ends
 * mid-`tool_args` → invalid-JSON rejection in the loop. Both used to feed the
 * model generic feedback, so it would regenerate the same oversized response
 * until retries exhausted. Detection lets the retry say WHY it failed.
 */
export function llmCallHitOutputCap(
  llmCall: Pick<LLMCallData, 'clientName' | 'usage'> | undefined,
): boolean {
  if (!llmCall?.clientName || !llmCall.usage?.outputTokens) return false
  const cap = CLIENT_MAX_OUTPUT_TOKENS[llmCall.clientName]
  return cap !== undefined && llmCall.usage.outputTokens >= cap
}

/** Collector-side variant for adapter catch blocks (pre-LLMCallData). */
function collectorHitOutputCap(collector: Collector | undefined): boolean {
  const last = collector?.last
  if (!last?.usage?.outputTokens) return false
  const calls = (last.calls ?? []) as Array<{ selected?: boolean; clientName?: string }>
  const call = calls.find((c) => c.selected) ?? calls[calls.length - 1]
  const cap = call?.clientName ? CLIENT_MAX_OUTPUT_TOKENS[call.clientName] : undefined
  return cap !== undefined && (last.usage.outputTokens ?? 0) >= cap
}

/**
 * Corrective guidance appended to `context` on the one truncation retry. Goes
 * through the per-call context field (transient — influences only the retry,
 * not other actors or turns). Recovery-oriented per design review: tells the
 * model to APPEND large content across calls, not to pre-emptively chunk.
 */
export const TRUNCATION_RETRY_GUIDANCE =
  'IMPORTANT: your previous response exceeded the output-token limit and was CUT OFF ' +
  'mid-generation, so it could not be parsed. Respond again with a materially SMALLER ' +
  'response. Keep tool_args compact; when a file or script is large, write the first ' +
  "part now and CONTINUE BY APPENDING in later calls (e.g. bash `cat >> file <<'EOF'`) " +
  'instead of inlining everything in a single call.'

/**
 * The model produced NO text at all — the completion is empty.
 *
 * Distinct from truncation despite the identical error text: nothing was
 * generated, so there is nothing to parse and the model did not misunderstand
 * the contract. Observed with these models returning a `thinking` block (whose
 * content is not exposed — empty string plus a signature) and then ending the
 * turn with `stop_reason: end_turn` and no text block. Measured by replaying one
 * captured controller request: 7 of 43 calls, ~16%; the same request with
 * thinking disabled produced 0 of 37. Whether to keep thinking on is a separate
 * question — it is where the controller's reasoning happens — so this is
 * handled as a retry rather than by changing the model configuration.
 */
function collectorReturnedNoText(collector: Collector | undefined): boolean {
  const last = collector?.last
  if (!last) return false
  return !(last.rawLlmResponse ?? '').trim()
}

/**
 * Whether a parse failure is worth ONE retry, and what to tell the model.
 *
 * Shared by both controller adapters so the retry mechanism stays a single
 * branch with two triggers rather than a per-cause code path:
 *  - truncation → retry WITH corrective guidance (the model must respond
 *    differently, so it needs to know why).
 *  - empty completion → retry with the prompt UNCHANGED. There is nothing to
 *    correct: asking again is the whole remedy, and guidance would imply the
 *    model erred when it simply produced nothing.
 *
 * Returns null when the failure is a genuine structured-output failure, which
 * keeps the existing behaviour (propagate, or escalate on the mixed chains).
 */
function planParseRetry(
  error: unknown,
  collector: Collector | undefined,
): { guidance: string | null } | null {
  if (!(error instanceof BamlValidationError)) return null
  if (collectorHitOutputCap(collector)) return { guidance: TRUNCATION_RETRY_GUIDANCE }
  if (collectorReturnedNoText(collector)) return { guidance: null }
  return null
}

/**
 * Recover a complete action from a response whose ENVELOPE was wrong.
 *
 * Third distinct recoverable-parse cause after truncation and the empty
 * completion, and the only one where the model was not actually wrong about the
 * work: it wrote every required field, as brace-less `key: value` lines instead
 * of a JSON object (captured live in `.harness-logs/baml-validation.json` —
 * `sandbox-session-loop`, `ActorController`, 372 output tokens against a 32768
 * cap, so neither truncation nor an empty completion, and neither existing
 * trigger matched). `coerceControllerActionText` owns the shape and the guards;
 * see its docstring for the evidence and for why it refuses to guess.
 *
 * Preferred over a retry wherever it succeeds: the action is already correct, so
 * a retry would spend a round-trip re-deriving it — and, on the prompt that
 * produced the drift, plausibly drift again. Ordered BEFORE `planParseRetry` for
 * that reason; a truncated response cannot be coerced (its trailing fields are
 * gone), so it still reaches the truncation branch.
 *
 * Reads the raw text from the error first (`BamlValidationError.raw_output` is
 * exactly what BAML failed to coerce) and falls back to the collector, so the
 * recovery also works on the paths that run without one.
 *
 * Also tried on the truncation/empty retry's own failure: a retry that drifts to
 * the same wrong envelope has already cost the round-trip, and there is nothing
 * left to gain by discarding a complete action a second time. Not tried on the
 * mixed-chain Groq rungs — those exist because a client cannot do structured
 * output at all, which is a different problem from an envelope slip.
 *
 * DECLINES OUTRIGHT on a cap-hit, before it even looks at the text. A cut-off
 * response can still LOOK complete to a lexical scanner: `tool_args` opening
 * with a quote (`tool_args: "{\"path\":…`) is not an unbalanced bracket, and a
 * cut landing between two `additional_calls` items leaves every item that
 * survived perfectly readable — which would recover a SHORT batch and report it
 * as the model's own. `collectorHitOutputCap` is the same precise signal
 * `planParseRetry` uses (providers report `outputTokens` == the cap exactly), so
 * this hands truncation back to the branch that owns it rather than approximating
 * it. The captured failure this recovery exists for is 372/32768, untouched.
 */
function recoverActionFromEnvelope(
  error: unknown,
  collector: Collector | undefined,
  functionName: string,
  variables: Record<string, unknown>,
  startTime: number,
): ControllerCallResult | null {
  if (!(error instanceof BamlValidationError)) return null
  if (collectorHitOutputCap(collector)) return null
  const raw = error.raw_output || (collector?.last?.rawLlmResponse ?? '')
  const action = coerceControllerActionText(raw)
  if (!action) return null
  console.warn(
    `[baml] ${functionName} returned its action as brace-less \`key: value\` lines instead of ` +
      'a JSON object; every required field was present, so it was coerced rather than discarded. ' +
      'Recurring drift here means a prompt is demonstrating the wrong envelope (the few-shot ' +
      'sections in actorCritic.baml / simpleLoop.baml render the JSON object shape on purpose).',
  )
  return {
    action,
    llmCall: collector
      ? extractLLMCallData(collector, functionName, variables, startTime, action)
      : undefined,
  }
}

/** Error thrown by BAML adapters when an LLM call fails after all in-adapter
 *  fallbacks have been exhausted. Carries the captured prompt/variables/HTTP
 *  bodies so the catching pattern can attach them to the emitted `error`
 *  event. Recovered fallback attempts never produce this — only the final
 *  propagating failure does. */
export class LLMCallError extends Error {
  readonly llmCall: LLMCallData
  readonly cause?: unknown
  constructor(message: string, llmCall: LLMCallData, cause?: unknown) {
    super(message)
    this.name = 'LLMCallError'
    this.llmCall = llmCall
    if (cause !== undefined) this.cause = cause
  }
}

/** Re-throw a BAML failure as an `LLMCallError` enriched with collector data.
 *  Preserves the original error's message and stack via `cause`. Used by all
 *  adapter catch paths so failures arriving at the calling pattern carry the
 *  same prompt/variables/HTTP shape that successful calls already attach.
 *  Exported for the call sites that live outside this module (`routeMessageOp`
 *  in `routing.server.ts`) — every BAML failure must reach its pattern the
 *  same way, or the pattern's error event silently loses the raw response. */
export function wrapAsLLMCallError(
  err: unknown,
  functionName: string,
  variables: Record<string, unknown>,
  startTime: number,
  collector: Collector | undefined,
): LLMCallError {
  const message = err instanceof Error ? err.message : String(err)
  const llmCall = extractFailureLLMCallData(collector, functionName, variables, startTime)
  return new LLMCallError(message, llmCall, err)
}

// ============================================================================
// Prompt Template Extraction
// ============================================================================

/** Cache for extracted prompt templates keyed by function name */
let promptTemplateCache: Record<string, string> | null = null

/** Extract prompt template for a BAML function. Reads from inlinedbaml when
 * available (production builds), and falls back to the on-disk baml_src/
 * directory (dev environments without a generated baml_client). */
function getPromptTemplate(functionName: string): string | undefined {
  if (!promptTemplateCache) {
    promptTemplateCache = {}
    loadTemplatesFromInlinedBaml(promptTemplateCache)
    if (Object.keys(promptTemplateCache).length === 0) {
      loadTemplatesFromDisk(promptTemplateCache)
    }
  }
  return promptTemplateCache[functionName]
}

function loadTemplatesFromInlinedBaml(cache: Record<string, string>): void {
  try {
    const files = getBamlFiles() as Record<string, string>
    for (const source of Object.values(files)) {
      extractPromptTemplates(source, cache)
    }
  } catch {
    // baml_client not generated — caller falls back to disk
  }
}

function loadTemplatesFromDisk(cache: Record<string, string>): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path')
    const bamlSrc = path.resolve(process.cwd(), 'baml_src')
    if (!fs.existsSync(bamlSrc)) return
    for (const entry of fs.readdirSync(bamlSrc)) {
      if (!entry.endsWith('.baml')) continue
      const source = fs.readFileSync(path.join(bamlSrc, entry), 'utf8')
      extractPromptTemplates(source, cache)
    }
  } catch {
    // filesystem unavailable — templates remain unset
  }
}

/** Parse BAML source to extract function prompt blocks. Exported for the
 *  parenthesised-signature-comment pinning test. */
export function extractPromptTemplates(source: string, cache: Record<string, string>): void {
  // Match: function FunctionName(...) -> ReturnType { ... prompt #"..."# }
  //
  // The parameter list is `[^{}]*?`, not `[^)]*`: signatures carry `//`
  // comments, and one parenthesis in a comment — an issue number, an aside —
  // used to make the whole function unmatchable, which shows up only as a
  // missing prompt template in the observability panel. Braces still bound it,
  // so the match can never run past its own function body into the next one.
  const funcRegex = /function\s+(\w+)\s*\([^{}]*?\)\s*->\s*\S+\s*\{[^}]*?prompt\s+#"([\s\S]*?)"#/g
  let match: RegExpExecArray | null
  while ((match = funcRegex.exec(source)) !== null) {
    cache[match[1]] = match[2]
  }
}

// ============================================================================
// Tool Description Cache
// ============================================================================

let toolDescCache: ToolDescription[] | null = null

async function getToolDescriptions(refresh = false): Promise<ToolDescription[]> {
  if (refresh) toolDescCache = null
  if (!toolDescCache) {
    const tools = await mcpListTools()
    toolDescCache = tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      args_schema: t.inputSchema ? JSON.stringify(t.inputSchema) : undefined,
    }))
  }
  return toolDescCache
}

/** Drop the cached tool description list. Use after operations that mutate
 *  the gateway's registered tools
 *  so the next adapter call re-fetches a fresh listing and the LLM sees
 *  newly-registered tools in subsequent attempts/turns. */
export function invalidateToolDescriptions(): void {
  toolDescCache = null
}

/** Filter tool descriptions by names plus an optional regex pattern for
 *  dynamically-discoverable tools. `refresh: true` forces a fresh listTools()
 *  call — needed when the toolset may have changed (e.g. the gateway created
 *  a tool on a prior turn that should now be visible). */
async function filterToolDescriptions(
  toolNames: string[],
  options?: { dynamicPattern?: RegExp; refresh?: boolean },
): Promise<ToolDescription[]> {
  const all = await getToolDescriptions(options?.refresh)
  const nameSet = new Set(toolNames)
  const pattern = options?.dynamicPattern
  return all.filter((t) => nameSet.has(t.name) || (pattern?.test(t.name) ?? false))
}

/** When a `withSandbox` wrapper is active, return its in-VM tool descriptions
 *  in the adapter's `ToolDescription` shape. Outside any sandbox scope, returns
 *  `[]`. See docs/plan/sandbox.md → "How tools reach the controller". The
 *  transport caches its tool list internally, so this is cheap per call. */
async function getActiveSandboxToolDescriptions(): Promise<ToolDescription[]> {
  const sandbox = getActiveSandbox()
  if (!sandbox) return []
  const mcp = await sandbox.listTools()
  return mcp.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    args_schema: t.inputSchema ? JSON.stringify(t.inputSchema) : undefined,
  }))
}

// ============================================================================
// Adapters for simpleLoop
// ============================================================================

/**
 * Create a ControllerFn adapter for simpleLoop that uses the generic LoopController.
 *
 * @param toolNames - Array of tool names available to this controller
 * @param contextPrefix - Optional context prefix for the prompt (e.g., domain-specific instructions)
 * @returns ControllerFnWithLLMData compatible with simpleLoop pattern
 */
export function createLoopControllerAdapter(
  toolNames: string[],
  contextPrefix?: string,
): ControllerFnWithLLMData {
  return async (
    user_message: string,
    intent: string,
    previous_results: string,
    n_turn: number,
    schema?: string,
    collector?: Collector,
    priorResults?: PriorResult[],
    fewShots?: FewShot[],
    // 'off' never reaches the adapter — the pattern maps it to undefined so the
    // prompt renders no affordance (LoopMultiCalls stays empty).
    multiCallMode?: 'parallel' | 'sequential',
    // Pre-formatted plan from an upstream `planner` pattern (#27). simpleLoop
    // reads it off `scope.data.plan` and formats it — same shape as
    // `withReferences` → `scope.data.attachedRefs` → `priorResults`.
    planContext?: string,
    // Terminal-action style (#149). Forwarded verbatim: the prompt treats an
    // absent value as 'summary', so a controller called without it (a bare
    // `b.LoopController.bind(b)`, an older caller) still gets the default.
    returnStyle?: ReturnStyle,
  ): Promise<ControllerCallResult> => {
    const { b } = await import('../../../baml_client')
    const startTime = Date.now()

    // Get tool descriptions for available tools. When a `withSandbox` wrapper
    // is active, prepend its in-VM tool surface so the actor sees them in its
    // first-turn prompt without the caller threading them through `toolNames`.
    const sandboxTools = await getActiveSandboxToolDescriptions()
    const gatewayTools = await filterToolDescriptions(toolNames)
    const tools = [...sandboxTools, ...gatewayTools]

    // Parse previous results into LoopTurn format
    const turns: LoopTurn[] = parseResultsToTurns(previous_results, n_turn)

    // Build context from schema and contextPrefix only (prior tool results go
    // into priorResults). The plan is NOT merged in here: `context` renders
    // inside the prompt's tier-1 cache marker, which is agent-static, and a
    // per-question plan in there would turn every tool-catalog cache read into
    // a write (#122). It travels as its own `plan_context` argument and
    // renders in tier 2, beside the intent.
    let context: string | undefined
    if (schema || contextPrefix) {
      const parts: string[] = []
      if (contextPrefix) parts.push(contextPrefix)
      if (schema) parts.push(`GRAPH SCHEMA:\n${schema}`)
      context = parts.join('\n\n')
    }

    const variables = {
      user_message,
      intent,
      tools,
      turns,
      context,
      turns_previous_runs: priorResults,
      few_shots: fewShots,
      multi_call_mode: multiCallMode,
      plan_context: planContext,
      return_style: returnStyle,
    }

    // Call with or without collector.
    //
    // Default (no override): BAML routes the call to `ControllerAnthropic` —
    // its declared client in `actorCritic.baml` / `simpleLoop.baml`. Anthropic
    // models rarely fail structured output, so the manual Groq fallback below
    // is unhelpful and would defeat the Anthropic-by-default purpose.
    //
    // `USE_MIXED_CHAINS=1`: `clientOverrideFor('controller')` returns
    // `{ client: 'ControllerFallback' }`, swapping in the mixed Groq /
    // OpenRouter / OpenAI chain. Groq's gpt-oss-120b has a known structured-
    // output failure on turn 2+ with larger context — manual escalation to
    // GroqGPT120B → GroqFast kicks in on `BamlValidationError` here, because
    // BAML's built-in fallback only retries on network/API errors.
    const clientOverride = clientOverrideFor('controller')
    const baseOpts = { ...(collector ? { collector } : {}), ...clientOverride }
    const hasBaseOpts = Object.keys(baseOpts).length > 0
    let action: ControllerAction
    try {
      action = hasBaseOpts
        ? await b.LoopController(
            user_message,
            intent,
            tools,
            turns,
            context,
            priorResults,
            fewShots,
            multiCallMode,
            planContext,
            returnStyle,
            baseOpts,
          )
        : await b.LoopController(
            user_message,
            intent,
            tools,
            turns,
            context,
            priorResults,
            fewShots,
            multiCallMode,
            planContext,
            returnStyle,
          )
    } catch (e) {
      // The model wrote every required field but not the JSON envelope: coerce
      // and continue — no retry can improve on an action that is already
      // correct. See `recoverActionFromEnvelope` for the evidence and ordering.
      const coerced = recoverActionFromEnvelope(
        e,
        collector,
        'LoopController',
        variables,
        startTime,
      )
      if (coerced) return coerced
      // Recoverable parse failures (any chain, incl. Anthropic-only): the parse
      // failed because the response was cut off, or because there was no
      // response at all — not because the model can't do structured output.
      // ONE retry, guidance appended to `context` only when there is something
      // to correct (per-call, transient); a second failure throws.
      const plan = planParseRetry(e, collector)
      if (plan) {
        const retryContext = plan.guidance
          ? [context, plan.guidance].filter(Boolean).join('\n\n')
          : context
        try {
          action = hasBaseOpts
            ? await b.LoopController(
                user_message,
                intent,
                tools,
                turns,
                retryContext,
                priorResults,
                fewShots,
                multiCallMode,
                planContext,
                returnStyle,
                baseOpts,
              )
            : await b.LoopController(
                user_message,
                intent,
                tools,
                turns,
                retryContext,
                priorResults,
                fewShots,
                multiCallMode,
                planContext,
                returnStyle,
              )
          const llmCall = collector
            ? extractLLMCallData(collector, 'LoopController', variables, startTime, action)
            : undefined
          return { action, llmCall }
        } catch (eRetry) {
          // The retry drifted too: the same coercion applies, and a second
          // round-trip has already been spent.
          const recovered = recoverActionFromEnvelope(
            eRetry,
            collector,
            'LoopController',
            variables,
            startTime,
          )
          if (recovered) return recovered
          throw wrapAsLLMCallError(eRetry, 'LoopController', variables, startTime, collector)
        }
      }
      if (!(e instanceof BamlValidationError) || !clientOverride) {
        throw wrapAsLLMCallError(e, 'LoopController', variables, startTime, collector)
      }
      try {
        action = await b.LoopController(
          user_message,
          intent,
          tools,
          turns,
          context,
          priorResults,
          fewShots,
          multiCallMode,
          planContext,
          returnStyle,
          collector ? { collector, client: 'GroqGPT120B' } : { client: 'GroqGPT120B' },
        )
      } catch (e2) {
        if (!(e2 instanceof BamlValidationError)) {
          throw wrapAsLLMCallError(e2, 'LoopController', variables, startTime, collector)
        }
        try {
          action = await b.LoopController(
            user_message,
            intent,
            tools,
            turns,
            context,
            priorResults,
            fewShots,
            multiCallMode,
            planContext,
            returnStyle,
            collector ? { collector, client: 'GroqFast' } : { client: 'GroqFast' },
          )
        } catch (e3) {
          throw wrapAsLLMCallError(e3, 'LoopController', variables, startTime, collector)
        }
      }
    }

    // Extract LLM call data if collector present
    const llmCall = collector
      ? extractLLMCallData(collector, 'LoopController', variables, startTime, action)
      : undefined

    return { action, llmCall }
  }
}

/**
 * Parse previous_results JSON string into LoopTurn array.
 * Expects LoopTurn[] JSON produced by simpleLoop's internal turn tracking.
 */
function parseResultsToTurns(previous_results: string, _currentTurn: number): LoopTurn[] {
  if (!previous_results || previous_results === '[]') return []

  try {
    const parsed = JSON.parse(previous_results)
    if (!Array.isArray(parsed)) return []
    // Accept LoopTurn[] format (has numeric 'n' field from simpleLoop tracking)
    if (parsed.length > 0 && typeof parsed[0].n === 'number') {
      return parsed as LoopTurn[]
    }
    return []
  } catch {
    return []
  }
}

// ============================================================================
// PriorResult Merging — used by simpleLoop to combine `withReferences`
// attachments with the existing `priorTurnCount` mechanism, and to annotate
// each ref with the turn it was first inlined via ref:<id>.
// ============================================================================

/** Drop duplicate `ref_id` entries; first occurrence wins. */
export function dedupByRefId(refs: PriorResult[]): PriorResult[] {
  const seen = new Set<string>()
  const out: PriorResult[] = []
  for (const r of refs) {
    if (seen.has(r.ref_id)) continue
    seen.add(r.ref_id)
    out.push(r)
  }
  return out
}

/** Annotate each ref with the **first** `turn.n` whose `expansions[]` contains
 *  its `ref_id`. Refs never expanded get `expanded_in_turn: null` (explicitly,
 *  not absent) — MiniJinja distinguishes None from undefined, and `is none`
 *  in the prompt template only matches None. If we left the field absent the
 *  template's `is not none` test would incorrectly fire for unannotated refs. */
export function annotateExpansions(refs: PriorResult[], turns: LoopTurn[]): PriorResult[] {
  const firstTurn = new Map<string, number>()
  for (const t of turns) {
    for (const e of t.expansions ?? []) {
      if (!firstTurn.has(e.ref_id)) firstTurn.set(e.ref_id, t.n)
    }
  }
  return refs.map((r) => ({
    ...r,
    expanded_in_turn: firstTurn.get(r.ref_id) ?? null,
  }))
}

// ============================================================================
// Adapter for planner
// ============================================================================

/** Planner function that returns a plan + observability data. */
export type PlannerFnWithLLMData = (
  user_message: string,
  intent: string,
  collector?: Collector,
  context?: string,
) => Promise<PlanCallResult>

/**
 * Create a PlannerFn adapter backed by the generic `Planner` BAML function.
 *
 * Resolves the same tool surface a controller would see for `toolNames` —
 * including an active `withSandbox` scope's in-VM tools — so the plan can only
 * ever name tools the executor can actually call.
 *
 * @param toolNames - Tool names the downstream executor will have available
 */
export function createPlannerAdapter(toolNames: string[]): PlannerFnWithLLMData {
  return async (
    user_message: string,
    intent: string,
    collector?: Collector,
    context?: string,
  ): Promise<PlanCallResult> => {
    const { b } = await import('../../../baml_client')
    const startTime = Date.now()

    const sandboxTools = await getActiveSandboxToolDescriptions()
    const gatewayTools = await filterToolDescriptions(toolNames)
    const tools = [...sandboxTools, ...gatewayTools]

    const variables = { user_message, intent, tools, context }

    // `PlannerAnthropic` either way: it is what planner.baml declares, and
    // `clientOverrideFor('planner')` pins the same client under
    // `USE_MIXED_CHAINS=1` (see clients.server.ts for why the mixed chain is
    // the wrong home for this call). So the escalation ladder the controllers
    // carry for Groq's structured-output failure has nothing to escalate to
    // here — the retry below is the whole policy.
    const baseOpts = { ...(collector ? { collector } : {}), ...clientOverrideFor('planner') }
    const hasBaseOpts = Object.keys(baseOpts).length > 0
    let plan: PlanResult
    try {
      plan = hasBaseOpts
        ? await b.Planner(user_message, intent, tools, context, baseOpts)
        : await b.Planner(user_message, intent, tools, context)
    } catch (e) {
      // ONE retry on a cut-off or empty completion, with corrective guidance
      // only when there is something to correct; a genuine structured-output
      // failure propagates as an LLMCallError the pattern turns into an error
      // event. The controllers' extra Groq→Groq escalation has no counterpart
      // here on purpose: this call never runs on a Groq client.
      const retry = planParseRetry(e, collector)
      if (!retry) throw wrapAsLLMCallError(e, 'Planner', variables, startTime, collector)
      const retryContext = retry.guidance
        ? [context, retry.guidance].filter(Boolean).join('\n\n')
        : context
      try {
        plan = hasBaseOpts
          ? await b.Planner(user_message, intent, tools, retryContext, baseOpts)
          : await b.Planner(user_message, intent, tools, retryContext)
      } catch (eRetry) {
        throw wrapAsLLMCallError(eRetry, 'Planner', variables, startTime, collector)
      }
    }

    // extractLLMCallData fires warnIfCollectorEmpty itself on an empty collector.
    const llmCall = collector
      ? extractLLMCallData(collector, 'Planner', variables, startTime, plan)
      : undefined

    return { plan, llmCall, toolCount: tools.length }
  }
}

// ============================================================================
// Adapters for actorCritic
// ============================================================================

/** Actor controller function that returns action + observability data.
 *  `attemptNumber` / `maxAttempts` are passed by `actorCritic.server.ts` so the
 *  actor's prompt can show "Attempt N of M" and prefer Return as budget runs low. */
export type ActorControllerFnWithLLMData = (
  user_message: string,
  intent: string,
  available_tools: string[],
  previous_attempts: ScriptExecutionEvent[],
  collector?: Collector,
  attemptNumber?: number,
  maxAttempts?: number,
  multiCallMode?: 'parallel' | 'sequential',
  /** Pre-formatted plan from an upstream `planner` (#27). Trailing + optional
   *  for the same positional-args reason as `ControllerFnWithLLMData`. */
  planContext?: string,
) => Promise<ControllerCallResult>

/** Options for `createActorControllerAdapter` when the actor's toolset may
 *  change at runtime (a backend that registers new tools
 *  that should be visible to subsequent actor calls in the same session). */
export interface ActorAdapterOptions {
  /** Static tool names always available to the actor. Mutually exclusive
   *  with `toolNamesProvider`; if both are set, the provider wins. */
  toolNames?: string[]
  /** Async closure resolved per actor invocation. Use this when the
   *  allowlist is user-curated and may change between turns of the same
   *  session (e.g. an agent reading a per-conversation allowlist
   *  from the persisted conversation context). Adds one DB read per call. */
  toolNamesProvider?: () => Promise<string[]>
  /** Regex matched against gateway-listed tool names. Any match is added to
   *  the actor's prompt alongside the static names. */
  dynamicPattern?: RegExp
  /** When true, re-list gateway tools on every actor call (instead of using
   *  the module-level cache). Set this for agents whose toolset evolves
   *  across turns. Adds one MCP roundtrip per actor invocation. */
  refreshOnCall?: boolean
  /** Optional domain-specific guidance prepended to the actor's prompt under
   *  the `CONTEXT:` heading. Mirrors `createLoopControllerAdapter(contextPrefix)`.
   *  Used to teach the actor about a backend-specific
   *  protocol, batching heuristics, etc. */
  contextPrefix?: string
  /** Like `contextPrefix` but resolved per actor invocation — use when the
   *  context varies with live state (e.g. folding the conversation's current
   *  tool catalog into the prompt). Wins over `contextPrefix` when set. */
  contextProvider?: () => Promise<string>
  /** Optional FewShot examples rendered into the actor's prompt under
   *  `EXAMPLES:`. Mirrors LoopController's few-shots. Keep small (2–4). */
  fewShots?: FewShot[]
}

/**
 * Create an actor-controller adapter that uses the generic ActorController.
 *
 * Two call shapes:
 *   createActorControllerAdapter(['t1', 't2'])           // static toolset (back-compat)
 *   createActorControllerAdapter({ toolNames, dynamicPattern, refreshOnCall })  // dynamic
 *
 * The dynamic form is for agents whose backend creates tools at runtime —
 * the actor needs to see them in its prompt to call them, and a fresh
 * listing per call ensures the LLM is aware of tools created in earlier
 * turns of the same session (the kg-agent gateway persists them across turns).
 */
export function createActorControllerAdapter(
  toolsOrOptions: string[] | ActorAdapterOptions,
): ActorControllerFnWithLLMData {
  const options: ActorAdapterOptions = Array.isArray(toolsOrOptions)
    ? { toolNames: toolsOrOptions }
    : toolsOrOptions

  return async (
    user_message: string,
    intent: string,
    available_tools: string[],
    previous_attempts: ScriptExecutionEvent[],
    collector?: Collector,
    attemptNumber?: number,
    maxAttempts?: number,
    // 'off' never reaches the adapter — the pattern maps it to undefined so the
    // prompt renders no affordance (ActorMultiCalls stays empty).
    multiCallMode?: 'parallel' | 'sequential',
    planContext?: string,
  ): Promise<ControllerCallResult> => {
    const { b } = await import('../../../baml_client')
    const startTime = Date.now()

    // Resolve the actor's allowlist. `toolNamesProvider` (if set) is called
    // fresh per invocation so user-curated selections persisted to the
    // session context surface live; otherwise fall back to the static array.
    const names = options.toolNamesProvider
      ? await options.toolNamesProvider()
      : (options.toolNames ?? [])

    // Get tool descriptions — optionally refresh + include pattern matches.
    // When a `withSandbox` wrapper is active, prepend its in-VM tool surface
    // so the actor sees them in its first-turn prompt without the caller
    // threading them through `toolNames` / `toolNamesProvider`.
    const sandboxTools = await getActiveSandboxToolDescriptions()
    const gatewayTools = await filterToolDescriptions(names, {
      dynamicPattern: options.dynamicPattern,
      refresh: options.refreshOnCall,
    })
    const tools = [...sandboxTools, ...gatewayTools]

    // Convert ScriptExecutionEvent to Attempt format. `toolName` records the
    // actor's actual tool_name per push — so a rejected `mcp-exec` attempt
    // renders as `Action: mcp-exec(<bad args>)` rather than a placeholder.
    // `actorCritic` always sets it; the fallback only covers a caller that
    // constructs the events itself. `additionalCalls` (multi-call attempts)
    // replays into the action so the attempt log shows the batch shape the
    // actor actually emitted (exact-replay invariant).
    const attempts: Attempt[] = previous_attempts.map((event, i) => ({
      n: i + 1,
      action: {
        reasoning: '',
        tool_name: event.toolName ?? 'unknown',
        tool_args: event.script,
        ...(event.additionalCalls?.length ? { additional_calls: event.additionalCalls } : {}),
        status: event.error ? 'error' : 'success',
        is_final: false,
      },
      result: event.output,
      error: event.error ?? undefined,
      // The critic's reason for rejecting this attempt (SA-C1). Hardcoded
      // `undefined` here made `ActorAttemptLog`'s CRITIC FEEDBACK block dead
      // code, so every retry ran blind.
      feedback: event.feedback,
    }))

    // Adapter-level context (static prefix or per-call provider), with an
    // upstream plan (#27) leading when one was threaded through by actorCritic.
    const ownContext = options.contextProvider
      ? await options.contextProvider()
      : options.contextPrefix
    const context = [planContext, ownContext].filter(Boolean).join('\n\n') || undefined
    const fewShots = options.fewShots

    const variables = {
      user_message,
      intent,
      tools,
      attempts,
      context,
      few_shots: fewShots,
      attempt_n: attemptNumber,
      max_attempts: maxAttempts,
      multi_call_mode: multiCallMode,
    }

    // Call with or without collector.
    //
    // Default (no override): BAML routes to `ControllerAnthropic` (declared
    // in `actorCritic.baml`). Anthropic models rarely fail structured output,
    // so the manual Groq fallback below is skipped.
    //
    // `USE_MIXED_CHAINS=1`: `clientOverrideFor('controller')` swaps in
    // `ControllerFallback` (the mixed Groq/OpenRouter/OpenAI chain). Groq's
    // gpt-oss-120b has a known structured-output failure on turn 2+ — manual
    // escalation to GroqGPT120B → GroqFast kicks in on `BamlValidationError`
    // here, mirroring `createLoopControllerAdapter` above. Without this, a
    // single failure on the first actor call would kill the loop (see
    // `.harness-logs/parsing-error.json`). Non-validation failures (network,
    // pre-call) are wrapped as `LLMCallError` so the observability panel
    // keeps the captured prompt/variables drill-down.
    const clientOverride = clientOverrideFor('controller')
    const baseOpts = { ...(collector ? { collector } : {}), ...clientOverride }
    const hasBaseOpts = Object.keys(baseOpts).length > 0
    let action: ControllerAction
    try {
      action = hasBaseOpts
        ? await b.ActorController(
            user_message,
            intent,
            tools,
            attempts,
            context,
            fewShots,
            attemptNumber,
            maxAttempts,
            multiCallMode,
            baseOpts,
          )
        : await b.ActorController(
            user_message,
            intent,
            tools,
            attempts,
            context,
            fewShots,
            attemptNumber,
            maxAttempts,
            multiCallMode,
          )
    } catch (e) {
      // Wrong envelope, right action: coerce and continue. This is the path the
      // captured `sandbox-session-loop` failure took, and it must run before
      // the truncation branch below — see `recoverActionFromEnvelope`.
      const coerced = recoverActionFromEnvelope(
        e,
        collector,
        'ActorController',
        variables,
        startTime,
      )
      if (coerced) return coerced
      // Truncated or empty response: one retry, guidance only when there is
      // something to correct — see createLoopControllerAdapter for rationale.
      const plan = planParseRetry(e, collector)
      if (plan) {
        const retryContext = plan.guidance
          ? [context, plan.guidance].filter(Boolean).join('\n\n')
          : context
        try {
          action = hasBaseOpts
            ? await b.ActorController(
                user_message,
                intent,
                tools,
                attempts,
                retryContext,
                fewShots,
                attemptNumber,
                maxAttempts,
                multiCallMode,
                baseOpts,
              )
            : await b.ActorController(
                user_message,
                intent,
                tools,
                attempts,
                retryContext,
                fewShots,
                attemptNumber,
                maxAttempts,
                multiCallMode,
              )
          const llmCall = collector
            ? extractLLMCallData(collector, 'ActorController', variables, startTime, action)
            : undefined
          return { action, llmCall }
        } catch (eRetry) {
          // The retry drifted too: the same coercion applies, and a second
          // round-trip has already been spent.
          const recovered = recoverActionFromEnvelope(
            eRetry,
            collector,
            'ActorController',
            variables,
            startTime,
          )
          if (recovered) return recovered
          throw wrapAsLLMCallError(eRetry, 'ActorController', variables, startTime, collector)
        }
      }
      if (!(e instanceof BamlValidationError) || !clientOverride) {
        throw wrapAsLLMCallError(e, 'ActorController', variables, startTime, collector)
      }
      try {
        action = await b.ActorController(
          user_message,
          intent,
          tools,
          attempts,
          context,
          fewShots,
          attemptNumber,
          maxAttempts,
          multiCallMode,
          collector ? { collector, client: 'GroqGPT120B' } : { client: 'GroqGPT120B' },
        )
      } catch (e2) {
        if (!(e2 instanceof BamlValidationError)) {
          throw wrapAsLLMCallError(e2, 'ActorController', variables, startTime, collector)
        }
        try {
          action = await b.ActorController(
            user_message,
            intent,
            tools,
            attempts,
            context,
            fewShots,
            attemptNumber,
            maxAttempts,
            multiCallMode,
            collector ? { collector, client: 'GroqFast' } : { client: 'GroqFast' },
          )
        } catch (e3) {
          throw wrapAsLLMCallError(e3, 'ActorController', variables, startTime, collector)
        }
      }
    }

    // Extract LLM call data if collector present
    const llmCall = collector
      ? extractLLMCallData(collector, 'ActorController', variables, startTime, action)
      : undefined

    return { action, llmCall }
  }
}

/**
 * Create a CriticFn adapter that uses the generic Critic.
 *
 * @returns CriticFnWithLLMData compatible with actorCritic pattern
 */
export function createCriticAdapter(): CriticFnWithLLMData {
  return async (
    intent: string,
    previous_attempts: ScriptExecutionEvent[],
    collector?: Collector,
  ): Promise<CriticCallResult> => {
    const { b } = await import('../../../baml_client')
    const startTime = Date.now()

    // Convert ScriptExecutionEvent to Attempt format. See the actor adapter
    // above for why `toolName` carries the actor's real tool name.
    const attempts: Attempt[] = previous_attempts.map((event, i) => ({
      n: i + 1,
      action: {
        reasoning: '',
        tool_name: event.toolName ?? 'unknown',
        tool_args: event.script,
        ...(event.additionalCalls?.length ? { additional_calls: event.additionalCalls } : {}),
        status: event.error ? 'error' : 'success',
        is_final: false,
      },
      result: event.output,
      error: event.error ?? undefined,
      // The critic's reason for rejecting this attempt (SA-C1). Hardcoded
      // `undefined` here made `ActorAttemptLog`'s CRITIC FEEDBACK block dead
      // code, so every retry ran blind.
      feedback: event.feedback,
    }))

    const variables = { intent, attempts }

    // Call with or without collector. Anthropic override applied when
    // `USE_ANTHROPIC_ONLY=1` — routes through `CriticAnthropic`.
    const criticOpts = { ...(collector ? { collector } : {}), ...clientOverrideFor('critic') }
    const hasCriticOpts = Object.keys(criticOpts).length > 0
    let result: CriticResult
    try {
      result = hasCriticOpts
        ? await b.Critic(intent, attempts, criticOpts)
        : await b.Critic(intent, attempts)
    } catch (e) {
      throw wrapAsLLMCallError(e, 'Critic', variables, startTime, collector)
    }

    // Extract LLM call data if collector present
    const llmCall = collector
      ? extractLLMCallData(collector, 'Critic', variables, startTime, result)
      : undefined

    return { result, llmCall }
  }
}

// ============================================================================
// Tool Result Summarization
// ============================================================================

/**
 * Summarize a tool result using a lightweight model.
 * Non-fatal: returns empty string on failure.
 */
export async function describeToolResultOp(
  tool: string,
  toolArgs: string,
  reasoning: string,
  result: string,
): Promise<string> {
  try {
    const { b } = await import('../../../baml_client')
    const describeOpts = clientOverrideFor('describe')
    return describeOpts
      ? await b.ResultDescribe(tool, toolArgs, reasoning, result, describeOpts)
      : await b.ResultDescribe(tool, toolArgs, reasoning, result)
  } catch {
    return ''
  }
}

/** One tool result to summarize as part of a batch. `id` is a caller-assigned
 *  label, unique within the batch, that the model echoes back on its summary —
 *  it is how the batch's single response is split back per item. */
export interface DescribeBatchItem {
  id: string
  tool: string
  toolArgs: string
  reasoning: string
  result: string
}

/**
 * Summarize several tool results in ONE describe-tier call (#83 Part E).
 *
 * Returns a map of item `id` → summary. Non-fatal in three graded ways, all of
 * which leave the caller free to fall back per item:
 *  - the whole call failed → empty map (every item missing)
 *  - the model dropped an item → that `id` is absent
 *  - the model answered blank for an item → that `id` is absent
 *
 * Unknown ids in the response are discarded rather than guessed at, so a
 * hallucinated label can never attach a summary to the wrong tool result.
 */
export async function describeToolResultsBatchOp(
  items: DescribeBatchItem[],
): Promise<Map<string, string>> {
  const byId = new Map<string, string>()
  if (items.length === 0) return byId
  const wanted = new Set(items.map((i) => i.id))
  try {
    const { b } = await import('../../../baml_client')
    const describeOpts = clientOverrideFor('describe')
    const targets = items.map((i) => ({
      id: i.id,
      tool: i.tool,
      tool_args: i.toolArgs,
      reasoning: i.reasoning,
      result: i.result,
    }))
    const batch = describeOpts
      ? await b.ResultDescribeBatch(targets, describeOpts)
      : await b.ResultDescribeBatch(targets)
    for (const entry of batch?.summaries ?? []) {
      const summary = entry?.summary?.trim()
      if (summary && wanted.has(entry.id)) byId.set(entry.id, summary)
    }
  } catch (error) {
    // Visible on purpose: the caller silently retries each item on its own, so
    // a chronically failing batch would otherwise look like a cost regression
    // (N+1 calls) with no explanation in the logs.
    console.warn(
      `[compactBulkData] batched describe of ${items.length} results failed, ` +
        `falling back per item: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return byId
}

// ============================================================================
// Injection screen (optional second layer of withInjectionGuard)
// ============================================================================

/**
 * BAML-backed `InjectionScreen` — the OPT-IN second layer of
 * `withInjectionGuard`. Pass it as the guard's `screen`:
 *
 *   withInjectionGuard({ namespaces: ['web'], screen: createInjectionScreen() })
 *
 * The guard invokes it only for content its deterministic corpus passed clean,
 * so this costs one cheap `DescribeAnthropic` call per otherwise-clean untrusted
 * result — never one per tool call, and never on the default path (no agent gets
 * a screen it did not ask for). `DescribeAnthropic` in BOTH modes: the call
 * goes through the `screen` role, which — like the planner — pins its Anthropic
 * client under `USE_MIXED_CHAINS=1` instead of following `describe` onto
 * `DescribeFallback`, whose first leaf is the weakest model in the repo
 * (rationale on the role's map entry in clients.server.ts; SA-M5).
 *
 * `maxChars` bounds what is sent: a 2 MB page would blow the context window and
 * cost more than the protection is worth. The head of a document is where
 * injections are placed to be read first, so the head is what gets screened —
 * and the deterministic corpus, which has no such bound, still covers the whole
 * thing. The truncation is reported in the verdict reason rather than hidden.
 */
export function createInjectionScreen(options?: { maxChars?: number }): InjectionScreen {
  const maxChars = options?.maxChars ?? 20_000

  return async ({ tool, namespace, content }) => {
    const truncated = content.length > maxChars
    // TRUNCATE FIRST, then de-fence. The de-fencing regex must never run over
    // the full payload: only `maxChars` of it are ever interpolated into the
    // prompt, so scanning the other 2 MB buys no protection and hands an
    // attacker a free CPU multiplier on a value that is otherwise discarded.
    const head = truncated ? content.slice(0, maxChars) : content

    // Neutralize the PROMPT's own fence before interpolating. The guard escapes
    // its `⟦⟧` sentinels out of content so data cannot forge a marker or close
    // the spotlight fence; the screen prompt has an ASCII fence
    // (`---BEGIN/END UNTRUSTED CONTENT UNDER REVIEW---`) with no such
    // protection, and by construction the screen only ever sees content the
    // regex corpus passed clean. Without this, a page could close the fence and
    // address the screening model directly — the exact hole `sentinel-escape`
    // exists to close, one layer up.
    //
    // Anchored on the KEYWORD, not on a leading `-{2,}` run. The original
    // `-{2,}\s*(?:BEGIN|END)…` put two variable-length runs back to back, which
    // is quadratic: 100k hyphens measured 10s of synchronous CPU (and, run
    // pre-truncation, on content that was about to be thrown away). Dropping the
    // hyphen run is also strictly STRONGER — the old pattern required at least
    // two hyphens, so `BEGIN UNTRUSTED CONTENT` with no decoration at all
    // evaded it while still reading as a fence to the screening model.
    const body = head.replace(/(?:BEGIN|END)\s{1,4}UNTRUSTED\s{1,4}CONTENT[^\n]{0,40}/gi, '[fence]')

    const { b } = await import('../../../baml_client')
    const opts = clientOverrideFor('screen')
    const source = `${namespace}/${tool}`
    const verdict = opts
      ? await b.ScreenUntrustedContent(source, body, opts)
      : await b.ScreenUntrustedContent(source, body)

    return {
      injection_detected: verdict.injection_detected,
      reason: truncated
        ? `${verdict.reason} (screened first ${maxChars} of ${content.length} chars)`
        : verdict.reason,
      spans: verdict.spans ?? [],
    }
  }
}

// ============================================================================
// Domain-Specific Controller Adapters
// ============================================================================

/** Neo4j controller - uses LoopController with graph schema context (schema injected via config.schema) */
export function createNeo4jController(toolNames: string[]): ControllerFnWithLLMData {
  return createLoopControllerAdapter(toolNames)
}

/** Web search controller */
export function createWebSearchController(toolNames: string[]): ControllerFnWithLLMData {
  return createLoopControllerAdapter(toolNames)
}

/** Memory controller */
export function createMemoryController(toolNames: string[]): ControllerFnWithLLMData {
  return createLoopControllerAdapter(toolNames)
}

/** Context7 documentation controller */
export function createContext7Controller(toolNames: string[]): ControllerFnWithLLMData {
  return createLoopControllerAdapter(toolNames)
}

/** Filesystem controller */
export function createFilesystemController(toolNames: string[]): ControllerFnWithLLMData {
  return createLoopControllerAdapter(toolNames)
}

/** Redis controller */
export function createRedisController(toolNames: string[]): ControllerFnWithLLMData {
  return createLoopControllerAdapter(toolNames)
}

/** Database controller */
export function createDatabaseController(toolNames: string[]): ControllerFnWithLLMData {
  return createLoopControllerAdapter(toolNames)
}
