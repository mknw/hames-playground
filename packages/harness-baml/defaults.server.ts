/**
 * defaults — the composition-root implementations of the two injected seams
 * (#225 Lane A6)
 *
 * `defaultSynthesize` (compactExecution's REQUIRED `synthesize`) and
 * `defaultSelector` (withReferences' REQUIRED `selector`) are REQUIRED config
 * — the patterns carry NO default import, because a `baml_client` import
 * under `packages/harness-patterns/` is what the lane's exit criterion
 * forbids. Their implementations live here, in the harness-baml companion at
 * the composition root, and `bamlPatterns()` supplies them (`synthesize` /
 * `selector` fields — the caller passes `baml.synthesize` / `baml.selector`
 * in the pattern's config).
 *
 * Both own their collectors (Lane A3), account through the shared extractors,
 * and resolve their client per call. Nothing else about their contracts
 * changed: "the four pre-existing injected functions and their overrides
 * carry over unchanged in kind."
 */

import { currentTimeBlock } from './time-block.server'
import { Collector } from '@boundaryml/baml'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import type {
  CompactExecutionInput,
  LoopIteration,
  LoopTurn,
  SelectorFn,
  SynthesisFn,
  SynthesisResult,
} from '@hames-ai/harness-patterns/types'
import { degradeToFit, trimToFit } from '@hames-ai/harness-patterns/token-budget.server'
import { isRouteTrace } from '@hames-ai/harness-patterns/patterns/decisionLoop-trace.server'
import { unspotlight } from '@hames-ai/harness-patterns/guard'
import { getContextWindow, resolveClientForRole } from './clients.server'
import {
  accountBamlCall,
  extractLLMCallData,
  warnIfCollectorEmpty,
  wrapAsLLMCallError,
} from './baml-adapters.server'
import { clientOverrideFor } from './clients.server'
import { escapeDataFence } from './data-fence'
import type { SynthesisReference } from './baml_client/types'

assertServerOnImport()

// ============================================================================
// defaultSynthesize — the composition-root implementation of compactExecution's
// REQUIRED `synthesize` config (supplied by bamlPatterns().synthesize)
// ============================================================================

/** Characters per token of a Synthesize prompt carrying route traces (#1032),
 *  for the trace fallback. Measured on the general-next eval's live trace
 *  prompts: 2.74 (212,018 prompt characters, 77,280 provider tokens) and 2.85
 *  (107,417 / 39,021 is 2.75; 26,131 / 9,177 is 2.85). 2.5 keeps a margin, so
 *  the fallback fires before the provider refuses. */
export const TRACE_CHARS_PER_TOKEN = 2.5

/** The Synthesize template's own text, in characters: the rendered prompt with
 *  no turn is about 3,000 (synthesis-before-507.json), with the trace rules a
 *  little more; rounded up. */
const SYNTHESIZE_BASE_CHARS = 4_000

/** What one turn adds around its result (`--- Turn n ---`, `Tool:`, `Result:`). */
const TURN_FRAME_CHARS = 60

export async function defaultSynthesize(input: CompactExecutionInput): Promise<SynthesisResult> {
  return synthesize(input, null)
}

/**
 * A `compactExecution` synthesizer that also carries the agent's GUIDE: the
 * deployment's own description of what the assistant can do and where its
 * example questions are, which the prompt answers "what can you do?", "help"
 * and "how do I start?" from. The agent builds the text from its real tool
 * list (never a hand-written capability list), so the answer cannot claim a
 * tool the deployment lacks. An empty guide is no guide: the request is then
 * byte-identical to `defaultSynthesize`'s.
 */
export function createSynthesizer(options: { guide?: string } = {}): SynthesisFn {
  const guide = options.guide?.trim() || null
  return (input) => synthesize(input, guide)
}

async function synthesize(
  input: CompactExecutionInput,
  guide: string | null,
): Promise<SynthesisResult> {
  // Dynamic import to avoid circular dependencies
  const { b } = await import('./guarded-client.server')
  const startTime = Date.now()
  // Lane A3: the implementation owns the collector — it used to be created by
  // the pattern and handed down, which is the handle the envelope deletes.
  const collector = new Collector('compactExecution')

  // Convert to LoopTurn format for BAML Synthesize
  const turns: LoopTurn[] = []
  // A decisionLoop route call's complete trace (#1032), by index: its compact
  // record's turn, for when the traces do not fit, and the route call's name.
  const compacts = new Map<number, { turn: LoopTurn; label: string }>()
  // The turns whose result is a route trace, by identity (trimming slices).
  const traceTurns = new Set<LoopTurn>()

  if (input.loopHistory) {
    // Convert loop history to LoopTurn array. Multi-call iterations carry
    // additional_calls through (their result is already the index-keyed map
    // holding every sub-call's tool + result/__error).
    //
    // `success: true` below is unconditional, which is only honest because
    // `buildSynthesisInputFromView` has already dropped the iterations that
    // have no result to report (the terminal `Return`, and actions whose
    // `tool_result` never arrived) — see the SA-H4 note there.
    for (const iteration of input.loopHistory.iterations) {
      const turn = loopTurn(iteration, iteration.result)
      if (iteration.compact && isRouteTrace(iteration.result)) {
        compacts.set(turns.length, {
          turn: loopTurn(iteration, iteration.compact.result),
          label: iteration.compact.label,
        })
        traceTurns.add(turn)
      }
      turns.push(turn)
    }
    // #614: every call failed and the controller then Returned an answer from
    // context — the history above is the failure, this is the answer.
    if (input.returnText) {
      turns.push({
        n: (input.loopHistory.iterations.at(-1)?.turn ?? -1) + 1,
        reasoning: 'Direct response',
        tool_result: { tool: 'response', result: input.returnText, success: true },
      })
    }
  } else if (input.response) {
    // Create a single turn with the response as a result
    turns.push({
      n: 0,
      reasoning: 'Direct response',
      tool_result: {
        tool: 'response',
        result: input.response,
        success: true,
      },
    })
  }

  // Trim oldest turns if they would overflow the compactExecution's context window
  // Trim against the window of the client this call will ACTUALLY use.
  // Hardcoding a chain name here ('SynthesizerFallback') missed the map, fell
  // through to a 16K default, and dropped real tool results before the LLM saw
  // them (see .harness-logs/neo4j-no-results.json).
  const contextWindow = getContextWindow(resolveClientForRole('compactExecution'))
  const serialize = (retained: LoopTurn[]) => {
    const refs = synthesisReferences(retained, traceTurns)
    return JSON.stringify(retained) + (refs.length ? JSON.stringify(refs) + ' '.repeat(800) : '')
  }
  // #1032: before any turn is dropped, the oldest route calls whose complete
  // trace does not fit fall back to their compact record, one at a time; the
  // trim below still drops whole turns when even that is not enough. Measured
  // as the prompt text the turns add, at the characters per token measured on
  // live traces — not the trim's chars/4, which read a 77k-token trace as 53k.
  const promptChars = (retained: LoopTurn[]) =>
    retained.reduce((n, t) => n + (t.tool_result?.result.length ?? 0) + TURN_FRAME_CHARS, 0) +
    JSON.stringify(synthesisReferences(retained, traceTurns)).length
  const fitted = degradeToFit(
    turns,
    (_, i) => compacts.get(i)?.turn,
    promptChars,
    SYNTHESIZE_BASE_CHARS + input.userMessage.length + (input.memoryContext?.length ?? 0),
    contextWindow,
    TRACE_CHARS_PER_TOKEN,
  )
  const fellBack = fitted.degraded.map((i) => compacts.get(i)!.label)
  const trimmedTurns = trimToFit(fitted.items, serialize, 500, contextWindow)
  const references = synthesisReferences(trimmedTurns, traceTurns)

  const variables = {
    userMessage: input.userMessage,
    intent: input.intent,
    turns: trimmedTurns,
    hasError: input.hasError ?? false,
    errorMessage: input.errorMessage,
    references,
    ...(guide ? { guide } : {}),
  }

  // Call with options always: the implementation-owned collector is in the
  // bag even when no tier override is, so the old with/without-opts dual call
  // is gone. `Synthesize` declares `SynthesizerAnthropic` (Sonnet 5 → Haiku
  // 4.5), overridden onto the self-hosted deployment when
  // `USE_SELF_DEPLOYED_INFERENCE=1` re-points the `compactExecution` role.
  const synthOpts = { ...clientOverrideFor('compactExecution'), collector }
  let content: string
  try {
    content = await b.Synthesize(
      input.userMessage,
      input.intent,
      trimmedTurns,
      input.hasError ?? false,
      input.errorMessage,
      // `memory_context` (#419 M9/M5a): `memoryRecall`'s block for this turn, or
      // null when nothing was recalled. Both optional slots are always passed:
      // the options bag follows references, and omitting either slot moves it
      // to the wrong parameter. Escaped because it renders inside a DATA
      // fence (data-fence.ts).
      input.memoryContext ? escapeDataFence(input.memoryContext) : null,
      references.length ? references : null,
      // `guide`: deployment-authored, so it renders in the leading system block
      // and is not fence-escaped; null renders nothing.
      guide,
      // `current_time`: the turn's clock block (time-block.server.ts), or null.
      currentTimeBlock(),
      synthOpts,
    )
  } catch (e) {
    // Throw contract: the raw response travels with the throw so the
    // pattern's error event keeps its drill-down.
    throw wrapAsLLMCallError(e, 'Synthesize', variables, startTime, collector)
  }

  // Route through the SHARED extractor rather than rebuilding LLMCallData here.
  // This site used to hand-roll it, and the copy had drifted: no cache-write
  // token bucket, no step `metrics`, and — the one that mattered — no call to
  // the usage chokepoint. `Synthesize` is a compactExecution-role call, i.e.
  // one of the three roles the self-hosted tier moves, and it is the LAST call
  // of a turn. Successes went uncounted while its failure path (below) counted,
  // so the preview header's on-prem share read high and its warm clock started
  // ticking from the controller's last call instead of this one. One extractor,
  // one accounting stamp, one stale-client guard (#154).
  const llmCall = extractLLMCallData(collector, 'Synthesize', variables, startTime, content)

  return { value: content, call: llmCall, ...(fellBack.length ? { fellBack } : {}) }
}

/** One iteration as a `Synthesize` turn, with `result` as its tool result. */
function loopTurn(iteration: LoopIteration, result: unknown): LoopTurn {
  return {
    n: iteration.turn,
    reasoning: iteration.action.reasoning,
    tool_call: {
      tool: iteration.action.tool_name,
      args: iteration.action.tool_args,
    },
    ...(iteration.action.additional_calls?.length
      ? { additional_calls: iteration.action.additional_calls }
      : {}),
    tool_result: {
      tool: iteration.action.tool_name,
      result: JSON.stringify(result),
      success: true,
    },
  }
}

/** Project retained retriever locators, without widening the event view.
 * Structured references require the retriever producer. The approved text seam
 * accepts only read-documents records whose every line has extractRetriever's
 * grammar; custom route ids receive no text-derived citations. Residual risk:
 * a read-documents result made entirely of forged record lines still passes.
 * Typed locator metadata on core records needs a separate owner API decision. */
function synthesisReferences(
  turns: LoopTurn[],
  /** The turns whose result is a decisionLoop route trace (#1032): their
   *  retriever calls carry the producer's structured references. Read on this
   *  code-written flag, never on a result's shape. */
  traceTurns: ReadonlySet<LoopTurn> = new Set(),
): SynthesisReference[] {
  const references = new Map<string, SynthesisReference>()
  const add = (reference: SynthesisReference) => {
    // Every projected string is rendered inside the template's DATA fence.
    const escaped = Object.fromEntries(
      Object.entries(reference).map(([key, value]) => [
        key,
        typeof value === 'string' ? escapeDataFence(value) : value,
      ]),
    ) as SynthesisReference
    references.set(JSON.stringify(escaped), escaped)
  }
  const pending: { tool: string; result: unknown }[] = []
  for (const turn of turns) {
    // defaultSynthesize constructs only successful result turns above.
    const toolResult = turn.tool_result!
    try {
      const result: unknown = JSON.parse(toolResult.result)
      if (traceTurns.has(turn)) {
        // The route trace's own steps, built from committed events: a call's
        // `tool` is the event's, so a fetched page cannot name the producer.
        if (!isRouteTrace(result)) continue
        for (const step of result.steps)
          for (const call of 'calls' in step ? step.calls : [])
            if (call.tool === 'retriever') pending.push({ tool: call.tool, result: call.result })
        continue
      }
      if (turn.additional_calls?.length) {
        // The call roster is transport metadata, not a tool-supplied JSON field.
        // A fetch result cannot manufacture a nested retriever producer.
        if (!result || typeof result !== 'object' || Array.isArray(result)) continue
        const tools = [toolResult.tool, ...turn.additional_calls.map((call) => call.tool_name)]
        for (const [index, tool] of tools.entries()) {
          const call = (result as Record<string, unknown>)[String(index + 1)]
          if (
            call &&
            typeof call === 'object' &&
            'tool' in call &&
            call.tool === tool &&
            'result' in call
          ) {
            pending.push({ tool, result: call.result })
          }
        }
      } else {
        pending.push({ tool: toolResult.tool, result })
      }
    } catch {
      // Direct response text is not a structured tool result.
    }
  }
  for (const { tool, result: value } of pending) {
    if (tool === 'read-documents' && typeof value === 'string') {
      // general-next fences its sanitized records. Remove only that framework
      // envelope; neutralized spans remain neutralized and excerpts stay out.
      const records = unspotlight(value)
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          if (!line.startsWith('- ')) return undefined
          // Select the first locator: an excerpt may contain a second one.
          const at = line.indexOf(' [doc ')
          if (at < 0) return line.indexOf(': ', 2) > 2 ? null : undefined
          const source = line.slice(2, at)
          if (!source.trim()) return undefined
          const locator = /^\[doc ([^,\]\r\n]+), chars (\d+)-(\d+)\]: /.exec(line.slice(at + 1))
          if (!locator || !locator[1].trim()) return undefined
          const startOffset = Number(locator[2])
          const endOffset = Number(locator[3])
          if (!Number.isSafeInteger(endOffset) || startOffset > endOffset) return undefined
          return { source, docId: locator[1], startOffset, endOffset }
        })
      if (!records.every((record) => record !== undefined)) continue
      for (const record of records) if (record) add(record)
    } else if (
      tool === 'retriever' &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      const object = value as Record<string, unknown>
      if (Array.isArray(object.references)) {
        for (const reference of object.references) {
          if (!reference || typeof reference !== 'object') continue
          const { source, docId, startOffset, endOffset } = reference
          if (typeof source !== 'string' || !source.trim()) continue
          const document =
            typeof docId === 'string' &&
            docId.trim() &&
            typeof startOffset === 'number' &&
            Number.isSafeInteger(startOffset) &&
            startOffset >= 0 &&
            typeof endOffset === 'number' &&
            Number.isSafeInteger(endOffset) &&
            endOffset >= startOffset
          if (document) add({ source, docId, startOffset, endOffset })
        }
      }
    }
  }
  return [...references.values()]
}

// ============================================================================
// defaultSelector — the composition-root implementation of withReferences'
// REQUIRED `selector` config (supplied by bamlPatterns().selector)
// ============================================================================

export const defaultSelector: SelectorFn = async (input) => {
  const { b } = await import('./guarded-client.server')
  const now = Date.now()
  const collector = new Collector('reference-selector')
  const candidates = input.candidates.map((c) => ({
    ref_id: c.ref_id,
    tool: c.tool,
    summary: c.summary,
    tool_args: c.tool_args ?? null,
    ts_offset_s: Math.max(0, Math.floor((now - c.ts) / 1000)),
  }))
  let result: Awaited<ReturnType<typeof b.ReferenceSelector>>
  try {
    result = await b.ReferenceSelector(
      input.intent,
      input.recentMessages.map((m) => ({ role: m.role, content: m.content })),
      candidates,
      // describe-tier, so a self_deployed tier decision moves it: the candidates it
      // ranks are summaries of this conversation's own tool results.
      { ...clientOverrideFor('describe'), collector },
    )
  } catch (e) {
    // Non-fatal upstream (the wrapper falls back to attaching nothing), but the
    // error event it emits is the ONLY record of the failure — wrap so the raw
    // response travels with it instead of dying inside this collector.
    throw wrapAsLLMCallError(
      e,
      'ReferenceSelector',
      { intent: input.intent, candidates },
      now,
      collector,
    )
  }
  // Nothing here reads the collector, but an empty one still means the options
  // object never reached BAML — i.e. the client override was dropped too (#154).
  warnIfCollectorEmpty(collector, 'ReferenceSelector')
  // The failure path accounts via `wrapAsLLMCallError` → `extractFailureLLMCallData`;
  // without this the SUCCESSES of a describe-tier role would be the half that
  // went uncounted, which biases the header's on-prem share upward.
  accountBamlCall(collector, 'ReferenceSelector')
  return {
    selected: result.selected.map((s) => ({
      ref_id: s.ref_id,
      reason: s.reason,
    })),
    reasoning: result.reasoning,
  }
}
