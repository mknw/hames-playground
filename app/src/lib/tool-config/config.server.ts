/**
 * Tool Configuration — Per-Conversation Allowlist
 *
 * The code-mode agent's actor allowlist is curated per-conversation by the
 * user from the Tools tab. Storage rides in the conversation's serialized
 * UnifiedContext.data.codeModeAllowedTools field (JSONB column on the
 * `conversations` table — see lib/db/conversations.server.ts). No new schema.
 *
 * Read path:   ToolsPanel resource → getCodeModeAllowedTools(sessionId)
 * Write path:  Tools tab checkbox  → setCodeModeAllowedTools(sessionId, names)
 * Agent path:  createPatterns(sid) builds a toolNamesProvider closure that
 *              calls getCodeModeAllowedTools live per actor invocation
 *              (see harness-client/examples/code-mode.server.ts).
 */
"use server";

import { deserializeContext, serializeContext } from "../harness-patterns";
import type { UnifiedContext } from "../harness-patterns";
import { listTools } from "../harness-patterns/mcp-client.server";
import { loadSession, saveSession, type SessionData } from "../harness-client/session.server";
import { agentUsesCodeMode } from "../harness-client/registry.server";
import { getAuthenticatedUser } from "../auth/server";
import { CODE_MODE_DEFAULTS, type CodeModeToolsState } from "./constants";
import { getPresetTools } from "./server-catalog.server";

// Constants and types live in ./constants because SolidStart's `"use server"`
// transform rewrites every export from this file into an RPC stub on the
// client — non-function exports come through as `undefined`-like, which
// would break `MINIMAL_TOOLS.includes(...)` in ToolsPanel.tsx.

// ============================================================================
// Auth helper (mirrors actions.server.ts:43)
// ============================================================================

async function requireUser(): Promise<{ id: string }> {
  if (import.meta.env.VITE_DEV_BYPASS_AUTH === "true") {
    return { id: "dev-bypass-user" };
  }
  const u = await getAuthenticatedUser();
  return { id: u.id };
}

// ============================================================================
// Per-conversation allowlist
// ============================================================================

/**
 * Read the user's code-mode tool selection for a conversation, plus the live
 * gateway tool list and the locked-on meta-tools.
 *
 * When the conversation has no persisted selection yet (new chat, never
 * touched the Tools panel), `allowed` is the meta-tools default.
 */
export async function getCodeModeAllowedTools(
  sessionId: string,
  /** The conversation's currently-selected agent (from the client). Drives the
   *  `usesCodeMode` gate so it reflects the live selection immediately — before
   *  the first message persists the session — rather than lagging a turn behind.
   *  Falls back to the persisted agent, then optimistic. */
  selectedAgentId?: string,
): Promise<CodeModeToolsState> {
  const user = await requireUser();

  const [loaded, gateway] = await Promise.all([
    loadSession(sessionId, user.id),
    listTools(),
  ]);

  const available = gateway.map((t) => t.name).sort();
  const defaults = [...CODE_MODE_DEFAULTS];

  let persisted: string[] | undefined;
  if (loaded) {
    try {
      const ctx = deserializeContext<SessionData>(loaded.serializedContext);
      persisted = ctx.data?.codeModeAllowedTools;
    } catch {
      // Corrupt blob — fall through to defaults.
    }
  }

  // Fresh conversation (no persisted pick) defaults to the "default code mode"
  // preset's tools ∪ meta-tools — so the actor (and the panel's pre-checked
  // state) start scoped to Neo4j/web rather than meta-tools alone. Mirrors
  // toolNamesProvider in code-mode.server.ts.
  let presetTools: string[] = [];
  try {
    presetTools = await getPresetTools();
  } catch {
    presetTools = [];
  }
  const allowed =
    persisted && persisted.length > 0
      ? persisted
      : Array.from(new Set([...defaults, ...presetTools]));

  // Does this conversation's agent actually consume the allowlist? Auto-detected
  // from its pattern graph. Prefer the client's live selection so a fresh chat
  // greys immediately on agent switch; fall back to the persisted agent, then
  // optimistic (true) when neither is known.
  const agentId = selectedAgentId ?? loaded?.agentId;
  const usesCodeMode = agentId
    ? await agentUsesCodeMode(agentId, sessionId)
    : true;

  return { allowed, available, defaults, usesCodeMode };
}

/**
 * Persist the user's code-mode tool selection for this conversation. Stores
 * the array as-is on `ctx.data.codeModeAllowedTools`; the agent's runtime
 * unions it with `CODE_MODE_DEFAULTS` so meta-tools are always reachable
 * regardless of UI state.
 *
 * Throws when the conversation row doesn't exist yet (the user must send at
 * least one message before configuring tools — the row is created by the
 * first turn).
 */
export async function setCodeModeAllowedTools(
  sessionId: string,
  tools: string[],
): Promise<void> {
  const user = await requireUser();
  const loaded = await loadSession(sessionId, user.id);
  if (!loaded) {
    throw new Error(
      `Cannot set tool allowlist for unknown session ${sessionId}. Send a message first.`,
    );
  }

  const ctx = deserializeContext<SessionData>(loaded.serializedContext) as UnifiedContext<SessionData>;
  ctx.data = { ...(ctx.data ?? {}), codeModeAllowedTools: [...tools] };

  await saveSession(sessionId, user.id, loaded.agentId, serializeContext(ctx));
}

/**
 * Live list of tools the gateway exposes. Replaces the earlier hardcoded
 * stub. Returns just the tool names; the Tools panel queries this resource
 * directly when sessionId isn't known yet.
 */
export async function getAvailableTools(): Promise<string[]> {
  const tools = await listTools();
  return tools.map((t) => t.name).sort();
}
