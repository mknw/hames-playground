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
 * | `runWithInferenceTier`       | yes         | yes       | yes      |
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
import {
  activeInferenceTier,
  runWithInferenceTier,
  type InferenceTier,
} from '../harness-patterns/clients.server'
import { resolveInferenceTier } from '../db/user-prefs.server'
import { beginVerdaTurn, endVerdaTurn } from '../inference/verda-activity.server'
import { runWithColdStartWatch, type ColdStartEstimate } from '../inference/cold-start.server'
import { ensureVerdaAwake } from '../inference/wake.server'
import { recordTurn } from '../metrics/usage-recorder.server'
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
 * Optional callbacks, in the order they fire. The SSE route implements all five
 * (they are its wire); every other caller passes none and gets the same turn
 * without the frames.
 */
export interface TurnHooks {
  /** Every harness event, live, as it is committed. Threaded into the run. */
  onEvent?: (event: ContextEvent) => void
  /**
   * This turn has started waiting on a self-hosted box that is not up, and the
   * next thing the user sees will be minutes away. Fires at most once per turn,
   * only on the verda tier, and only when nothing says the box is warm — see
   * `inference/cold-start.server.ts`. Absent means "do not compute it": no
   * hook, no watch.
   */
  onWarming?: (estimate: ColdStartEstimate) => void
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
  // ---------------------------------------------------------------------------
  // Inference tier — the per-user switch, resolved ONCE per turn.
  //
  // This is the whole mechanism behind the header's "Private (Verda)" /
  // "Anthropic" control: the user's stored preference (or the preview default)
  // opens an AsyncLocalStorage scope, and every adapter deep inside the run
  // reads it through `clientOverrideFor(role)` — a PER-CALL client override in
  // the BAML options bag, which is the seam `clients.server.ts` owns.
  //
  // It is emphatically NOT a re-pointing of the chains in `baml_src/`. That
  // class of edit moves whole ROLES at once and would move the injection screen
  // along with summarization, because the two declare the same chain in BAML and
  // are separate only in `CLIENT_BY_ROLE`. The switch moves exactly the roles
  // `VERDA_CLIENT_BY_ROLE` lists, which since 2026-08-26 is every one of them —
  // the screen included, on the owner's rule that no call made under the private
  // tier may be sent to any public AI provider. Two decisions, two lines, and
  // that is the whole point of the seam: on the same day `describe` was moved to
  // a 4B summarizer and the `screen` was NOT, which a chain edit could not have
  // expressed at all.
  //
  // The scope also covers what the turn STARTS and does not await — the title
  // and the detached `compactAndSave` below both make describe-tier calls, and
  // both keep this tier through their continuation (see the note at
  // `compactAndSave`). Before the widening that was bookkeeping; now it decides
  // which machine this turn's tool results are summarized on.
  //
  // Resolved here rather than at each entry point so all three modes
  // (interactive, triggered, approval) get it from one place, and a failure to
  // read the preference falls back to the default rather than failing the turn.
  const tier =
    (await resolveInferenceTier(userId).catch((err: unknown) => {
      console.error(`[turn] could not read the inference-tier preference for ${userId}:`, err)
      return undefined
    })) ?? activeInferenceTier()
  // Establish the request scope so pattern closures and app-side tools that
  // need per-conversation context at runtime (a per-conversation allowlist
  // reader, `graph_file_ingest`'s Data Stash target) resolve the right user and
  // conversation without an explicit parameter. The settings scope is opened
  // here too, once, so the trailing compaction inherits it — the SSE route used
  // to fire that off outside the handler's await chain, where
  // `getRequestSettings()` silently fell back to DEFAULT_SETTINGS and ignored
  // the user's `maxResultForSummary` (SA-M13).
  return runWithRequestContext({ userId, sessionId }, () =>
    runWithSettings(req.settings, () =>
      runWithInferenceTier(tier, async () => {
        // The header's warm indicator and the global counters both learn about
        // this turn here — one place, so no entry point can forget. `finally`
        // is load-bearing: a turn that throws must not leave the in-flight
        // gauge pinned, which would show "running" forever.
        if (tier === 'verda') beginVerdaTurn()
        recordTurn(tier)
        try {
          // The cold-start watch is armed HERE rather than at the first
          // verda-bound call, because the thing that detects one is several
          // layers down and takes no parameters. Only for a verda-tier turn whose
          // caller wants the notice — the SSE route is the only one that does,
          // since it is the only entry point with a live wire to a person
          // waiting. A turn with no watch still wakes; the ping is not a UI
          // feature.
          //
          // The WAKE itself is deliberately NOT here. It used to be, and that
          // put a routine network failure outside every `catch` that owns a
          // conversation row — see {@link runAndSave}, which is where it moved
          // and why.
          const run = (): Promise<HarnessResultScoped<SessionData>> => runOneTurn(req, tier)
          const watched = tier === 'verda' && req.onWarming
          return watched ? await runWithColdStartWatch(watched, run) : await run()
        } finally {
          if (tier === 'verda') endVerdaTurn()
        }
      }),
    ),
  )
}

/**
 * The turn itself, inside all three scopes. Split out only so the scope stack
 * above stays readable — it is not a second entry point and nothing else calls
 * it.
 */
async function runOneTurn(
  req: TurnRequest,
  tier: InferenceTier,
): Promise<HarnessResultScoped<SessionData>> {
  const { sessionId, userId } = req
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

  const result = await runAndSave(req, agentId, run, tier)

  req.onResult?.(result)
  if (req.mode === 'interactive') await generateTitle(req, result)
  req.onSettled?.()
  // Deliberately not awaited — see `compactAndSave`. Started from inside
  // all three scopes, so it keeps them for its whole continuation (the
  // tier scope included: a detached summarization must not silently
  // change provider halfway through a turn).
  void compactAndSave(req, agentId, result)
  return result
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
 *
 * THE WAKE IS ONE OF THOSE THROWS, and it is why this function takes a tier at
 * all. It ran one layer up until #279's review, outside this `catch`, and the
 * two paths that cost is worth naming because neither is exotic:
 *
 *  - A TRIGGERED run's row already exists — `seedActionRow` writes it at
 *    `status:'running'` before `runAgentInBackground`, which then swallows the
 *    rejection with `.catch(() => {})` on the strength of "runTurnAndPersist
 *    logs the failure and flips the seeded row off running". Outside this
 *    `catch` neither happened, so a routine that met a box which would not wake
 *    left a row spinning forever with no trace anywhere.
 *  - An INTERACTIVE first message is worse in the other direction: the wake ran
 *    before {@link runOneTurn}'s `!loaded` pre-seed, so nothing was persisted at
 *    all and a reload lost the user's message — where a failed first BAML call
 *    leaves an errored conversation in the sidebar (#105's property).
 *
 * Both are the same defect: a routine, network-dependent failure on the tier
 * that is the deployment DEFAULT, against a box whose documented behaviour is to
 * be asleep. #278's reaper is a 90-minute backstop (it is derived from the
 * per-call ceiling this PR halved, so it moved with it), not the designed path.
 * So the ping happens here, first, inside the try — every entry point ends its
 * row in an error state, chat or not.
 *
 * ORDER, and both halves of it are deliberate. The row is seeded BEFORE the
 * wake (that is the interactive fix), and the wake comes before
 * `getOrBuildPatterns` so the private tier's first act is still to get the box
 * up rather than to build patterns against a gateway while the GPU sleeps. The
 * announcement seam is unchanged: `runTurnAndPersist` still opens the cold-start
 * watch around all of this, so `ensureVerdaAwake`'s `noteVerdaCallStarting` sees
 * the listener and the `warming` frame still lands INSIDE the wait.
 */
async function runAndSave(
  req: TurnRequest,
  agentId: string,
  run: RunFn,
  tier: InferenceTier,
): Promise<HarnessResultScoped<SessionData>> {
  const { sessionId, userId } = req
  try {
    // WAKE THEN RUN. The self-hosted box scales to zero, so on the private tier
    // the turn's first job is to get it up — throwaway requests polled until one
    // is answered, the whole poll shared with any concurrent turn, and the
    // harness does not start until one of them answers
    // (`inference/wake.server.ts` carries the reasoning, and it is what let the
    // BAML client's timeout drop from ten minutes to three). A wake that fails
    // THROWS, which is what ends the turn as a visible error rather than handing
    // the harness a box that is not there — see the SSE route's `catch`, and the
    // `catch` below for the row.
    if (tier === 'verda') await ensureVerdaAwake()
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
