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

import type { HarnessResultScoped } from '../harness-patterns'
import { loadSession, deleteSession, evictPatterns, type SessionData } from './session.server'
import { runTurnAndPersist } from './turn.server'
import { getAgent, getAgentMetadata } from './registry.server'
import {
  listConversations as dbListConversations,
  promoteConversation as dbPromoteConversation,
  deleteConversations as dbDeleteConversations,
  getConversationInferenceTier as dbGetConversationInferenceTier,
  type ConversationKind,
  type ConversationSource,
  type ConversationStatus,
} from '../db/conversations.server'
import { getAuthenticatedUser } from '../auth/server'
import { BYPASS_USER, isBypassEnabled } from '../auth/dev-bypass'
import { chooseConversationTier, resolveTier, verdaConfigured } from '../inference/tier.server'
import { getStoredInferenceTier } from '../db/user-prefs.server'
import type { InferenceTier } from '../harness-patterns/clients.server'

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
 * Process a user message using the default agent (the `search` agent).
 */
export async function processMessage(
  sessionId: string,
  message: string,
): Promise<HarnessResultScoped<SessionData>> {
  return processMessageWithAgent(sessionId, message, 'search')
}

/**
 * Process a user message using a specific agent.
 */
export async function processMessageWithAgent(
  sessionId: string,
  message: string,
  agentId: string = 'search',
): Promise<HarnessResultScoped<SessionData>> {
  const user = await requireUser()
  return runTurnAndPersist({
    mode: 'interactive',
    sessionId,
    userId: user.id,
    agentId,
    message,
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
  return runTurnAndPersist({ mode: 'approval', sessionId, userId: user.id, approved })
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
    /** Per-agent greeting for an empty conversation — see `AgentConfig.welcome`. */
    welcome: string
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
  /** The tier this conversation's next turn runs on, already RESOLVED (never
   *  null): the row's own value, else this user's last-used, else the
   *  deployment default. The sidebar always shows a glyph, so it always needs
   *  an answer — and it must be the same answer the turn runner reaches, which
   *  is why both go through `resolveTier`. */
  inferenceTier: InferenceTier
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
  // The seed is read ONCE for the whole list, not per row: it is the same
  // value for every conversation this user owns, and 200 rows would otherwise
  // be 200 identical lookups.
  const [rows, seed] = await Promise.all([
    dbListConversations(userId),
    getStoredInferenceTier(userId),
  ])
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    agentIcon: getAgent(r.agentId)?.icon,
    agentAccent: getAgent(r.agentId)?.accent,
    title: r.title,
    kind: r.kind,
    source: r.source,
    status: r.status,
    inferenceTier: resolveTier(r.inferenceTier, seed),
    updatedAt: r.updatedAt.toISOString(),
  }))
}

/** What the switch beside the agent selector needs to render itself. */
export interface ConversationTierState {
  /** The tier this conversation's next turn will run on. */
  tier: InferenceTier
  /** False when the self-hosted endpoints are unconfigured — the switch renders
   *  its private position disabled rather than offering a choice the server
   *  refuses (and that `runWithInferenceTier` would throw on). */
  verdaAvailable: boolean
}

/**
 * The tier state for one conversation.
 *
 * Answers for an id that has no row yet — every chat before its first message —
 * by falling through to this user's last-used tier, which is exactly what that
 * chat's first turn will resolve. So the switch shows the truth from the moment
 * the composer is empty, rather than after the first answer lands.
 */
export async function getConversationTier(sessionId: string): Promise<ConversationTierState> {
  const user = await requireUser()
  const [stored, seed] = await Promise.all([
    dbGetConversationInferenceTier(sessionId, user.id),
    getStoredInferenceTier(user.id),
  ])
  return { tier: resolveTier(stored, seed), verdaAvailable: verdaConfigured() }
}

/**
 * Put this conversation on `tier`, and make it the user's seed for the next new
 * chat. Returns the state the switch should now show, so the control settles on
 * server truth rather than on its own optimistic guess — the server refuses the
 * private position on a deployment with no endpoint, and a switch that kept the
 * click would show one tier while the next turn ran on another.
 *
 * Owner-scoped by construction: `sessionId` names a conversation, never an
 * owner, and both writes are keyed by the session's resolved user. A foreign id
 * silently changes nothing rather than re-routing someone else's chat.
 */
export async function setConversationTier(
  sessionId: string,
  tier: unknown,
): Promise<ConversationTierState> {
  const user = await requireUser()
  const chosen = await chooseConversationTier(sessionId, user.id, tier)
  return { tier: chosen, verdaAvailable: verdaConfigured() }
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
  const { runRegenerateTitle } = await import('./agents/title-generator.server')
  const ctx = deserializeContext(loaded.serializedContext)
  return runRegenerateTitle(ctx, sessionId, user.id)
}
