/**
 * Title Generator — minimal one-pattern harness example.
 *
 * The smallest legal harness-patterns composition: a single `compactExecution`
 * pattern wired through `harness()`, with a custom `synthesize` fn that
 * calls a single BAML function (`GenerateConversationTitle`).
 *
 * Demonstrates that the harness is appropriate for one-shot LLM jobs, not
 * just multi-pattern agentic workflows. Used both in production (by
 * `/api/events` post-stream to generate the conversation title after the
 * first turn) and as a reference example for the harness-patterns library
 * extraction (this file is what consumers see when looking for the
 * "absolute minimum viable agent").
 *
 * Why `compactExecution({ mode: 'message' })`?
 *   In `mode: 'message'`, the compactExecution's input carries the latest user
 *   message and expects a string back from the optional `synthesize` fn.
 *   That's exactly the shape of "give the LLM the user's first message,
 *   get a title string." No loops, no tools, no router.
 *
 * Library boundary: imports only from `@hames-ai/harness-patterns`,
 * `@hames-ai/harness-baml` and its pre-generated client. No imports from
 * the host's components or other consumers —
 * keeps the agent extractable as a standalone npm package example.
 *
 * Deliberately NOT a `"use server"` module: every export of one becomes a
 * client-callable RPC, and `runFirstTurnTitleGen` / `runRegenerateTitle` take a
 * `userId` — so as RPCs they let the caller name the owner, which is the whole
 * `updateConversationTitle` scope. Same reasoning as `action-runner.server.ts`
 * and `turn.server.ts`; both of this module's callers (`turn.server.ts`,
 * `actions.server.ts`'s gated `regenerateConversationTitle`) resolve the user
 * themselves and pass it in, so nothing needed the directive.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { harness, compactExecution } from '@hames-ai/harness-patterns'
import { withUsageAccounting } from '@hames-ai/harness-baml'
import type { HarnessData, UnifiedContext, UserMessageEventData } from '@hames-ai/harness-patterns'
import { b } from '@hames-ai/harness-baml/baml_client'
import type { AgentDeps } from '../types'

// The directive is gone, so nothing else keeps this module off the client. The
// import-time assertion does.
assertServerOnImport()

/**
 * Data shape carried through the title agent's harness context. Has to
 * satisfy both `harness()`'s `HarnessData & Record<string, unknown>` and
 * `compactExecution()`'s `CompactExecutionData` (which expects optional `response`,
 * `synthesizedResponse`, `intent`, `loopHistory`). The empty index
 * signature wires up the structural subtype.
 */
interface TitleAgentData extends HarnessData {
  response?: string
  synthesizedResponse?: string
  [key: string]: unknown
}

// ============================================================================
// Validation & sanitization
// ============================================================================

const MAX_TITLE_CHARS = 50
const QUOTES = new Set(['"', "'", '`'])
const TRAILING_PUNCTUATION = new Set(['.', '!', '?'])
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u

/**
 * Best-effort cleanup of model output. The prompt asks for a bare title,
 * but small/fast models occasionally wrap in quotes, add a trailing
 * period, or echo a multiline preamble — strip all of those defensively.
 * Empty → returns null so the caller skips the DB write; overlong → capped.
 *
 * The first line is taken BEFORE the strips (#409): they act on the ends of
 * the string they are given, so run on a multi-line reply they cleaned the
 * end of the LAST line and `"Graph Styling Tips"\nHere is why…` kept its
 * closing quote.
 *
 * The strips peel one layer per pass, from the outside in (#454): a trailing
 * punctuation mark, or a quote PAIR that wraps the whole title. So punctuation
 * is stripped whether it sits outside the quotes (`"Title".`) or inside them
 * (`"Title."`), and a quote is only ever removed together with its partner —
 * `Review of "Dune"` keeps its closing quote. The punctuation test is a
 * character lookup, not `/[.!?]+$/`: that pattern backtracks quadratically on
 * a long run of `!` that does not end the string (CodeQL js/polynomial-redos).
 */
export function sanitizeTitle(raw: string): string | null {
  let title = raw.trim().split('\n')[0] // first line only
  for (;;) {
    title = title.trim()
    if (TRAILING_PUNCTUATION.has(title.slice(-1))) title = title.slice(0, -1)
    else if (wrapsWholeTitle(title)) title = title.slice(1, -1)
    else break
  }
  if (!title) return null
  return title.slice(0, MAX_TITLE_CHARS)
}

/**
 * True when the quote opening `title` is closed by the one ending it (#454).
 * Matching ends are not enough: `"Dune" and "Arrakis"` starts and ends with
 * `"`, but each end belongs to its own span. The first same-kind quote inside
 * decides it — one that opens a span (at the start, as in `""Mixed""`, or
 * after a space) leaves the outer pair wrapping; one that follows a word
 * closes the leading quote early. An apostrophe between two letters or digits
 * (`Dune's`) is not a quote.
 */
function wrapsWholeTitle(title: string): boolean {
  const q = title.charAt(0)
  if (!QUOTES.has(q) || !title.endsWith(q)) return false
  const inner = title.slice(1, -1)
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== q) continue
    const before = inner.charAt(i - 1)
    if (LETTER_OR_DIGIT.test(before) && LETTER_OR_DIGIT.test(inner.charAt(i + 1))) continue
    return i === 0 || /\s/.test(before)
  }
  return true
}

// ============================================================================
// The agent
// ============================================================================

/**
 * The whole agent is one pattern. `mode: 'message'` makes the compactExecution
 * a thin shell around our custom `synthesize` fn — no default BAML call,
 * no event tracking beyond `assistant_message`.
 *
 * A FACTORY, not a const: the two things the synthesize closure needs are
 * app-side policy (the tier override for the describe role) and app-side
 * persistence (`persistTitle`), both carried on `AgentDeps` — so the agent
 * composes once per call with the bag its caller holds. A bare consumer gets
 * a title agent that runs on the client the BAML function declares and does
 * not persist; the app's registry supplies both through its `agentDeps()`.
 */
export function createTitleAgent(deps: AgentDeps) {
  return harness<TitleAgentData>(
    compactExecution<TitleAgentData>({
      patternId: 'title-gen',
      mode: 'message',
      synthesize: async ({ userMessage }) => {
        // Collector for ACCOUNTING only (nothing here reads it): a title is a
        // describe-tier call, and a role that is not counted drops out of the
        // preview header's on-prem denominator rather than merely losing detail.
        // The override is the other half: a title is generated FROM the user's
        // first message, so on a verda-tier turn it belongs on the box with the
        // rest of the describe role. The override is injected app policy
        // (`AgentDeps.clientOverride`) — the package never imports the host's
        // client map; without it the call runs on the client the BAML function
        // declares.
        const raw = await withUsageAccounting('GenerateConversationTitle', (opts) =>
          b.GenerateConversationTitle(userMessage, {
            ...opts,
            ...(deps.clientOverride?.('describe') ?? {}),
          }),
        )
        // Lane A3: `SynthesisFn` returns the LLMResult envelope — the override
        // can now carry a call record the way the default always did. This one
        // accounts through `withUsageAccounting` instead (the record's channel),
        // so `call` stays undefined here.
        return { value: sanitizeTitle(raw) ?? '' }
      },
    }),
  )
}

// ============================================================================
// Production entry points
// ============================================================================

/** Extract the user_message events from a UnifiedContext, oldest first.
 *  Untyped data parameter so callers can pass `deserializeContext()` output
 *  (UnifiedContext<unknown>) without first widening it. */
function userMessages(ctx: UnifiedContext<unknown>): string[] {
  return (ctx.events ?? [])
    .filter((e) => e.type === 'user_message')
    .map((e) => (e.data as UserMessageEventData).content ?? '')
}

/** Returns true iff this turn was the first user_message of the conversation. */
function isFirstTurn(ctx: UnifiedContext<unknown>): boolean {
  return userMessages(ctx).length === 1
}

/**
 * First-turn entry point. Called from `/api/events` after the SSE `done`
 * frame, before the stream closes. Skips (returns null) when this isn't
 * the first turn — titles are only auto-generated once per conversation.
 *
 * Returns null when there is nothing to name (not the first turn, or the
 * model's title sanitizes to nothing) and REJECTS when the generation itself
 * failed — the LLM call threw, e.g. because the summarizer is down (#420).
 * Either way the heuristic title (set by `deriveTitle` in `saveConversation`)
 * stays in place; the rejection is what lets the caller SAY so, where it used
 * to be the same silent `null` as "nothing to name". No retry, no event of its
 * own: whether a failure is shown, and where, is the caller's call.
 */
export async function runFirstTurnTitleGen(
  ctx: UnifiedContext<unknown>,
  sessionId: string,
  userId: string,
  deps: AgentDeps,
): Promise<string | null> {
  if (!isFirstTurn(ctx)) return null
  const firstUserMessage = userMessages(ctx)[0]
  if (!firstUserMessage) return null
  return runTitleAgent(firstUserMessage, sessionId, userId, deps)
}

/**
 * On-demand entry point. No first-turn gate. Called from the sidebar's
 * regenerate-title button via `regenerateConversationTitle` server action
 * — re-runs the agent with the most recent user message in context (so
 * a chat that has drifted topic gets a refreshed title).
 *
 * Could be evolved to summarize across all messages, but keeps the same
 * one-pattern shape for now — first iteration: take the latest user message.
 */
export async function runRegenerateTitle(
  ctx: UnifiedContext<unknown>,
  sessionId: string,
  userId: string,
  deps: AgentDeps,
): Promise<string | null> {
  const messages = userMessages(ctx)
  const seed = messages[messages.length - 1] ?? messages[0]
  if (!seed) return null
  // The button's contract is unchanged: a failure leaves the title alone and
  // answers null. It is not a turn, so there is no transcript to warn in.
  return runTitleAgent(seed, sessionId, userId, deps).catch((err: unknown) => {
    console.error('[title-gen] failed:', err)
    return null
  })
}

/**
 * Shared helper — runs the agent and persists on success.
 *
 * REJECTS when the generation failed. The harness never throws for that — it
 * catches inside `compactExecution` and settles the run as `status: 'error'`
 * with an empty response — so the status is the signal, and reading only
 * `response` is how a summarizer outage used to look exactly like a blank
 * title. A failed PERSIST is still swallowed: the title was generated, and the
 * caller's question is whether there is one.
 */
async function runTitleAgent(
  userMessage: string,
  sessionId: string,
  userId: string,
  deps: AgentDeps,
): Promise<string | null> {
  // The agent generates its own throwaway sessionId for the harness
  // context; we pass a deterministic one for traceability in logs.
  const result = await createTitleAgent(deps)(userMessage, `title-gen-${sessionId}`)
  if (result.status === 'error') {
    throw new Error(result.context.error || 'title generation failed')
  }
  const title = sanitizeTitle(result.response)
  if (!title) return null
  if (!deps.persistTitle) {
    // Named, not silent: without a persistence channel the title exists only
    // as this call's return value. The app always supplies one.
    console.warn('[title-gen] no persistTitle supplied via AgentDeps — title not persisted')
    return title
  }
  try {
    await deps.persistTitle(sessionId, userId, title)
  } catch (err) {
    // The heuristic title remains in the DB row.
    console.error('[title-gen] could not persist the title:', err)
    return null
  }
  return title
}
