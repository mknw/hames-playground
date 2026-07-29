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
"use server";

import {
  harness,
  resumeHarness,
  continueSession,
  createContext,
  serializeContext,
  type HarnessResultScoped,
  type ContextEvent,
} from "../harness-patterns";
import {
  getOrBuildPatterns,
  loadSession,
  saveSession,
  deleteSession,
  type SessionData,
} from "./session.server";
import { getAgent, getAgentMetadata } from "./registry.server";
import {
  listConversations as dbListConversations,
  promoteConversation as dbPromoteConversation,
  saveConversation as dbSaveConversation,
  deriveTitle,
  type ConversationKind,
  type ConversationSource,
  type ConversationStatus,
} from "../db/conversations.server";
import type { HarnessSettings } from "../settings";
import { runWithSettings } from "../settings-context.server";
import { getAuthenticatedUser } from "../auth/server";
import { BYPASS_USER, isBypassEnabled } from "../auth/dev-bypass";
import { runWithUserId } from "./request-user.server";

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
    return { id: BYPASS_USER.id, email: BYPASS_USER.email };
  }
  const u = await getAuthenticatedUser();
  return { id: u.id, email: u.email };
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
  return processMessageWithAgent(sessionId, message, "default");
}

/**
 * Process a user message using a specific agent.
 */
export async function processMessageWithAgent(
  sessionId: string,
  message: string,
  agentId: string = "default",
): Promise<HarnessResultScoped<SessionData>> {
  const user = await requireUser();
  return runTurn(sessionId, user.id, message, agentId);
}

/**
 * Process a message with streaming events via callback.
 * Used by the SSE endpoint for real-time event delivery.
 */
export async function processMessageStreaming(
  sessionId: string,
  message: string,
  agentId: string = "default",
  onEvent: (event: ContextEvent) => void,
  settings?: HarnessSettings,
): Promise<HarnessResultScoped<SessionData>> {
  const user = await requireUser();
  return runWithSettings(settings, () =>
    runTurn(sessionId, user.id, message, agentId, onEvent),
  );
}

async function runTurn(
  sessionId: string,
  userId: string,
  message: string,
  agentId: string,
  onEvent?: (event: ContextEvent) => void,
): Promise<HarnessResultScoped<SessionData>> {
  // Establish the user-id scope so pattern closures that need to load
  // per-conversation context at runtime (e.g. code-mode's tool allowlist
  // reader) can resolve the right user without an explicit parameter.
  return runWithUserId(userId, async () => {
    // If the user switched agent within an existing conversation, treat it as
    // a fresh conversation by ignoring the prior serialized context. The UI is
    // expected to mint a new sessionId on agent change, but we double-guard
    // here so a stale id can't continue with a different agent's patterns.
    const loaded = await loadSession(sessionId, userId);

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
        serializedContext: serializeContext(
          createContext(message, undefined, sessionId),
        ),
        status: "running",
      });
    }

    const patterns = await getOrBuildPatterns(sessionId, agentId);

    let result: HarnessResultScoped<SessionData>;
    if (loaded && loaded.agentId === agentId) {
      result = await continueSession(
        loaded.serializedContext,
        patterns,
        message,
        onEvent,
      );
    } else {
      const agent = harness(...patterns);
      result = await agent(message, sessionId, undefined, onEvent);
    }

    await saveSession(sessionId, userId, agentId, result.serialized);
    return result;
  });
}

/**
 * Promote an action to a regular conversation (flip `kind`). Bound to the
 * sidebar's confirm-on-send gate. Scoped to the current user. Self-
 * authenticating — safe to expose as a server action.
 */
export async function promoteAction(sessionId: string): Promise<void> {
  const user = await requireUser();
  await dbPromoteConversation(sessionId, user.id);
}

/**
 * Approve a pending action.
 */
export async function approveAction(
  sessionId: string,
): Promise<HarnessResultScoped<SessionData>> {
  return resolveApproval(sessionId, true);
}

/**
 * Reject a pending action.
 */
export async function rejectAction(
  sessionId: string,
  _reason?: string,
): Promise<HarnessResultScoped<SessionData>> {
  return resolveApproval(sessionId, false);
}

async function resolveApproval(
  sessionId: string,
  approved: boolean,
): Promise<HarnessResultScoped<SessionData>> {
  const user = await requireUser();
  const loaded = await loadSession(sessionId, user.id);
  if (!loaded) {
    throw new Error("No active session");
  }
  return runWithUserId(user.id, async () => {
    const patterns = await getOrBuildPatterns(sessionId, loaded.agentId);
    const result = await resumeHarness(
      loaded.serializedContext,
      patterns,
      approved,
    );
    await saveSession(sessionId, user.id, loaded.agentId, result.serialized);
    return result;
  });
}

/**
 * Clear a session — deletes the row from Postgres and evicts the in-memory
 * pattern cache.
 */
export async function clearSession(sessionId: string): Promise<void> {
  const user = await requireUser();
  await deleteSession(sessionId, user.id);
}

/**
 * Get list of available agents (metadata only).
 */
export async function getAgentList(): Promise<
  Array<{
    id: string;
    name: string;
    description: string;
    icon: string;
    servers: string[];
  }>
> {
  return getAgentMetadata();
}

// ============================================================================
// Sidebar / persistence actions
// ============================================================================

export interface ConversationSummary {
  id: string;
  agentId: string;
  title: string | null;
  /** 'conversation' | 'action' — drives the sidebar's segmented filter. */
  kind: ConversationKind;
  /** 'chat' | 'post' — immutable provenance. */
  source: ConversationSource;
  /** Lifted status — drives the in-flight spinner/badge. */
  status: ConversationStatus;
  /** ISO 8601 — Date doesn't survive server-action serialization unscathed. */
  updatedAt: string;
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
  let userId: string;
  try {
    userId = (await requireUser()).id;
  } catch {
    return [];
  }
  const rows = await dbListConversations(userId);
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    title: r.title,
    kind: r.kind,
    source: r.source,
    status: r.status,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

// Replay helper extracted to a dependency-free module so it can be unit-tested
// without dragging in the auth/DB import graph. Re-export the type for callers.
import { replayMessages, type ReplayedMessage } from "./replay";
export type { ReplayedMessage };

export interface LoadedConversation {
  id: string;
  agentId: string;
  messages: ReplayedMessage[];
  /** Row kind — the chat view reads this to gate the promotion confirm on
   *  send (only actions prompt). Authoritative (from the DB), unlike the
   *  possibly-stale sidebar threads cache. */
  kind: ConversationKind;
  /** Serialized UnifiedContext. The events array can be replayed by the UI
   *  to repopulate the graph and observability panel. */
  serialized: string;
}

/**
 * Load a conversation for the current user. Returns the serialized context
 * plus a chat-ready replay of user/assistant messages.
 */
export async function loadConversation(
  sessionId: string,
): Promise<LoadedConversation> {
  const user = await requireUser();
  const loaded = await loadSession(sessionId, user.id);
  if (!loaded) {
    throw new Error("Conversation not found");
  }

  const messages = replayMessages(loaded.serializedContext);
  return {
    id: sessionId,
    agentId: loaded.agentId,
    messages,
    kind: loaded.kind,
    serialized: loaded.serializedContext,
  };
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
export async function regenerateConversationTitle(
  sessionId: string,
): Promise<string | null> {
  const user = await requireUser();
  const loaded = await loadSession(sessionId, user.id);
  if (!loaded) return null;
  const { deserializeContext } = await import("../harness-patterns");
  const { runRegenerateTitle } = await import(
    "./examples/title-generator.server"
  );
  const ctx = deserializeContext(loaded.serializedContext);
  return runRegenerateTitle(ctx, sessionId, user.id);
}

