/**
 * Server Actions for Frontend
 *
 * Top-level "use server" module for SolidStart server actions.
 * Wraps harness-patterns for use in Solid components.
 *
 * Persistence: every public action authenticates the caller via Stack Auth
 * (or VITE_DEV_BYPASS_AUTH) and scopes session reads/writes to that user.
 * The full UnifiedContext is stored as a single JSONB blob in Postgres —
 * see `lib/db/conversations.server.ts`.
 */
"use server";

import {
  harness,
  resumeHarness,
  continueSession,
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
import { listConversations as dbListConversations } from "../db/conversations.server";
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
 * shared `BYPASS_USER` so persistence works without a real Stack Auth session.
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
 * Delete one or more conversations for the current user (sidebar delete /
 * bulk select-mode — #71). Each id is deleted scoped to the requesting user,
 * so a wrong/foreign id silently no-ops rather than touching another user's
 * data. Pattern caches are evicted alongside the Postgres rows via
 * `deleteSession`. Returns the ids that were requested for deletion so the
 * client can patch its threads cache without a refetch.
 */
export async function deleteConversations(
  sessionIds: string[],
): Promise<string[]> {
  const user = await requireUser();
  const unique = Array.from(new Set(sessionIds)).filter(Boolean);
  await Promise.all(unique.map((id) => deleteSession(id, user.id)));
  return unique;
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

