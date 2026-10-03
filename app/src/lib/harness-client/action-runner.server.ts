/**
 * Triggered Action Runner — Server Only
 *
 * In-process fire-and-forget execution for the `POST /api/agents/:id` endpoint
 * and, on exactly the same path, for routines (#131 — see
 * `lib/routines/dispatch.server.ts`). Callers differ only in the `source` they
 * seed the row with; the run itself is identical, so routine runs are ordinary
 * observable action rows with ordinary harness events.
 *
 * Deliberately NOT a `"use server"` module: every export of a `"use server"`
 * file becomes a client-callable RPC endpoint, and these functions take a
 * `userId` parameter (the route resolves it from the Bearer secret). Exposing
 * them as RPCs would let a client run an agent as any user. Keeping them here —
 * imported only by the route — means they're plain server-side functions.
 *
 * Flow (see `routes/api/agents/[id].ts`):
 *   1. Route authenticates + parses multipart, stores the recording in the
 *      Data Stash, then calls `seedActionRow` to insert the observable row.
 *   2. Route calls `runAgentInBackground` WITHOUT awaiting and returns 202.
 *   3. This module runs the turn to completion and persists the result, on the
 *      shared `runTurnAndPersist` implementation (`turn.server.ts`).
 */

import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { createContext, serializeContext } from '@hames-ai/harness-patterns'
import { type SessionData } from './session.server'
import { runTurnAndPersist } from './turn.server'
import {
  createConversation as dbCreateConversation,
  releaseConversationClaim as dbReleaseConversationClaim,
  type ConversationSource,
} from '../db/conversations.server'

assertServerOnImport()

/**
 * Trigger provenance, stored at `ctx.data.trigger` for triggered runs.
 * The recording itself lives in the Data Stash (keyed by the run id) — here we
 * only keep the raw transcription, the human-readable description, and a
 * pointer to the stored recording document.
 */
export interface ActionTrigger {
  /**
   * The harness input, verbatim. Named for the endpoint that introduced it
   * (`transcribed_command`); a routine run puts its configured input here so
   * seeding, replay, and the UI need no second shape.
   */
  transcribedCommand: string
  /** `short_description` — also lifted to the sticky `title` column. */
  shortDescription: string
  /** Data Stash document id of the stored `original_recording` (if stored). */
  recordingDocId?: string
  /** Original recording filename, for display. */
  recordingFilename?: string
  /** Original recording MIME type, for the audio player. */
  recordingMimeType?: string
  /** Set when a routine fired this run (#131): which routine, and on what. */
  routine?: { id: string; trigger: string }
}

/**
 * Insert the initial `action` row so the run is observable (status spinner)
 * the instant the route returns 202 — before the background harness completes.
 *
 * The seeded context is a minimal, valid `UnifiedContext` carrying just the
 * trigger command as the first user_message (so the thread replays it) plus
 * `data.trigger`. The background run produces its own context and overwrites
 * this blob via `saveSession`; the row's `kind`/`source`/sticky `title`
 * survive that overwrite (see `saveConversation`).
 *
 * The row is created CLAIMED for the run that is about to replace it (#458),
 * and the version returned is that claim: hand it to
 * {@link runAgentInBackground}. A user who opens the action and sends a message
 * while the run is in flight is a second turn on the row, and is refused.
 *
 * `source` is the only thing that distinguishes a POST-triggered action from a
 * routine-triggered one — both are `kind='action'`, both run identically.
 */
export async function seedActionRow(
  runId: string,
  userId: string,
  agentId: string,
  trigger: ActionTrigger,
  source: ConversationSource = 'post',
): Promise<string> {
  const ctx = createContext(trigger.transcribedCommand, { trigger } as Partial<SessionData>, runId)
  return dbCreateConversation({
    id: runId,
    userId,
    agentId,
    title: trigger.shortDescription || null,
    serializedContext: serializeContext(ctx),
    kind: 'action',
    source,
    status: 'running',
  })
}

/**
 * Run an agent to completion for a triggered action (POST endpoint or
 * routine), off the request path. The caller inserts the row (via
 * {@link seedActionRow}) and calls this WITHOUT awaiting, so the HTTP response
 * is already sent — a routine has no response at all.
 *
 * The run itself is `runTurnAndPersist` in `triggered` mode — the same
 * implementation the interactive path uses (#226 C5), which is what keeps the
 * two from drifting again. `triggered` is what makes it always a fresh first
 * run (never a `continueSession` of the seeded placeholder, which would
 * duplicate the user_message), skip title generation (the trigger's
 * `short_description` is the title), and take its settings from the defaults —
 * there is no request-scoped settings payload off the request path. Everything
 * else, including the post-answer `compactBulkData` pass and flipping a failed
 * row out of 'running', is shared.
 */
export async function runAgentInBackground(
  runId: string,
  userId: string,
  message: string,
  agentId: string,
  trigger: ActionTrigger,
  claimVersion: string,
): Promise<void> {
  await runTurnAndPersist({
    mode: 'triggered',
    sessionId: runId,
    userId,
    agentId,
    message,
    data: { trigger } as Partial<SessionData>,
    claimVersion,
  }).catch(async (err: unknown) => {
    // Nobody awaits this, so the rejection stops here — and it is not lost. A
    // run that failed inside the turn was already logged, flipped off
    // 'running' and released there (sf-M3). What reaches here unhandled is a
    // throw from BEFORE the turn's own catch — a tier this deployment refuses —
    // which used to leave the seeded row spinning, and would now also leave it
    // claimed for a lease. Fenced by the claim's version, so after the turn's
    // own release this changes nothing.
    console.error(`[action] run ${runId} failed:`, err)
    await dbReleaseConversationClaim(runId, userId, claimVersion, { failed: true }).catch(
      (releaseErr: unknown) =>
        console.error(`[action] could not flip run ${runId} to status='error':`, releaseErr),
    )
  })
}
