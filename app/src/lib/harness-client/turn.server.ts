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
 * | step                         | interactive | triggered | resume |
 * | ---------------------------- | ----------- | --------- | ------ |
 * | claims the conversation      | yes         | its seed  | yes    |
 * | loads the stored context     | yes         | no        | required |
 * | continues it (vs. fresh run) | same agent  | never     | resumes |
 * | pre-seeds a missing row      | yes (#105)  | no        | refused |
 * | `runWithRequestContext`      | yes         | yes       | yes    |
 * | …`attended` (global skills)  | yes         | no        | yes [m8] |
 * | the run frame (all 5 slots)  | yes         | yes       | yes    |
 * | first-turn title generation  | yes         | no        | no     |
 * | `saveSession`                | yes         | yes       | yes    |
 * | `compactBulkData` + re-save  | yes         | yes       | yes    |
 * | flips a failed row to 'error'| yes         | yes       | only `chain-changed` [A4] |
 *
 * There is no approval mode any more (#433 S3). The boolean `resumeHarness`
 * it drove is gone: an answer now binds to the request it was issued for, and
 * resuming a paused run arrives as `mode: 'resume'` on the SSE route (#433 S7),
 * claiming through the same turn claim as the two modes above.
 *
 * ONE TURN PER CONVERSATION (#458). Every mode claims its conversation before
 * it runs and is the row's only writer until its save releases the claim; a
 * second turn meanwhile is refused with `ConversationBusyError`, which reaches
 * the user as an error frame. The lease, and why a turn is refused rather
 * than queued, are in `db/conversations.server.ts`.
 *
 * A triggered run never loads: its row is a placeholder written by
 * `seedActionRow` before the HTTP response, and continuing that would replay
 * the trigger command as a second user_message. The seed is also its claim —
 * created claimed, so no chat turn can take the row between the seed and the
 * run — and the run is handed the version it holds. It also skips title generation
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

import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import {
  harness,
  continueSession,
  resumeHarness,
  expireHitl,
  readHitl,
  createContext,
  serializeContext,
  deserializeContext,
  compactBulkData,
  createEvent,
  HitlAnswerError,
  type ConfiguredPattern,
  type ContextEvent,
  type HarnessResultScoped,
  type HitlDecidedBy,
  type HitlRequestEventData,
  type ToolResultEventData,
  type UnifiedContext,
  type WarningEventData,
} from '@hames-ai/harness-patterns'
import {
  getOrBuildPatterns,
  claimSession,
  saveSession,
  agentDeps,
  type LoadedSession,
  type SessionData,
} from './session.server'
import { runWithRequestContext, isAttendedRequest } from './request-user.server'
import { canonicalAgentId } from './agent-ids'
import { amendRunFrame, withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import { activeInferenceTier, assertInferenceTier } from '@hames-ai/harness-baml/clients.server'
import { DEFAULT_SETTINGS } from '../settings'
import { bamlPatterns } from '@hames-ai/harness-baml'
import type { InferenceTier } from '../inference/config.server'
import { resolveConversationTier } from '../inference/tier.server'
import { beginVerdaTurn, endVerdaTurn } from '../inference/verda-activity.server'
import { runWithColdStartWatch, type ColdStartEstimate } from '../inference/cold-start.server'
import { ensureVerdaAwake } from '../inference/wake.server'
import { recordTurn } from '../metrics/usage-recorder.server'
import type { HarnessSettings } from '../settings'
import { runFirstTurnTitleGen } from '@hames-ai/agents/agents/title-generator.server'
import {
  createConversation as dbCreateConversation,
  loadConversation as dbLoadConversation,
  releaseConversationClaim as dbReleaseConversationClaim,
  renewConversationClaim as dbRenewConversationClaim,
  updateConversationContextIfUnchanged as dbUpdateContextIfUnchanged,
  TURN_CLAIM_RENEW_MS,
  TURN_CLAIM_TTL_SECONDS,
  deriveTitle,
} from '../db/conversations.server'
import {
  closeHitlRows,
  deleteQuarantine,
  loadHitlAnswerRows,
  type HitlAnswerValue,
} from '../db/hitl.server'

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
 * One turn, in one of two shapes — the only axis the entry points differ on.
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
      /** The version `seedActionRow` returned: the claim this run holds. */
      claimVersion: string
    })
  /** Resume a run the previous turn left `paused` on a HITL request (#433
   *  S7). The agent comes from the stored row, so there is nothing to pass —
   *  and the ANSWERS do not ride the request either: the answer RPC
   *  (`lib/hitl/actions.server.ts`) recorded them in `hitl_requests`, and this
   *  turn reads them there, filtered against `readHitl(blob).pending`, which is
   *  what makes an answer bind to this pause and nothing else (P1). */
  | (TurnBase & { mode: 'resume' })

/** A turn request whose run is a fresh or continued CHAT turn — the two modes
 *  {@link planTurn} plans. A `resume` turn is planned by {@link planResume}. */
type ChatTurnRequest = Extract<TurnRequest, { mode: 'interactive' | 'triggered' }>

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
  // Inference tier — the per-CONVERSATION switch, resolved ONCE per turn.
  //
  // This is the whole mechanism behind the control beside the agent selector:
  // the conversation's own tier (else the user's last-used, else the preview
  // default — `lib/inference/tier.server.ts` owns that order) opens an
  // AsyncLocalStorage scope, and every adapter deep inside the run reads it
  // through `clientOverrideFor(role)` — a PER-CALL client override in the BAML
  // options bag, which is the seam `clients.server.ts` owns.
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
  // Resolved here rather than at each entry point so both modes
  // (interactive, triggered) get it from one place, and a failure to
  // read it falls back to the deployment default rather than failing the turn.
  //
  // Per conversation since the switch moved off the header: a turn's tier is
  // now a fact about the thread it belongs to, which is what lets an Anthropic
  // chat start while a private one is still waking. It is read at TURN start,
  // so a flip lands on the next turn and never changes provider underneath a
  // run already in flight.
  const tier =
    (await resolveConversationTier(sessionId, userId).catch((err: unknown) => {
      console.error(`[turn] could not read the inference tier for ${sessionId}:`, err)
      return undefined
    })) ?? activeInferenceTier()
  // Refuse a tier this deployment cannot take, BEFORE anything runs and before
  // the row below records it. This is the check `runWithInferenceTier` used to
  // make on the way into its scope; the scope is now core's generic run frame,
  // which cannot know what 'verda' means, so the fail-closed gate stayed in
  // `@hames-ai/harness-baml` and the host calls it (issue #374, D1).
  assertInferenceTier(tier)

  // Establish the request scope so pattern closures and app-side tools that
  // need per-conversation context at runtime (a per-conversation allowlist
  // reader, `graph_file_ingest`'s Data Stash target) resolve the right user and
  // conversation without an explicit parameter.
  //
  // THE RUN FRAME IS OPENED HERE, not at the harness entry point, and the
  // reason is the work this turn STARTS and does not await. The title agent and
  // the detached `compactAndSave` below both make describe-tier calls and both
  // read the user's `maxResultForSummary`; started from inside the frame, they
  // keep it for their whole continuation. Opened at the entry point instead,
  // the frame would close when the harness returned and a detached
  // summarization would silently change provider and budget halfway through a
  // turn — which is the SA-M13 failure, in the one place it costs a wrong model
  // rather than a wrong number. Core allows this: `harness()` /
  // `continueSession` / `resumeHarness` JOIN an open frame instead of opening a
  // second one, provided they bring no slots of their own, which is why the
  // `run` closures in `planTurn` pass neither a frame nor an `onEvent`.
  //
  // TWO of the frame's five slots are filled here, and they replace the two
  // scopes this function used to stack: `config` was `runWithSettings` and
  // `inference` was `runWithInferenceTier`. Both are properties of the TURN, so
  // both belong at turn level — that is the whole SA-M13 reason above. The
  // app's FULL settings object seeds `config` rather than the library's six
  // knobs: that is byte-for-byte what the app's own reader answered before, and
  // a slot holding a projection would silently drop every app-only field a
  // pattern might read. (An earlier draft justified it by claiming
  // `with-sandbox.server.ts` dereferences `.sandbox` unguarded — it does not,
  // it reads `DEFAULT_SANDBOX_SETTINGS`. The property is still worth keeping;
  // the reason was wrong.)
  //
  // `live` IS NOT ONE OF THEM, and the asymmetry is the point. A listener is a
  // property of ONE RUN, not of the turn: `enterRun` hands a nested entry the
  // enclosing frame's listener (which is what lets `continueSession` be called
  // bare), and this turn starts a SECOND run inside itself — the first-turn
  // title agent, whose own events are its internal detail. At turn level the
  // listener followed it, so a failed title generation emitted the title
  // agent's raw `error` event into the frame, after `done` and before the stream
  // closed, and the user got an inline ERROR bubble for a side task. It is
  // scoped to the main run in {@link runAndSave} instead. (A failed title IS
  // shown since #420 — as one deliberate `warning` from `generateTitle`, not by
  // this leak.) The sidecars keep
  // `config` and `inference`, which is what SA-M13 needed; what they must not
  // keep is the wire to the user's transcript.
  //
  // `guard` and `transports` stay empty at run level: `withInjectionGuard` and
  // `withSandbox` amend the frame per pattern, and the run-level guard manifest
  // is #242's half of this work.
  //
  // `attended` says whether a person is waiting on this turn, and it is a
  // positive claim: only the mode a user drives sets it. A routine or a
  // `POST /api/agents/:id` run acts before anyone reads it, so it mounts the
  // owner's own skills and never another user's global ones (owner decision,
  // 2026-10-03: "Routines can mount private skills, not global ones for now").
  // A mode added later is unattended until someone decides otherwise — except
  // that S7 decided for the one it added: a RESUME is a person answering (m8),
  // so it is attended too, and it is the same value here — not a second
  // derivation — that `isAttendedRequest()` below hands the run frame's `hitl`
  // slot.
  const attended = req.mode === 'interactive' || req.mode === 'resume'
  return runWithRequestContext({ userId, sessionId, attended }, () =>
    withRunFrame(
      {
        config: req.settings ?? DEFAULT_SETTINGS,
        inference: { tier },
      },
      async () => {
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
      },
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
  // Refused here, before anything runs, when another turn holds the row.
  const held = await claimTurn(req, tier)
  // The lease is renewed for as long as this turn holds it, so a slow turn
  // keeps its conversation and only a dead process loses it.
  const renewal = setInterval(() => {
    dbRenewConversationClaim(sessionId, userId, held.version).then(
      (renewed) => {
        if (renewed || held.released) return
        clearInterval(renewal)
        console.error(
          `[turn] lost the claim on ${sessionId}: another turn took it after it lapsed, so ` +
            'this turn will not be saved.',
        )
      },
      // `%s`, not interpolation: with a second argument the first is a format
      // string, and the session id comes from the request.
      (err: unknown) => console.error('[turn] could not renew the claim on %s:', sessionId, err),
    )
  }, TURN_CLAIM_RENEW_MS)
  renewal.unref?.()

  let ran: { agentId: string; result: HarnessResultScoped<SessionData>; saved: SavedTurn }
  try {
    ran =
      req.mode === 'resume'
        ? await runResumeAndSave(req, tier, held)
        : await (async () => {
            const { agentId, run } = planTurn(req, held.loaded)
            return { agentId, ...(await runAndSave(req, agentId, run, tier, held)) }
          })()
  } finally {
    clearInterval(renewal)
    // Every exit path lets go. The save released the claim in the statement
    // that wrote the turn, and a failed run released it in `runAndSave`'s
    // catch; what is left is a throw after the claim and before `runAndSave`
    // took over, which must not keep the conversation for a lease.
    if (!held.released) {
      await dbReleaseConversationClaim(sessionId, userId, held.version).catch((err: unknown) =>
        console.error(
          `[turn] could not release %s; it refuses new turns for up to ${TURN_CLAIM_TTL_SECONDS}s:`,
          sessionId,
          err,
        ),
      )
    }
  }
  const { result, saved } = ran

  req.onResult?.(result)
  const titleWarned = req.mode === 'interactive' ? await generateTitle(req, result) : false
  req.onSettled?.()
  // Deliberately not awaited — see `compactAndSave`. Started from inside
  // all three scopes, so it keeps them for its whole continuation (the
  // tier scope included: a detached summarization must not silently
  // change provider halfway through a turn).
  void compactAndSave(req, result, titleWarned, saved)
  return result
}

/** This turn's hold on its conversation. */
interface HeldTurn {
  /** The stored context the claim covers, or null for a fresh run. */
  loaded: LoadedSession | null
  /** The context version the claim holds — what every write of this turn names. */
  version: string
  /** Set once the claim is let go, by the save or by a failure. */
  released: boolean
}

/** What the end-of-turn save wrote: the trailing pass writes on top of it. */
interface SavedTurn {
  version: string
  /** Events in the saved context; anything after them was added later. */
  eventCount: number
}

/**
 * Take the conversation for this turn, or refuse. Throws
 * `ConversationBusyError` (from the repository) while another turn holds it.
 */
async function claimTurn(req: TurnRequest, tier: InferenceTier): Promise<HeldTurn> {
  const { sessionId, userId } = req
  // A triggered run never loads (see the module docstring), and its claim was
  // taken by the seed it is about to replace.
  if (req.mode === 'triggered') return { loaded: null, version: req.claimVersion, released: false }

  const loaded = await claimSession(sessionId, userId)
  if (loaded) return { loaded, version: loaded.version, released: false }
  // A resume is refused, never pre-seeded: the conversation it resumes is an
  // existing row by construction, so an unknown id here is not this user's
  // session (re-pin of the deleted approval tests: refuse a session the user
  // does not own, flipping nothing). The claim was not taken — `claimSession`
  // returns null only when the row does not exist under this user.
  if (req.mode === 'resume') throw new Error('No active session')

  // Brand-new conversation: persist the row BEFORE the run so it exists in the
  // sidebar for its whole first turn (#105) — previously the row only appeared
  // at run end, so an in-flight new chat was invisible (and lost outright if
  // the user clicked "+ New Chat" again, dropping its placeholder). Mirrors
  // `seedActionRow`: a minimal valid context carrying the user message (so a
  // mid-run reload still replays it) and a title derived from the message; the
  // run's own `saveSession` overwrites the blob, and the first-turn LLM title
  // replaces the derived one. Created claimed, so a second first message on the
  // same new chat is refused rather than racing this one.
  const version = await dbCreateConversation({
    id: sessionId,
    userId,
    agentId: canonicalAgentId(req.agentId),
    title: deriveTitle(req.message),
    serializedContext: serializeContext(createContext(req.message, undefined, sessionId)),
    status: 'running',
    // The tier this turn resolved, recorded on the row it is creating. For a
    // brand-new chat that value came from the user's last-used seed, and
    // writing it here is what stops the conversation following a later flip
    // made in a different thread.
    inferenceTier: tier,
  })
  return { loaded: null, version, released: false }
}

/**
 * What this turn runs, and under which agent — the whole mode dispatch, in one
 * place and before anything but the claim is written. Pure: the returned `run`
 * is invoked by {@link runAndSave} once the patterns exist. A throw here
 * leaves the claim to {@link runOneTurn}'s `finally`.
 */
function planTurn(
  req: ChatTurnRequest,
  loaded: LoadedSession | null,
): { agentId: string; run: RunFn } {
  const { message } = req
  // The id the REQUEST names is mapped forward the way `loadSession` maps the
  // stored one. A tab loaded before an agent was renamed keeps sending the old
  // id, and comparing that raw against the canonical stored id would read as
  // an agent switch and start the conversation over — replacing its history
  // with this one message on the next save.
  const agentId = canonicalAgentId(req.agentId)
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
      run: (patterns) => continueSession(serializedContext, patterns, message),
    }
  }

  const data = req.mode === 'triggered' ? req.data : undefined
  return {
    agentId,
    run: (patterns) => harness(...patterns)(message, req.sessionId, data),
  }
}

/**
 * The turn itself: build the patterns, run the harness, persist the result.
 *
 * Anything that throws in here leaves the row this turn is responsible for at
 * status='running' forever — the row seeded above, or a pre-seeded action row.
 * The harness itself catches internally (it returns an `error` status rather
 * than throwing), so the realistic throws are pattern construction (a gateway
 * outage) and the final `saveSession` — including its refusal when the claim
 * lapsed and another turn took the row. Flip the row to 'error' and release
 * the claim, then rethrow so the caller still sees the failure (sf-M2). The
 * flip is fenced by the claim's version, so a turn that lost the row flips
 * nothing that is now another turn's.
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
  held: HeldTurn,
): Promise<{ result: HarnessResultScoped<SessionData>; saved: SavedTurn }> {
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
    // THE LISTENER'S SCOPE IS THIS RUN, not the turn — see the frame opened in
    // `runTurnAndPersist`. Amending it here rather than filling the turn frame's
    // slot is what keeps the title agent and the detached compaction, both
    // started after this returns, off the user's wire. The same amend supplies
    // the run's `hitl` slot (#433): the frame the turn opened carries none, and
    // a harness entry point only supplies one when IT opens the frame — it
    // joins ours instead, so without this line a gate would throw `HitlRequestError`
    // the moment it asked. This is the host's amend around its main run, the
    // one place the slot may be supplied (F7); the value is the turn's own
    // `attended` (m8), read from the request scope `runTurnAndPersist` wrote —
    // not a second derivation.
    const patterns = await getOrBuildPatterns(sessionId, agentId)
    const result = await amendRunFrame(
      { live: req.onEvent, hitl: { attended: isAttendedRequest() } },
      () => run(patterns),
    )
    // Written at the version the claim holds, releasing it in the same
    // statement. The tier goes with the save so a row that has none yet — an
    // action row `seedActionRow` wrote before any tier was resolved, a legacy
    // row the backfill left alone — records the one it just ran on.
    // `saveConversation` COALESCEs it, so this never overwrites a flip.
    const version = await saveSession(sessionId, userId, agentId, result.serialized, {
      version: held.version,
      inferenceTier: tier,
    })
    held.released = true
    return { result, saved: { version, eventCount: result.context.events.length } }
  } catch (err) {
    console.error(`[turn] run failed for ${sessionId}:`, err)
    held.released = true
    await dbReleaseConversationClaim(sessionId, userId, held.version, { failed: true }).catch(
      (statusErr: unknown) => {
        console.error(
          "[turn] could not flip %s to status='error' — the row will keep showing as running, " +
            `and refuses new turns for up to ${TURN_CLAIM_TTL_SECONDS}s:`,
          sessionId,
          statusErr,
        )
      },
    )
    throw err
  }
}

// ============================================================================
// Resume (#433 S7): an answer continues the paused run
// ============================================================================

/** Past its `expiresAt`? The same predicate core's resume check uses, so a
 *  request this pre-check sends to expiry is one core would refuse as
 *  `expired`. */
const pastDue = (r: HitlRequestEventData, now: number): boolean =>
  r.expiresAt !== undefined && now >= r.expiresAt

/** What a resume will run with: the answers that bind, and whether every one
 *  of them ends the run. */
interface ResumePlan {
  readonly answers: Record<string, HitlAnswerValue>
  /** Every answer chose an option with `stopsRun` — `resumeHarness` will end
   *  the run `done` and re-enter nothing. */
  readonly stopOnly: boolean
}

/** `planResume`'s early exit: a past-due request closed the run. */
interface ExpiredRun {
  readonly serialized: string
  readonly expired: readonly string[]
  readonly superseded: readonly string[]
}

/** The result shape of a run the expiry path ended — `expireHitl` already
 *  wrote the closing response and the fixed assistant message into the
 *  context, so this is the same envelope a harness result carries. */
function resultFromSerialized(serialized: string): HarnessResultScoped<SessionData> {
  const ctx = deserializeContext<SessionData>(serialized)
  const response = (ctx.data as { response?: string } | undefined)?.response ?? ''
  // `scopedResult` is the package's own construction site, but it re-serializes
  // and stamps a wall-clock duration; this envelope keeps the stored blob
  // verbatim, so it narrows by hand the way `scopedResult` does [F18].
  const base = { response, data: ctx.data, duration_ms: 0, context: ctx, serialized }
  if (ctx.status === 'paused') {
    return { ...base, status: 'paused', pending: readHitl(ctx).pending }
  }
  return { ...base, status: ctx.status }
}

/**
 * Sync the ANSWER ROWS against `ctx` and return the answers still in
 * transit — the spec's §2 table rule, in one place. The blob is
 * authoritative; the table is transport. For every row still `answered`:
 *
 *  - its request is PENDING here → this resume's answer, returned;
 *  - its request has a response here → the answer is spent, and the row
 *    closes the way the response decided it: `person` → `applied`, `expired`
 *    → `expired`, `superseded` → `superseded`;
 *  - neither → its request is gone from this run (a new message superseded
 *    it) → `superseded`. Never `applied` — a decision nobody made is not a
 *    decision that landed.
 *
 * Every close DELETES the row's payload (F20b) — the personal data the
 * request carried goes when the request does, whatever closed it.
 */
async function syncAnswerRows(
  ctx: Pick<UnifiedContext, 'events'>,
  sessionId: string,
  userId: string,
): Promise<Record<string, HitlAnswerValue>> {
  const pending = new Set(readHitl(ctx).pending.map((r) => r.requestId))
  const decidedBy = new Map<string, HitlDecidedBy>()
  for (const event of ctx.events) {
    if (event.type !== 'hitl_response') continue
    const d = event.data as { v?: number; requestId?: unknown; by?: unknown }
    if (d.v !== 1 || typeof d.requestId !== 'string' || typeof d.by !== 'string') continue
    if (!decidedBy.has(d.requestId)) decidedBy.set(d.requestId, d.by as HitlDecidedBy)
  }
  const rows = await loadHitlAnswerRows(sessionId, userId)
  const answers: Record<string, HitlAnswerValue> = {}
  const applied: string[] = []
  const expired: string[] = []
  const superseded: string[] = []
  for (const row of rows) {
    if (pending.has(row.requestId)) {
      if (row.answer) answers[row.requestId] = row.answer
      continue
    }
    const by = decidedBy.get(row.requestId)
    if (by === 'person') applied.push(row.requestId)
    else if (by === 'expired') expired.push(row.requestId)
    else superseded.push(row.requestId)
  }
  await closeHitlRows(applied, userId, 'applied')
  await closeHitlRows(expired, userId, 'expired')
  await closeHitlRows(superseded, userId, 'superseded')
  return answers
}

/**
 * The resume's checks and inputs, BEFORE anything runs — the §6 host sketch's
 * steps 1–2 plus the pre-wake refusals. Everything reads the CLAIMED blob and
 * the answer table; a refusal throws `HitlAnswerError` before the wake and
 * before `resolve`, so it pays no cold start (the delta review's suggestion
 * on C1) and records nothing. Core's `resumeHarness` re-checks every one of
 * these on its own copy — pre-checking is not trusting, it is refusing
 * cheaply.
 */
async function planResume(
  loaded: LoadedSession,
  tier: InferenceTier,
  sessionId: string,
  userId: string,
): Promise<ResumePlan | { readonly expired: ExpiredRun }> {
  const ctx = deserializeContext<SessionData>(loaded.serializedContext)
  // The re-pins of the deleted approval tests: refuse anything that is not a
  // paused run waiting on a person, releasing the claim and flipping nothing
  // (the caller's catch releases; the `paused` restore applies only to a row
  // that was paused).
  if (ctx.status !== 'paused') {
    throw new HitlAnswerError('not-paused', `the context is '${ctx.status}', not paused`)
  }
  const pending = readHitl(ctx).pending
  if (pending.length === 0) {
    throw new HitlAnswerError('no-pending', 'the context is paused, but waits on no request')
  }

  // EXPIRY, before the wake. A past-due request closes the run (`expireHitl`
  // records the closings, ends it `done` with a fixed response and re-enters
  // nothing, and closes the run's other pending requests as superseded —
  // #481 F2), so there is nothing to wake and nothing to re-enter.
  const now = Date.now()
  if (pending.some((r) => pastDue(r, now))) {
    const closed = expireHitl(loaded.serializedContext, now)
    if (closed) return { expired: closed, answers: {}, stopOnly: false }
  }

  // TIER, before the wake (C1 + the delta review's suggestion): a resume
  // continues the turn the pause interrupted, on the tier that turn ran on.
  // The refusal message names both ways out for the person (flip the tier
  // back, or send a new message, which supersedes the request).
  for (const r of pending) {
    if (r.tier !== tier) {
      throw new HitlAnswerError(
        'tier-changed',
        `request ${r.requestId} was raised on another inference tier than this resume ` +
          'runs on. Switch the tier back, or send a new message (which supersedes the request).',
        r.requestId,
      )
    }
  }

  const answers = await syncAnswerRows(ctx, sessionId, userId)

  // MISSING-ANSWER before the wake, for the same reason as the tier check:
  // core refuses the same answer set (its step 4), and a refusal that
  // arrives after a cold start is a wake the box billed for nothing.
  for (const r of pending) {
    if (!(r.requestId in answers)) {
      throw new HitlAnswerError(
        'missing-answer',
        `request ${r.requestId} is not answered`,
        r.requestId,
      )
    }
  }

  // STOP-ONLY (A5): when every answer chose an option that ends the run,
  // `resumeHarness` ends it `done` and re-enters nothing — no model call, so
  // no wake either (the spec's letter: "a resume whose answers all stop the
  // run skips the wake").
  const stopOnly = pending.every((r) =>
    r.options.some((o) => o.id === answers[r.requestId].choice && o.stopsRun === true),
  )
  return { answers, stopOnly }
}

/**
 * The resume turn: claim (taken in `claimTurn`) → plan → wake (unless
 * stop-only) → `resumeHarness` → save at the claimed version → close the
 * spent answer rows. Shares `runOneTurn`'s trailing pass and its claim
 * release; its catch differs from `runAndSave`'s on purpose (A4/F19c):
 *
 * **ONLY `chain-changed` ends in `error`, and its ending is DURABLE.** The
 * row a resume claims says `paused`, and everything else that can fail here
 * leaves the person able to try again: a refusal records nothing (core's
 * steps 1–6 checked before any `resolve`), a `resolve` that threw records
 * nothing (nothing durable was written), and a wake or pattern-build
 * failure never reached the run. So the release RESTORES `paused` when the
 * row it claimed said `paused`, and `chain-changed` alone — the one refusal
 * that says this paused run can never continue — flips to `error` and
 * stamps `hitl_ended_at`, so the m3 load-restore exempts it (owner item 1 on
 * review 6004200697) rather than resurrecting `paused` from a blob that
 * still says `paused` on every load.
 */
async function runResumeAndSave(
  req: Extract<TurnRequest, { mode: 'resume' }>,
  tier: InferenceTier,
  held: HeldTurn,
): Promise<{ agentId: string; result: HarnessResultScoped<SessionData>; saved: SavedTurn }> {
  const { sessionId, userId } = req
  // `claimTurn` refuses a resume that loads no session, so this is never null
  // here; the assertion keeps the type honest without a cast.
  const loaded = held.loaded
  if (!loaded) throw new Error('No active session')
  try {
    const plan = await planResume(loaded, tier, sessionId, userId)

    if ('expired' in plan) {
      // The run is over and its record says so: save the closed blob at the
      // claimed version (the conditional write F1 asks for — this turn holds
      // the claim, so it is the only writer), then close the spent answer
      // rows against it. No wake, no patterns, no `resumeHarness`.
      const result = resultFromSerialized(plan.expired.serialized)
      const version = await saveSession(
        sessionId,
        userId,
        loaded.agentId,
        plan.expired.serialized,
        {
          version: held.version,
          inferenceTier: tier,
        },
      )
      held.released = true
      await syncAnswerRows(
        deserializeContext<SessionData>(plan.expired.serialized),
        sessionId,
        userId,
      ).catch((err: unknown) =>
        // `%s`, not interpolation — the session id comes from the request, and
        // with a second argument the first is a format string (#470's rule;
        // CodeQL's tainted-format-string pin agrees).
        console.error('[hitl] could not close the expired answer rows of %s:', sessionId, err),
      )
      return {
        agentId: loaded.agentId,
        result,
        saved: { version, eventCount: result.context.events.length },
      }
    }

    // WAKE THEN RUN — the same rule as `runAndSave`, minus the stop-only
    // case (A5): a resume whose answers all stop the run makes no model
    // call, so it must not pay a cold start either.
    if (tier === 'verda' && !plan.stopOnly) await ensureVerdaAwake()
    const patterns = await getOrBuildPatterns(sessionId, loaded.agentId)
    const result = await amendRunFrame(
      { live: req.onEvent, hitl: { attended: isAttendedRequest() } },
      () =>
        resumeHarness(loaded.serializedContext, patterns, plan.answers, {
          principal: userId,
          // The host's one side effect (F4): drop the held content — DELETE is
          // idempotent per requestId, the Δ4 rule. The row's PAYLOAD purge is
          // deliberately NOT here: it happens after the save, when the
          // answer is durable, in `syncAnswerRows`.
          resolve: (request) => deleteQuarantine(request.requestId, userId),
        }),
    )
    // Written at the version the claim holds, releasing it in the same
    // statement — every context write of this turn names that version (F1).
    const version = await saveSession(sessionId, userId, loaded.agentId, result.serialized, {
      version: held.version,
      inferenceTier: tier,
    })
    held.released = true
    // Answered ⇒ payload deleted (F20b): the answer is durable, so the rows
    // close and their payloads go. A failure here costs hygiene, not the
    // turn — the blob is saved and the claim released, so it is logged and
    // the rows close on the next sync or the expiry sweep.
    await syncAnswerRows(result.context, sessionId, userId).catch((err: unknown) =>
      console.error('[hitl] could not close the spent answer rows of %s:', sessionId, err),
    )
    return {
      agentId: loaded.agentId,
      result,
      saved: { version, eventCount: result.context.events.length },
    }
  } catch (err) {
    console.error(`[turn] resume failed for %s:`, sessionId, err)
    held.released = true
    const failed = err instanceof HitlAnswerError && err.code === 'chain-changed'
    await dbReleaseConversationClaim(sessionId, userId, held.version, {
      failed,
      // The A4 restore applies only to a row that was paused — a row this
      // resume claimed at anything else ('done', say) is released without a
      // flip, which is the re-pin of the old approval refusal.
      paused: !failed && loaded.status === 'paused',
      // And `chain-changed` is TERMINAL for the pause (owner item 1 on review
      // 6004200697): the release stamps `hitl_ended_at` beside the `error`,
      // so the m3 load-restore exempts this row instead of resurrecting
      // `paused` from a blob that still says `paused`. Every other failure
      // leaves the pause alive, and the marker unset.
      hitlTerminal: failed,
    }).catch((releaseErr: unknown) => {
      console.error(
        `[turn] could not release %s; it refuses new turns for up to ${TURN_CLAIM_TTL_SECONDS}s:`,
        sessionId,
        releaseErr,
      )
    })
    throw err
  }
}

/**
 * First-turn title generation. Synchronous w.r.t. the turn so the result can
 * ride out as a `title_updated` frame before the stream closes, with a hard cap
 * so a slow LLM never wedges it. `runFirstTurnTitleGen` is a no-op after the
 * first turn; the heuristic title stands whenever this path yields nothing.
 *
 * THE CAP IS ALSO HOW LONG THE ANSWER WAITS. `done` has been sent by now, but
 * the client paints the answer when the stream closes, so this window delays
 * the visible reply by up to `TITLE_GEN_TIMEOUT_MS`. That cost predates #420 —
 * it is the price of the title riding the stream — and nothing may be added to
 * it: the warning below is persisted by the trailing `compactAndSave`, after
 * the stream has closed, never by a write in here.
 *
 * A generation that FAILS is said out loud (#420), and is always logged.
 *  - Inside the cap: one `warning` event, sent on the still-open stream and
 *    pushed into the context, which `compactAndSave` then persists (the
 *    returned `true` is what makes it save a turn that had no tool results).
 *  - After the cap: the stream is closed, so it is logged and pushed into the
 *    context in memory only. It reaches the next load if the trailing save has
 *    not happened yet, and is otherwise only in the log — it never gets a save
 *    of its own, because a write after the turn has settled races the next
 *    turn's write to the same row, and losing a turn is worse than losing a
 *    notice.
 * Deliberately not the title agent's own `error` event — that one stays inside
 * its throwaway context and off the user's wire (see the `live` note in
 * `runTurnAndPersist`); this is one deliberate notice in its place. A
 * generation still running at the cap says nothing until it ends: it may yet
 * land, and `persistTitle` writes it through whenever it does.
 *
 * @returns whether a warning was sent on the stream (and so must be persisted).
 */
async function generateTitle(
  req: TurnRequest,
  result: HarnessResultScoped<SessionData>,
): Promise<boolean> {
  let streamOpen = true
  let warned = false
  const recordFailure = (err: unknown): void => {
    console.error('[title-gen] failed:', err)
    const warning = createEvent('warning', 'title-gen', {
      task: 'title',
      message: 'The conversation title could not be generated.',
      fallback: 'It is named after the start of your first message; ↻ in the sidebar retries.',
      error: err instanceof Error ? err.message : String(err),
    } satisfies WarningEventData)
    result.context.events.push(warning)
    if (!streamOpen) return
    warned = true
    req.onEvent?.(warning)
  }
  await Promise.race([
    runFirstTurnTitleGen(result.context, req.sessionId, req.userId, agentDeps()).then((title) => {
      if (title) req.onTitle?.(title)
    }, recordFailure),
    new Promise<void>((resolve) => setTimeout(resolve, TITLE_GEN_TIMEOUT_MS)),
  ])
  streamOpen = false
  return warned
}

/**
 * Summarize this turn's tool results and re-persist them. Detached, and started
 * only after the answer has reached the caller (for the SSE route, after the
 * stream closed), so nobody waits on it — a turn that had to await this
 * would hold its response open for the whole describe call. Summaries live on the `tool_result` events and become
 * compact pointers on later turns (#83) — which is why a triggered run needs
 * this as much as an interactive one: a promoted action's next turn would
 * otherwise re-feed every raw payload into the prompt.
 *
 * The turn is already persisted, so a failure here costs summaries, not the
 * turn: logged, never rethrown, and it never flips the row to 'error'. A
 * summarizer that fails is recorded by `compactBulkData` as a `warning` event in
 * the context this re-saves (#420), which is how it reaches the transcript and
 * the observability panel on the conversation's next load.
 * `compactBulkData` skips the persist callback entirely when there is nothing
 * to summarize, so a tool-less turn still writes once — unless `mustPersist`
 * says this turn's context gained something after its own save: the title
 * warning (see `generateTitle`), whose only write this is. One save, here,
 * rather than a second writer racing this one over the same row: a context
 * serialized before the summaries land would overwrite them.
 *
 * The save itself is {@link saveTrailingPass}: it runs after the turn let go of
 * the conversation, so the next turn may already have written over the row.
 */
async function compactAndSave(
  req: TurnRequest,
  result: HarnessResultScoped<SessionData>,
  mustPersist: boolean,
  saved: SavedTurn,
): Promise<void> {
  let persisted = false
  const persist = async (): Promise<void> => {
    persisted = true
    await saveTrailingPass(req, result.context, saved)
  }
  // Lane A6: the two describe implementations are REQUIRED injected config on
  // compactBulkData — `bamlPatterns()` supplies the describe-tier pair.
  await compactBulkData(result.context, persist, bamlPatterns()).catch((err) =>
    console.error('[summarize] background summarization failed:', err),
  )
  if (mustPersist && !persisted) {
    await persist().catch((err: unknown) =>
      console.error('[title-gen] could not persist the warning:', err),
    )
  }
}

/** How many times the trailing save writes before it gives up. */
const TRAILING_SAVE_ATTEMPTS = 3

/**
 * Persist what the trailing pass added to this turn — summaries on its tool
 * results, and the notices appended after its save — WITHOUT overwriting
 * anything written since that save.
 *
 * The first attempt writes this turn's whole context at the version its own
 * save produced, which is the common case and identical to what it always
 * wrote. When the row has moved on — a newer turn finished, a flag was
 * flipped — it re-reads the row and applies ONLY its own additions to it
 * ({@link mergeTrailingPass}), then writes at the version it just read.
 * Re-applying is the smallest correct option: the pass owns two narrow things,
 * a `summary` field per event id and a few appended events, so a merge is
 * exact, where retrying the whole blob could only ever overwrite.
 *
 * It gives up, with a log line, when the row will not hold still or a newer
 * turn holds it: that turn is about to write the context it loaded when it
 * started, so a write now would be overwritten or would refuse that turn's
 * save. What is lost then is derived data — later turns see those results raw
 * rather than summarized (#83's cost), and a notice is only in the log — never
 * a recorded event.
 */
async function saveTrailingPass(
  req: TurnRequest,
  ours: UnifiedContext<SessionData>,
  saved: SavedTurn,
): Promise<void> {
  const { sessionId, userId } = req
  let next = ours
  let version = saved.version
  for (let attempt = 1; ; attempt++) {
    if (await dbUpdateContextIfUnchanged(sessionId, userId, serializeContext(next), version)) {
      return
    }
    if (attempt === TRAILING_SAVE_ATTEMPTS) break
    const fresh = await dbLoadConversation(sessionId, userId)
    if (!fresh) {
      console.warn(`[summarize] ${sessionId} is gone; this turn's summaries have nowhere to go.`)
      return
    }
    next = mergeTrailingPass(
      deserializeContext<SessionData>(fresh.serializedContext),
      ours,
      saved.eventCount,
    )
    version = fresh.version
  }
  console.error(
    `[summarize] ${sessionId} moved on under every attempt, or a newer turn holds it: this ` +
      "turn's summaries and notices are not saved.",
  )
}

/**
 * Apply what a trailing pass added to `ours` onto `fresh`, a newer copy of the
 * same conversation, and return `fresh`.
 *
 * Exactly two things move, and nothing else of `ours` does — `fresh` may carry
 * a flag flip or a whole later turn, and those win:
 *  - a `summary` on a tool result, written only where `fresh` has none, and
 *    only onto THE RESULT IT SUMMARIZES: same id, a `tool_result`, and the
 *    same `result`. The id alone is not enough. It would restore a summary
 *    onto a result substituted after the pass read it — #433 S7 depends on
 *    this line, because its Δ2 `heldBy` placeholder is exactly that, and a
 *    stale summary on it would mask its resolution — and ids are 6 random
 *    characters, so two results may share one. The summary is assigned on
 *    the matched event itself, not through `enrichToolResult`'s first-id
 *    lookup, which could write it onto a different event with the same id;
 *  - the events `ours` gained after its own save (the first `savedCount` are
 *    what that save wrote), each inserted after the event it followed, so a
 *    notice lands at the end of its own turn rather than after a newer one.
 */
export function mergeTrailingPass<T>(
  fresh: UnifiedContext<T>,
  ours: UnifiedContext<T>,
  savedCount: number,
): UnifiedContext<T> {
  const present = new Set(fresh.events.map((e) => e.id))
  for (const event of ours.events) {
    if (event.type !== 'tool_result') continue
    const { summary, result } = event.data as ToolResultEventData
    if (!summary || !event.id) continue
    const summarized = JSON.stringify(result)
    const target = fresh.events.find(
      (e) =>
        e.id === event.id &&
        e.type === 'tool_result' &&
        // #433 Δ2: never onto a substituted event. The same-result comparison
        // below already refuses it (a resume's substitution REPLACED the result
        // this summary describes), but `heldBy` names the class of event — the
        // outcome of a HITL decision — rather than relying on the comparison
        // to notice the swap. A summary restored here would mask the outcome
        // for the re-entered controller and every later turn.
        (e.data as ToolResultEventData).heldBy === undefined &&
        JSON.stringify((e.data as ToolResultEventData).result) === summarized,
    )
    if (target && !(target.data as ToolResultEventData).summary) {
      ;(target.data as ToolResultEventData).summary = summary
    }
  }
  let anchor = ours.events[savedCount - 1]?.id
  for (const event of ours.events.slice(savedCount)) {
    if (event.id === undefined || !present.has(event.id)) {
      const at = anchor === undefined ? -1 : fresh.events.findIndex((e) => e.id === anchor)
      fresh.events.splice(at === -1 ? fresh.events.length : at + 1, 0, event)
      present.add(event.id)
    }
    anchor = event.id
  }
  return fresh
}
