/**
 * One Turn — Server Only
 *
 * The single implementation of "run a harness turn for a conversation and
 * persist what it produced" (#226 C5). Three entry points used to own a copy of
 * this recipe — the SSE route (`routes/api/events.ts`), the interactive server
 * actions (`actions.server.ts`) and the triggered runner
 * (`action-runner.server.ts`) — and they had already drifted: the triggered path
 * silently skipped `compactBulkData`, so an action's next turn fed raw tool
 * payloads back into the prompt, the exact thing #83 added compaction to
 * prevent. Everything the entry points still differ on is now `mode`:
 *
 * | step                         | interactive | triggered | approval |
 * | ---------------------------- | ----------- | --------- | -------- |
 * | loads the stored context     | yes         | no        | required |
 * | continues it (vs. fresh run) | same agent  | never     | resumes  |
 * | pre-seeds a missing row      | yes (#105)  | no        | no       |
 * | `runWithRequestContext`      | yes         | yes       | yes      |
 * | `runWithSettings`            | yes         | yes       | yes      |
 * | first-turn title generation  | yes         | no        | no       |
 * | `saveSession`                | yes         | yes       | yes      |
 * | `compactBulkData` + re-save  | yes         | yes       | yes      |
 * | flips a failed row to 'error'| yes         | yes       | yes      |
 *
 * A triggered run never loads: its row is a placeholder written by
 * `seedActionRow` before the HTTP response, and continuing that would replay
 * the trigger command as a second user_message. It also skips title generation
 * on purpose — `seedActionRow` lifts the trigger's `short_description` into the
 * sticky `title` column, and `runFirstTurnTitleGen` writes *through* that
 * stickiness (`updateConversationTitle`), so generating one would overwrite the
 * description the caller supplied.
 *
 * Deliberately NOT a `"use server"` module: every export of one becomes a
 * client-callable RPC, and `runTurnAndPersist` takes a `userId`, so exposing it
 * would let a client run a turn as any user. Same reasoning as
 * `action-runner.server.ts` — callers authenticate and pass the result in.
 */

import { assertServerOnImport } from '../harness-patterns/assert.server'
import {
  harness,
  continueSession,
  resumeHarness,
  createContext,
  serializeContext,
  compactBulkData,
  type ConfiguredPattern,
  type ContextEvent,
  type HarnessResultScoped,
} from '../harness-patterns'
import {
  getOrBuildPatterns,
  loadSession,
  saveSession,
  type LoadedSession,
  type SessionData,
} from './session.server'
import { runWithRequestContext } from './request-user.server'
import { runWithSettings } from '../settings-context.server'
import type { HarnessSettings } from '../settings'
import { runFirstTurnTitleGen } from './agents/title-generator.server'
import {
  saveConversation as dbSaveConversation,
  setConversationStatus as dbSetConversationStatus,
  deriveTitle,
} from '../db/conversations.server'

assertServerOnImport()

/** Hard cap on how long a turn waits for the title agent. The SSE route holds
 *  its stream open across this window so the title can ride out as a
 *  `title_updated` frame; if the LLM exceeds it, the heuristic title
 *  (`deriveTitle`, kept by `saveConversation`'s COALESCE) stands. */
export const TITLE_GEN_TIMEOUT_MS = 3000

/**
 * Optional callbacks, in the order they fire. The SSE route implements all four
 * (they are its wire); every other caller passes none and gets the same turn
 * without the frames.
 */
export interface TurnHooks {
  /** Every harness event, live, as it is committed. Threaded into the run. */
  onEvent?: (event: ContextEvent) => void
  /** The finished result, once the turn is persisted. */
  onResult?: (result: HarnessResultScoped<SessionData>) => void
  /** An LLM-authored title, when this turn generated one. */
  onTitle?: (title: string) => void
  /** Nothing more will be delivered — the SSE route closes its stream here, so
   *  the trailing compaction runs after the user already has the answer. */
  onSettled?: () => void
}

interface TurnBase extends TurnHooks {
  sessionId: string
  userId: string
  /** Request-scoped settings. Absent off the request path (a triggered run),
   *  where the scope resolves `DEFAULT_SETTINGS`. */
  settings?: HarnessSettings
}

/**
 * One turn, in one of three shapes — the only axis the entry points differ on.
 */
export type TurnRequest =
  /** A user-driven turn: continues the stored context when the agent matches,
   *  pre-seeds the sidebar row for a brand-new conversation (#105), and names
   *  the conversation on its first turn. */
  | (TurnBase & { mode: 'interactive'; agentId: string; message: string })
  /** A triggered run (`POST /api/agents/:id`, a routine) against a row
   *  `seedActionRow` already wrote. Always a fresh first run. */
  | (TurnBase & {
      mode: 'triggered'
      agentId: string
      message: string
      /** Seeded onto the fresh context — the run's `trigger` provenance. */
      data?: Partial<SessionData>
    })
  /** Resume a context paused at an approval gate. The agent comes from the
   *  stored row, so there is nothing to pass. */
  | (TurnBase & { mode: 'approval'; approved: boolean })

/** The harness call this turn makes, once its patterns are built. */
type RunFn = (
  patterns: ConfiguredPattern<SessionData>[],
) => Promise<HarnessResultScoped<SessionData>>

/**
 * Run one turn and persist it. Resolves once the turn is saved and the title (if
 * any) is in; the trailing summarization is deliberately detached, so no caller
 * waits on it (it costs a describe-tier LLM round trip).
 *
 * Throws only what the caller should see: a session that cannot take this turn,
 * a pattern build that failed, a run that could not be persisted. Every such throw first flips
 * the conversation row out of `running` so no row spins forever (sf-M2/sf-M3),
 * and is logged here, so a fire-and-forget caller can swallow it silently.
 */
export async function runTurnAndPersist(
  req: TurnRequest,
): Promise<HarnessResultScoped<SessionData>> {
  const { sessionId, userId } = req
  // Establish the request scope so pattern closures and app-side tools that
  // need per-conversation context at runtime (a per-conversation allowlist
  // reader, `graph_file_ingest`'s Data Stash target) resolve the right user and
  // conversation without an explicit parameter. The settings scope is opened
  // here too, once, so the trailing compaction inherits it — the SSE route used
  // to fire that off outside the handler's await chain, where
  // `getRequestSettings()` silently fell back to DEFAULT_SETTINGS and ignored
  // the user's `maxResultForSummary` (SA-M13).
  return runWithRequestContext({ userId, sessionId }, () =>
    runWithSettings(req.settings, async () => {
      // A triggered run never loads (see the module docstring).
      const loaded = req.mode === 'triggered' ? null : await loadSession(sessionId, userId)
      const { agentId, run } = planTurn(req, loaded)

      if (req.mode === 'interactive' && !loaded) {
        // Brand-new conversation: persist the row BEFORE the run so it exists
        // in the sidebar for its whole first turn (#105) — previously the row
        // only appeared at run end, so an in-flight new chat was invisible (and
        // lost outright if the user clicked "+ New Chat" again, dropping its
        // placeholder). Mirrors `seedActionRow`: a minimal valid context
        // carrying the user message (so a mid-run reload still replays it) and
        // a title derived from the message; the run's own `saveSession` below
        // overwrites the blob, and the first-turn LLM title replaces the
        // derived one. Guarded on `!loaded`, so pre-seeded action rows (which
        // always exist before their run) are never touched.
        await dbSaveConversation({
          id: sessionId,
          userId,
          agentId,
          title: deriveTitle(req.message),
          serializedContext: serializeContext(createContext(req.message, undefined, sessionId)),
          status: 'running',
        })
      }

      const result = await runAndSave(req, agentId, run)

      req.onResult?.(result)
      if (req.mode === 'interactive') await generateTitle(req, result)
      req.onSettled?.()
      // Deliberately not awaited — see `compactAndSave`. Started from inside
      // both scopes, so it keeps them for its whole continuation.
      void compactAndSave(req, agentId, result)
      return result
    }),
  )
}

/**
 * What this turn runs, and under which agent — the whole mode dispatch, in one
 * place and before anything is written. Pure: the returned `run` is invoked by
 * {@link runAndSave} once the patterns exist.
 */
function planTurn(req: TurnRequest, loaded: LoadedSession | null): { agentId: string; run: RunFn } {
  if (req.mode === 'approval') {
    if (!loaded) throw new Error('No active session')
    // Nothing to resume unless the row is actually parked at the gate. Checked
    // here, before anything runs, so a stale approval (a double-click, a
    // reloaded tab) is a clean rejection instead of a `resumeHarness` throw from
    // inside the turn — which would flip a conversation that already completed
    // to 'error'.
    if (loaded.status !== 'paused') throw new Error('No pending approval')
    // An approval resumes under whatever agent the row was written with.
    const { agentId, serializedContext } = loaded
    return {
      agentId,
      run: (patterns) => resumeHarness(serializedContext, patterns, req.approved, req.onEvent),
    }
  }

  const { agentId, message, onEvent } = req
  // Continue only when the stored context belongs to the same agent. If the
  // user switched agent within an existing conversation, treat it as a fresh
  // conversation by ignoring the prior context: the UI is expected to mint a
  // new sessionId on agent change, but we double-guard here so a stale id can't
  // continue with a different agent's patterns. A triggered run passes no
  // stored context at all, so it always lands on the fresh branch.
  if (loaded && loaded.agentId === agentId) {
    const { serializedContext } = loaded
    return {
      agentId,
      run: (patterns) => continueSession(serializedContext, patterns, message, onEvent),
    }
  }

  const data = req.mode === 'triggered' ? req.data : undefined
  return {
    agentId,
    run: (patterns) => harness(...patterns)(message, req.sessionId, data, onEvent),
  }
}

/**
 * The turn itself: build the patterns, run the harness, persist the result.
 *
 * Anything that throws in here leaves the row this turn is responsible for at
 * status='running' forever — the row seeded above, or a pre-seeded action row.
 * The harness itself catches internally (it returns an `error` status rather
 * than throwing), so the realistic throws are pattern construction (a gateway
 * outage) and the final `saveSession`. Flip the row to 'error', then rethrow so
 * the caller still sees the failure (sf-M2).
 */
async function runAndSave(
  req: TurnRequest,
  agentId: string,
  run: RunFn,
): Promise<HarnessResultScoped<SessionData>> {
  const { sessionId, userId } = req
  try {
    const result = await run(await getOrBuildPatterns(sessionId, agentId))
    await saveSession(sessionId, userId, agentId, result.serialized)
    return result
  } catch (err) {
    console.error(`[turn] run failed for ${sessionId}:`, err)
    await dbSetConversationStatus(sessionId, userId, 'error').catch((statusErr: unknown) => {
      console.error(
        `[turn] could not flip ${sessionId} to status='error' — the row will keep showing as ` +
          'running:',
        statusErr,
      )
    })
    throw err
  }
}

/**
 * First-turn title generation. Synchronous w.r.t. the turn so the result can
 * ride out as a `title_updated` frame before the stream closes, with a hard cap
 * so a slow LLM never wedges it. `runFirstTurnTitleGen` is a no-op after the
 * first turn and swallows its own failures; the heuristic title stands whenever
 * this path yields nothing.
 */
async function generateTitle(
  req: TurnRequest,
  result: HarnessResultScoped<SessionData>,
): Promise<void> {
  await Promise.race([
    runFirstTurnTitleGen(result.context, req.sessionId, req.userId).then((title) => {
      if (title) req.onTitle?.(title)
    }),
    new Promise<void>((resolve) => setTimeout(resolve, TITLE_GEN_TIMEOUT_MS)),
  ]).catch((err) => console.error('[title-gen] failed:', err))
}

/**
 * Summarize this turn's tool results and re-persist them. Detached, and started
 * only after the answer has reached the caller (for the SSE route, after the
 * stream closed), so nobody waits on it — an approval that had to await this
 * would hold its response open for the whole describe call. Summaries live on the `tool_result` events and become
 * compact pointers on later turns (#83) — which is why a triggered run needs
 * this as much as an interactive one: a promoted action's next turn would
 * otherwise re-feed every raw payload into the prompt.
 *
 * The turn is already persisted, so a failure here costs summaries, not the
 * turn: logged, never rethrown, and it never flips the row to 'error'.
 * `compactBulkData` skips the persist callback entirely when there is nothing
 * to summarize, so a tool-less turn still writes once.
 */
async function compactAndSave(
  req: TurnRequest,
  agentId: string,
  result: HarnessResultScoped<SessionData>,
): Promise<void> {
  await compactBulkData(result.context, async () => {
    await saveSession(req.sessionId, req.userId, agentId, serializeContext(result.context))
  }).catch((err) => console.error('[summarize] background summarization failed:', err))
}
