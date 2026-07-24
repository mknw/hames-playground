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
 * - CodeModeControllerFn(user_message, intent, available_tools, previous_attempts)
 */

import { assertServerOnImport } from './assert.server'
import type { ControllerFn, CriticFn, CodeModeControllerFn, ControllerAction, CriticResult, ScriptExecutionEvent, LLMCallData } from './types'
import type { ToolDescription, LoopTurn, Attempt, PriorResult, FewShot } from '../../../baml_client/types'
import { listTools as mcpListTools } from './mcp-client.server'
import { getActiveSandbox } from '../sandbox/scope.server'
import { Collector, BamlValidationError } from '@boundaryml/baml'
import { getBamlFiles } from '../../../baml_client/inlinedbaml'
import { clientOverrideFor } from './clients.server'
import { CLIENT_MAX_OUTPUT_TOKENS } from '../settings'

assertServerOnImport()

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

/** Controller function that returns action + observability data */
export type ControllerFnWithLLMData = (
  user_message: string,
  intent: string,
  previous_results: string,
  n_turn: number,
  schema?: string,
  collector?: Collector,
  priorResults?: PriorResult[],
  fewShots?: FewShot[]
) => Promise<ControllerCallResult>

/** Critic function that returns result + observability data */
export type CriticFnWithLLMData = (
  intent: string,
  previous_attempts: ScriptExecutionEvent[],
  collector?: Collector
) => Promise<CriticCallResult>

/** Extract LLM call data from a collector */
export function extractLLMCallData(
  collector: Collector,
  functionName: string,
  variables: Record<string, unknown>,
  startTime: number,
  parsedOutput?: unknown
): LLMCallData | undefined {
  const last = collector.last
  if (!last) return undefined
  return buildLLMCallDataFromLog(last, functionName, variables, startTime, parsedOutput)
}

/** Build LLMCallData from a collector log entry. Used for both success and
 *  failure paths — on failure `parsedOutput` is omitted, `rawOutput` may be
 *  empty, and `usage` may be absent, but `promptTemplate`/`variables` are
 *  always populated so the failed-call drill-down has something to render. */
function buildLLMCallDataFromLog(
  last: NonNullable<Collector['last']>,
  functionName: string,
  variables: Record<string, unknown>,
  startTime: number,
  parsedOutput?: unknown
): LLMCallData {
  // Prefer the call BAML actually selected (handles fallbacks); fall back to the last attempted call.
  // For failures, `selected` is rarely set — we want the last attempt that actually went out.
  const calls = (last.calls ?? []) as Array<{
    selected?: boolean
    provider?: string
    clientName?: string
    httpRequest?: { body?: unknown }
  }>
  const selectedCall = calls.find((c) => c.selected) ?? calls[calls.length - 1]

  // BAML's httpRequest.body is an HttpBody class instance with .text()/.json()/.raw() methods.
  // JSON.stringify on the class returns "{}" because it has no enumerable own properties.
  let rawInput: string | undefined
  const body = selectedCall?.httpRequest?.body as
    | { text?: () => string }
    | string
    | Record<string, unknown>
    | undefined
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

  return {
    functionName,
    variables,
    promptTemplate: getPromptTemplate(functionName),
    rawInput,
    rawOutput: last.rawLlmResponse ?? undefined,
    parsedOutput,
    usage: last.usage ? {
      inputTokens: last.usage.inputTokens ?? 0,
      outputTokens: last.usage.outputTokens ?? 0,
      cachedInputTokens: last.usage.cachedInputTokens ?? 0,
      totalTokens: (last.usage.inputTokens ?? 0) + (last.usage.outputTokens ?? 0)
    } : undefined,
    durationMs: Date.now() - startTime,
    provider,
    clientName
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
  startTime: number
): LLMCallData {
  const last = collector?.last
  if (last) {
    return buildLLMCallDataFromLog(last, functionName, variables, startTime)
  }
  return {
    functionName,
    variables,
    promptTemplate: getPromptTemplate(functionName),
    durationMs: Date.now() - startTime
  }
}

// ============================================================================
// Output-cap truncation detection (#see .harness-logs/baml-validation-sandbox.json)
// ============================================================================

/**
 * Whether an LLM call's output was cut off at its client's `max_tokens` cap.
 * Anthropic reports `outputTokens` == the cap exactly on a max_tokens stop, so
 * `>= cap` is a precise signal, not a heuristic. Unknown clients (no entry in
 * CLIENT_MAX_OUTPUT_TOKENS) → false, never a false positive.
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
 *  same prompt/variables/HTTP shape that successful calls already attach. */
function wrapAsLLMCallError(
  err: unknown,
  functionName: string,
  variables: Record<string, unknown>,
  startTime: number,
  collector: Collector | undefined
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

/** Parse BAML source to extract function prompt blocks */
function extractPromptTemplates(source: string, cache: Record<string, string>): void {
  // Match: function FunctionName(...) -> ReturnType { ... prompt #"..."# }
  const funcRegex = /function\s+(\w+)\s*\([^)]*\)\s*->\s*\S+\s*\{[^}]*?prompt\s+#"([\s\S]*?)"#/g
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
      args_schema: t.inputSchema ? JSON.stringify(t.inputSchema) : undefined
    }))
  }
  return toolDescCache
}

/** Drop the cached tool description list. Use after operations that mutate
 *  the gateway's registered tools (e.g. the kg-agent `code-mode` factory)
 *  so the next adapter call re-fetches a fresh listing and the LLM sees
 *  newly-registered tools in subsequent attempts/turns. */
export function invalidateToolDescriptions(): void {
  toolDescCache = null
}

/** Filter tool descriptions by names plus an optional regex pattern for
 *  dynamically-discoverable tools. `refresh: true` forces a fresh listTools()
 *  call — needed when the toolset may have changed (e.g. the gateway created
 *  a `code-mode-<name>` tool on a prior turn that should now be visible). */
async function filterToolDescriptions(
  toolNames: string[],
  options?: { dynamicPattern?: RegExp; refresh?: boolean }
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
  contextPrefix?: string
): ControllerFnWithLLMData {
  return async (
    user_message: string,
    intent: string,
    previous_results: string,
    n_turn: number,
    schema?: string,
    collector?: Collector,
    priorResults?: PriorResult[],
    fewShots?: FewShot[]
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

    // Build context from schema and contextPrefix only (prior tool results go into priorResults)
    let context: string | undefined
    if (schema || contextPrefix) {
      const parts: string[] = []
      if (contextPrefix) parts.push(contextPrefix)
      if (schema) parts.push(`GRAPH SCHEMA:\n${schema}`)
      context = parts.join('\n\n')
    }

    const variables = { user_message, intent, tools, turns, context, turns_previous_runs: priorResults, few_shots: fewShots }

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
        ? await b.LoopController(user_message, intent, tools, turns, context, priorResults, fewShots, baseOpts)
        : await b.LoopController(user_message, intent, tools, turns, context, priorResults, fewShots)
    } catch (e) {
      // Output-cap truncation (any chain, incl. Anthropic-only): the parse
      // failed because the response was cut off, not because the model can't
      // do structured output. ONE corrective retry with the truncation notice
      // appended to `context` (per-call, transient); a second failure throws.
      if (e instanceof BamlValidationError && collectorHitOutputCap(collector)) {
        const retryContext = [context, TRUNCATION_RETRY_GUIDANCE].filter(Boolean).join('\n\n')
        try {
          action = hasBaseOpts
            ? await b.LoopController(user_message, intent, tools, turns, retryContext, priorResults, fewShots, baseOpts)
            : await b.LoopController(user_message, intent, tools, turns, retryContext, priorResults, fewShots)
          const llmCall = collector
            ? extractLLMCallData(collector, 'LoopController', variables, startTime, action)
            : undefined
          return { action, llmCall }
        } catch (eRetry) {
          throw wrapAsLLMCallError(eRetry, 'LoopController', variables, startTime, collector)
        }
      }
      if (!(e instanceof BamlValidationError) || !clientOverride) {
        throw wrapAsLLMCallError(e, 'LoopController', variables, startTime, collector)
      }
      try {
        action = await b.LoopController(user_message, intent, tools, turns, context, priorResults, fewShots, collector ? { collector, client: 'GroqGPT120B' } : { client: 'GroqGPT120B' })
      } catch (e2) {
        if (!(e2 instanceof BamlValidationError)) {
          throw wrapAsLLMCallError(e2, 'LoopController', variables, startTime, collector)
        }
        try {
          action = await b.LoopController(user_message, intent, tools, turns, context, priorResults, fewShots, collector ? { collector, client: 'GroqFast' } : { client: 'GroqFast' })
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
  return refs.map(r => ({
    ...r,
    expanded_in_turn: firstTurn.get(r.ref_id) ?? null
  }))
}

// ============================================================================
// Adapters for actorCritic
// ============================================================================

/** Code mode controller function that returns action + observability data.
 *  `attemptNumber` / `maxAttempts` are passed by `actorCritic.server.ts` so the
 *  actor's prompt can show "Attempt N of M" and prefer Return as budget runs low. */
export type CodeModeControllerFnWithLLMData = (
  user_message: string,
  intent: string,
  available_tools: string[],
  previous_attempts: ScriptExecutionEvent[],
  collector?: Collector,
  attemptNumber?: number,
  maxAttempts?: number
) => Promise<ControllerCallResult>

/** Options for `createActorControllerAdapter` when the actor's toolset may
 *  change at runtime (e.g. kg-agent's `code-mode` factory creates new tools
 *  that should be visible to subsequent actor calls in the same session). */
export interface ActorAdapterOptions {
  /** Static tool names always available to the actor. Mutually exclusive
   *  with `toolNamesProvider`; if both are set, the provider wins. */
  toolNames?: string[]
  /** Async closure resolved per actor invocation. Use this when the
   *  allowlist is user-curated and may change between turns of the same
   *  session (e.g. the code-mode agent reads `data.codeModeAllowedTools`
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
   *  Used by the code-mode agent to teach the actor about the factory
   *  protocol, batching heuristics, etc. */
  contextPrefix?: string
  /** Like `contextPrefix` but resolved per actor invocation — use when the
   *  context varies with live state (e.g. code-mode folds the conversation's
   *  current ENABLED SERVERS catalog into the prompt so the actor knows which
   *  servers to scope the factory to). Wins over `contextPrefix` when set. */
  contextProvider?: () => Promise<string>
  /** Optional FewShot examples rendered into the actor's prompt under
   *  `EXAMPLES:`. Mirrors LoopController's few-shots. Keep small (2–4). */
  fewShots?: FewShot[]
}

/**
 * Create a CodeModeControllerFn adapter that uses the generic ActorController.
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
  toolsOrOptions: string[] | ActorAdapterOptions
): CodeModeControllerFnWithLLMData {
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
  ): Promise<ControllerCallResult> => {
    const { b } = await import('../../../baml_client')
    const startTime = Date.now()

    // Resolve the actor's allowlist. `toolNamesProvider` (if set) is called
    // fresh per invocation so user-curated selections persisted to the
    // session context surface live; otherwise fall back to the static array.
    const names = options.toolNamesProvider
      ? await options.toolNamesProvider()
      : options.toolNames ?? []

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
    // renders as `Action: mcp-exec(<bad args>)` instead of the misleading
    // `code-mode(<empty>)` it used to show. Falls back to `'code-mode'` for
    // legacy callers that don't set `toolName`.
    const attempts: Attempt[] = previous_attempts.map((event, i) => ({
      n: i + 1,
      action: {
        reasoning: '',
        tool_name: event.toolName ?? 'code-mode',
        tool_args: event.script,
        status: event.error ? 'error' : 'success',
        is_final: false
      },
      result: event.output,
      error: event.error ?? undefined,
      feedback: undefined
    }))

    const context = options.contextProvider
      ? await options.contextProvider()
      : options.contextPrefix
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
        ? await b.ActorController(user_message, intent, tools, attempts, context, fewShots, attemptNumber, maxAttempts, baseOpts)
        : await b.ActorController(user_message, intent, tools, attempts, context, fewShots, attemptNumber, maxAttempts)
    } catch (e) {
      // Output-cap truncation: one corrective retry with the truncation notice
      // appended to `context` — see createLoopControllerAdapter for rationale.
      if (e instanceof BamlValidationError && collectorHitOutputCap(collector)) {
        const retryContext = [context, TRUNCATION_RETRY_GUIDANCE].filter(Boolean).join('\n\n')
        try {
          action = hasBaseOpts
            ? await b.ActorController(user_message, intent, tools, attempts, retryContext, fewShots, attemptNumber, maxAttempts, baseOpts)
            : await b.ActorController(user_message, intent, tools, attempts, retryContext, fewShots, attemptNumber, maxAttempts)
          const llmCall = collector
            ? extractLLMCallData(collector, 'ActorController', variables, startTime, action)
            : undefined
          return { action, llmCall }
        } catch (eRetry) {
          throw wrapAsLLMCallError(eRetry, 'ActorController', variables, startTime, collector)
        }
      }
      if (!(e instanceof BamlValidationError) || !clientOverride) {
        throw wrapAsLLMCallError(e, 'ActorController', variables, startTime, collector)
      }
      try {
        action = await b.ActorController(user_message, intent, tools, attempts, context, fewShots, attemptNumber, maxAttempts, collector ? { collector, client: 'GroqGPT120B' } : { client: 'GroqGPT120B' })
      } catch (e2) {
        if (!(e2 instanceof BamlValidationError)) {
          throw wrapAsLLMCallError(e2, 'ActorController', variables, startTime, collector)
        }
        try {
          action = await b.ActorController(user_message, intent, tools, attempts, context, fewShots, attemptNumber, maxAttempts, collector ? { collector, client: 'GroqFast' } : { client: 'GroqFast' })
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
    collector?: Collector
  ): Promise<CriticCallResult> => {
    const { b } = await import('../../../baml_client')
    const startTime = Date.now()

    // Convert ScriptExecutionEvent to Attempt format. See the actor adapter
    // above for why `toolName` is preferred over the legacy `'code-mode'`
    // placeholder.
    const attempts: Attempt[] = previous_attempts.map((event, i) => ({
      n: i + 1,
      action: {
        reasoning: '',
        tool_name: event.toolName ?? 'code-mode',
        tool_args: event.script,
        status: event.error ? 'error' : 'success',
        is_final: false
      },
      result: event.output,
      error: event.error ?? undefined,
      feedback: undefined
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
  result: string
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

/** GitHub controller */
export function createGitHubController(toolNames: string[]): ControllerFnWithLLMData {
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

/** Code-mode controller — drives a simpleLoop whose only tool is the MCP
 *  `code-mode` JS executor. The contextPrefix tells the LLM to author a JS
 *  script (passed via tool_args) that the gateway runs against the available
 *  MCP tools, then returns the script's output as a normal tool_result. */
export function createCodeModeController(toolNames: string[]): ControllerFnWithLLMData {
  return createLoopControllerAdapter(
    toolNames,
    'You compose JavaScript that orchestrates multiple MCP tools in a single turn. ' +
    'Call the `code-mode` tool with tool_args = { "script": "<your JS>" }. ' +
    'The script runs server-side with access to the gateway\'s tools; its return ' +
    'value comes back as the tool_result. Use Return when the result answers the user.'
  )
}
