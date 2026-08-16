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
 *   3. This module runs the harness to completion and persists the result.
 */

import { assertServerOnImport } from '../harness-patterns/assert.server'
import { harness, createContext, serializeContext } from '../harness-patterns'
import { getOrBuildPatterns, saveSession, type SessionData } from './session.server'
import { runWithRequestContext } from './request-user.server'
import {
  saveConversation as dbSaveConversation,
  setConversationStatus as dbSetConversationStatus,
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
 * `source` is the only thing that distinguishes a POST-triggered action from a
 * routine-triggered one — both are `kind='action'`, both run identically.
 */
export async function seedActionRow(
  runId: string,
  userId: string,
  agentId: string,
  trigger: ActionTrigger,
  source: ConversationSource = 'post',
): Promise<void> {
  const ctx = createContext(trigger.transcribedCommand, { trigger } as Partial<SessionData>, runId)
  await dbSaveConversation({
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
 * is already sent — a routine has no response at all. On completion the
 * serialized context + lifted status are persisted; on an unexpected throw the
 * row is flipped to `error` so it never sticks on `running`.
 *
 * Always a fresh first run — it never `continueSession`s the seeded
 * placeholder (which would duplicate the user_message). Wrapped in
 * `runWithRequestContext` so pattern closures resolve the owner and the
 * conversation (the `runId` *is* this run's sessionId — the route uses it as
 * both the conversation id and the Data Stash session key); settings fall back
 * to `DEFAULT_SETTINGS` (no request-scoped settings off the request path). The
 * harness itself never throws (it catches internally and returns an `error`
 * status), so the catch here only guards pattern-construction failures.
 */
export async function runAgentInBackground(
  runId: string,
  userId: string,
  message: string,
  agentId: string,
  trigger: ActionTrigger,
): Promise<void> {
  try {
    await runWithRequestContext({ userId, sessionId: runId }, async () => {
      const patterns = await getOrBuildPatterns(runId, agentId)
      const agent = harness(...patterns)
      const result = await agent(message, runId, {
        trigger,
      } as Partial<SessionData>)
      await saveSession(runId, userId, agentId, result.serialized)
    })
  } catch (err) {
    console.error(`[action] background run failed for ${runId}:`, err)
    // The seeded row exists with status='running'; flip it so the UI doesn't
    // spin forever. Best-effort — a DB failure here is already logged above.
    await dbSetConversationStatus(runId, userId, 'error').catch(() => {})
  }
}
