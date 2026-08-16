/**
 * Data Stash API — Hide / Unhide / Archive / Unarchive tool results
 *
 * Loads the persisted UnifiedContext for the current user, mutates the
 * specified tool_result via `enrichToolResult`, and writes the updated
 * blob back to Postgres.
 */
import type { APIEvent } from "@solidjs/start/server";
import {
  loadSession,
  saveSession,
} from "../../lib/harness-client/session.server";
import {
  deserializeContext,
  enrichToolResult,
  serializeContext,
} from "../../lib/harness-patterns";
import { getAuthenticatedUser } from "../../lib/auth/server";
import { BYPASS_USER, isBypassEnabled } from "../../lib/auth/dev-bypass";

type StashAction = "hide" | "unhide" | "archive" | "unarchive";

async function requireUserId(): Promise<string> {
  if (isBypassEnabled()) return BYPASS_USER.id;
  return (await getAuthenticatedUser()).id;
}

export async function POST(event: APIEvent) {
  const body = await event.request.json();
  const { sessionId, eventId, action } = body as {
    sessionId: string;
    eventId: string;
    action: StashAction;
  };

  if (!sessionId || !eventId || !action) {
    return new Response(
      JSON.stringify({ error: "sessionId, eventId, and action are required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  let userId: string;
  try {
    userId = await requireUserId();
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const loaded = await loadSession(sessionId, userId);
  if (!loaded) {
    return new Response(
      JSON.stringify({ error: "Session not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  const ctx = deserializeContext(loaded.serializedContext);
  const patch: { hidden?: boolean; archived?: boolean } = {};

  switch (action) {
    case "hide":
      patch.hidden = true;
      break;
    case "unhide":
      patch.hidden = false;
      break;
    case "archive":
      patch.archived = true;
      patch.hidden = false;
      break;
    case "unarchive":
      patch.archived = false;
      break;
    default:
      return new Response(
        JSON.stringify({ error: `Invalid action: ${action}` }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
  }

  const found = enrichToolResult(ctx, eventId, patch);
  if (!found) {
    return new Response(
      JSON.stringify({ error: "Tool result event not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  await saveSession(sessionId, userId, loaded.agentId, serializeContext(ctx));

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
