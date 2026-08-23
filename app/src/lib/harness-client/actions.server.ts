/**
 * Server Actions for Frontend
 *
 * Top-level "use server" module for SolidStart server actions.
 * Wraps harness-patterns for use in Solid components.
 *
 * Persistence: every public action authenticates the caller via the Entra
 * session (or VITE_DEV_BYPASS_AUTH) and scopes session reads/writes to that user.
 * The full UnifiedContext is stored as a single JSONB blob in Postgres —
 * see `lib/db/conversations.server.ts`.
 */
'use server'

import {
  harness,
  resumeHarness,
  continueSession,
  createContext,
  serializeContext,
  type HarnessResultScoped,
  type ContextEvent,
} from '../harness-patterns'
import {
  getOrBuildPatterns,
  loadSession,
  saveSession,
  deleteSession,
  evictPatterns,
  type SessionData,
} from './session.server'
import { getAgent, getAgentMetadata } from './registry.server'
import {
  listConversations as dbListConversations,
  promoteConversation as dbPromoteConversation,
  saveConversation as dbSaveConversation,
  deleteConversations as dbDeleteConversations,
  deriveTitle,
  setConversationStatus as dbSetConversationStatus,
  type ConversationKind,
  type ConversationSource,
  type ConversationStatus,
} from '../db/conversations.server'
import type { HarnessSettings } from '../settings'
import { runWithSettings } from '../settings-context.server'
import { getAuthenticatedUser } from '../auth/server'
import { BYPASS_USER, isBypassEnabled } from '../auth/dev-bypass'
import { runWithRequestContext } from './request-user.server'

// ============================================================================
// Auth helper
// ============================================================================

/**
 * Resolve the current user. In dev with the bypass enabled, returns the
 * shared `BYPASS_USER` so persistence works without a real Entra session.
 * See `lib/auth/dev-bypass.ts` for the gate.
 */
async function requireUser(): Promise<{ id: string; email: string }> {
  if (isBypassEnabled()) {
    return { id: BYPASS_USER.id, email: BYPASS_USER.email }
  }
  const u = await getAuthenticatedUser()
  return { id: u.id, email: u.email }
}

// ============================================================================
// Server Actions
// ============================================================================

/**
 * Process a user message using the default agent.
 */
export async function processMessage(
  sessionId: string,
  message: string,
): Promise<HarnessResultScoped<SessionData>> {
  return processMessageWithAgent(sessionId, message, 'default')
}

/**
 * Process a user message using a specific agent.
 */
export async function processMessageWithAgent(
  sessionId: string,
  message: string,
  agentId: string = 'default',
): Promise<HarnessResultScoped<SessionData>> {
  const user = await requireUser()
  return runTurn(sessionId, user.id, message, agentId)
}

/**
 * Process a message with streaming events via callback.
 * Used by the SSE endpoint for real-time event delivery.
 */
export async function processMessageStreaming(
  sessionId: string,
  message: string,
  agentId: string = 'default',
  onEvent: (event: ContextEvent) => void,
  settings?: HarnessSettings,
): Promise<HarnessResultScoped<SessionData>> {
  const user = await requireUser()
  return runWithSettings(settings, () => runTurn(sessionId, user.id, message, agentId, onEvent))
}

async function runTurn(
  sessionId: string,
  userId: string,
  message: string,
  agentId: string,
  onEvent?: (event: ContextEvent) => void,
): Promise<HarnessResultScoped<SessionData>> {
  // Establish the request scope so pattern closures and app-side tools that
  // need per-conversation context at runtime (code-mode's tool-allowlist
  // reader, `graph_file_ingest`'s Data Stash target) resolve the right user and
  // conversation without an explicit parameter.
  return runWithRequestContext({ userId, sessionId }, async () => {
    // If the user switched agent within an existing conversation, treat it as
    // a fresh conversation by ignoring the prior serialized context. The UI is
    // expected to mint a new sessionId on agent change, but we double-guard
    // here so a stale id can't continue with a different agent's patterns.
    const loaded = await loadSession(sessionId, userId)

    // Brand-new conversation: persist the row BEFORE the run so it exists in
    // the sidebar for its whole first turn (#105) — previously the row only
    // appeared at run end, so an in-flight new chat was invisible (and lost
    // outright if the user clicked "+ New Chat" again, dropping its
    // placeholder). Mirrors `seedActionRow`: a minimal valid context carrying
    // the user message (so a mid-run reload still replays it) and a title
    // derived from the message; the run's own `saveSession` below overwrites
    // the blob, and the first-turn LLM title replaces the derived one via the
    // existing `title_updated` path. Guarded on `!loaded`, so pre-seeded
    // action rows (which always exist before their run) are never touched.
    if (!loaded) {
      await dbSaveConversation({
        id: sessionId,
        userId,
        agentId,
        title: deriveTitle(message),
        serializedContext: serializeContext(createContext(message, undefined, sessionId)),
        status: 'running',
      })
    }

    // Anything that throws from here on leaves the row this function is
    // responsible for at status='running' forever — the seeded new-conversation
    // row above, or a pre-seeded action row. The harness itself catches
    // internally, so the realistic throws are pattern construction (gateway
    // outage) and the final `saveSession`, and the triggered path already
    // guards exactly this (`action-runner.server.ts`). Mirror it: flip to
    // 'error', then rethrow so the caller still sees the failure (sf-M2).
    try {
      const patterns = await getOrBuildPatterns(sessionId, agentId)

      let result: HarnessResultScoped<SessionData>
      if (loaded && loaded.agentId === agentId) {
        result = await continueSession(loaded.serializedContext, patterns, message, onEvent)
      } else {
        const agent = harness(...patterns)
        result = await agent(message, sessionId, undefined, onEvent)
      }

      await saveSession(sessionId, userId, agentId, result.serialized)
      return result
    } catch (err) {
      console.error(`[turn] run failed for ${sessionId}:`, err)
      await dbSetConversationStatus(sessionId, userId, 'error').catch((statusErr: unknown) => {
        console.error(
          `[turn] could not flip ${sessionId} to status='error' — the row will keep showing ` +
            'as running:',
          statusErr,
        )
      })
      throw err
    }
  })
}

/**
 * Promote an action to a regular conversation (flip `kind`). Bound to the
 * sidebar's confirm-on-send gate. Scoped to the current user. Self-
 * authenticating — safe to expose as a server action.
 */
export async function promoteAction(sessionId: string): Promise<void> {
  const user = await requireUser()
  await dbPromoteConversation(sessionId, user.id)
}

/**
 * Approve a pending action.
 */
export async function approveAction(sessionId: string): Promise<HarnessResultScoped<SessionData>> {
  return resolveApproval(sessionId, true)
}

/**
 * Reject a pending action.
 */
export async function rejectAction(
  sessionId: string,
  _reason?: string,
): Promise<HarnessResultScoped<SessionData>> {
  return resolveApproval(sessionId, false)
}

async function resolveApproval(
  sessionId: string,
  approved: boolean,
): Promise<HarnessResultScoped<SessionData>> {
  const user = await requireUser()
  const loaded = await loadSession(sessionId, user.id)
  if (!loaded) {
    throw new Error('No active session')
  }
  return runWithRequestContext({ userId: user.id, sessionId }, async () => {
    const patterns = await getOrBuildPatterns(sessionId, loaded.agentId)
    const result = await resumeHarness(loaded.serializedContext, patterns, approved)
    await saveSession(sessionId, user.id, loaded.agentId, result.serialized)
    return result
  })
}

/**
 * Clear a session — deletes the row from Postgres and evicts the in-memory
 * pattern cache.
 */
export async function clearSession(sessionId: string): Promise<void> {
  const user = await requireUser()
  await deleteSession(sessionId, user.id)
}

/**
 * Delete a batch of conversations for the current user (#71). One round
 * trip: ids that don't exist or belong to someone else are silently skipped
 * (`user_id` scoping in the DELETE), and the ids actually removed come back
 * so the sidebar can patch its cache from ground truth. Serves both the
 * per-row delete (one id) and select-mode bulk delete — one code path.
 */
export async function deleteConversationsBulk(ids: string[]): Promise<{ deleted: string[] }> {
  const user = await requireUser()
  // Dedupe and cap at the sidebar's list size — nothing legitimate selects
  // more rows than the list can show.
  const unique = [...new Set(ids)].slice(0, 200)
  const deleted = await dbDeleteConversations(unique, user.id)
  for (const id of deleted) evictPatterns(id)
  return { deleted }
}

/**
 * Get list of available agents (metadata only).
 */
export async function getAgentList(): Promise<
  Array<{
    id: string
    name: string
    description: string
    icon: string
    /** Accent-family token; resolve with `accentColor()` (lib/agent-palette). */
    accent: string
    servers: string[]
  }>
> {
  return getAgentMetadata()
}

// ============================================================================
// Sidebar / persistence actions
// ============================================================================

export interface ConversationSummary {
  id: string
  agentId: string
  /** The agent's iconify class, pre-resolved from the registry so the
   *  sidebar needs no registry import and no second round trip (#60).
   *  Undefined when the agent no longer exists (e.g. removed agents). */
  agentIcon?: string
  /** The agent's accent-family token (see lib/agent-palette.ts), resolved
   *  from the registry alongside the icon. The client maps it to a hex via
   *  `accentColor()` — sending the token rather than the colour keeps a
   *  future light theme free to remap. Undefined for removed agents. */
  agentAccent?: string
  title: string | null
  /** 'conversation' | 'action' — drives the sidebar's segmented filter. */
  kind: ConversationKind
  /** 'chat' | 'post' | 'routine' — immutable provenance. */
  source: ConversationSource
  /** Lifted status — drives the in-flight spinner/badge. */
  status: ConversationStatus
  /** ISO 8601 — Date doesn't survive server-action serialization unscathed. */
  updatedAt: string
}

/**
 * List the current user's conversations for the sidebar (newest first).
 *
 * Returns `[]` for an unauthenticated request rather than throwing — this
 * server action runs from a top-level `createResource` on page load, before
 * the AuthProvider has had a chance to redirect to signin. Throwing would
 * crash the route render.
 */
export async function listConversations(): Promise<ConversationSummary[]> {
  let userId: string
  try {
    userId = (await requireUser()).id
  } catch {
    return []
  }
  const rows = await dbListConversations(userId)
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    agentIcon: getAgent(r.agentId)?.icon,
    agentAccent: getAgent(r.agentId)?.accent,
    title: r.title,
    kind: r.kind,
    source: r.source,
    status: r.status,
    updatedAt: r.updatedAt.toISOString(),
  }))
}

// Replay helper extracted to a dependency-free module so it can be unit-tested
// without dragging in the auth/DB import graph. Re-export the type for callers.
import { replayMessages, type ReplayedMessage } from './replay'
export type { ReplayedMessage }

export interface LoadedConversation {
  id: string
  agentId: string
  messages: ReplayedMessage[]
  /** Row kind — the chat view reads this to gate the promotion confirm on
   *  send (only actions prompt). Authoritative (from the DB), unlike the
   *  possibly-stale sidebar threads cache. */
  kind: ConversationKind
  /** Serialized UnifiedContext. The events array can be replayed by the UI
   *  to repopulate the graph and observability panel. */
  serialized: string
}

/**
 * Load a conversation for the current user. Returns the serialized context
 * plus a chat-ready replay of user/assistant messages.
 */
export async function loadConversation(sessionId: string): Promise<LoadedConversation> {
  const user = await requireUser()
  const loaded = await loadSession(sessionId, user.id)
  if (!loaded) {
    throw new Error('Conversation not found')
  }

  const messages = replayMessages(loaded.serializedContext)
  return {
    id: sessionId,
    agentId: loaded.agentId,
    messages,
    kind: loaded.kind,
    serialized: loaded.serializedContext,
  }
}

/**
 * Regenerate the LLM-authored title for an existing conversation. Bound
 * to the sidebar's hover-reveal ↻ button. Loads the session's stored
 * context, runs the minimal title-generator harness agent against the
 * most recent user message, and persists the result via
 * `updateConversationTitle()` (bypasses the COALESCE-sticky upsert).
 *
 * Returns the new title on success, or null when the conversation has
 * no user messages, isn't found, or the LLM call fails — silent failure
 * leaves the existing title in place.
 */
export async function regenerateConversationTitle(sessionId: string): Promise<string | null> {
  const user = await requireUser()
  const loaded = await loadSession(sessionId, user.id)
  if (!loaded) return null
  const { deserializeContext } = await import('../harness-patterns')
  const { runRegenerateTitle } = await import('./examples/title-generator.server')
  const ctx = deserializeContext(loaded.serializedContext)
  return runRegenerateTitle(ctx, sessionId, user.id)
}
