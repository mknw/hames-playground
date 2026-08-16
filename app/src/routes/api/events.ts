/**
 * SSE Endpoint for Streaming Agent Events
 *
 * Streams ContextEvents in real-time as they are committed during harness execution.
 * Enables reactive UI updates (e.g., graph visualization) without waiting for full completion.
 */
import type { APIEvent } from "@solidjs/start/server";
import { processMessageStreaming } from "../../lib/harness-client/actions.server";
import { saveSession } from "../../lib/harness-client/session.server";
import { scheduleSummarization, serializeContext } from "../../lib/harness-patterns";
import { runFirstTurnTitleGen } from "../../lib/harness-client/examples/title-generator.server";
import { getAuthenticatedUser } from "../../lib/auth/server";
import { BYPASS_USER, isBypassEnabled } from "../../lib/auth/dev-bypass";
import type { HarnessSettings } from "../../lib/settings";

/** Hard cap on how long the SSE stream stays open after `done` waiting for
 *  the title agent to resolve. If the LLM exceeds this, we close the stream
 *  without a `title_updated` event — the heuristic title persists. */
const TITLE_GEN_TIMEOUT_MS = 3000;

async function requireUserId(): Promise<string> {
  if (isBypassEnabled()) return BYPASS_USER.id;
  return (await getAuthenticatedUser()).id;
}

export async function POST(event: APIEvent) {
  const body = await event.request.json();
  const { sessionId, message, agentId, settings } = body as {
    sessionId: string;
    message: string;
    agentId?: string;
    settings?: HarnessSettings;
  };

  if (!sessionId || !message) {
    return new Response(JSON.stringify({ error: "sessionId and message are required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Auth here so we have a userId for the post-response background save —
  // the wrapped server action below also authenticates (defense in depth).
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }
  const resolvedAgentId = agentId ?? "default";

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const result = await processMessageStreaming(
          sessionId,
          message,
          resolvedAgentId,
          (evt) => {
            // `sessionId` rides on every envelope so the client can route the
            // event to the right per-session progress controller (#47). Events
            // themselves don't carry sessionId in their typed shape — it's an
            // envelope-only field.
            const data = JSON.stringify({ ...evt, sessionId });
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          },
          settings,
        );

        // Send final result as a named event
        const doneData = JSON.stringify({
          sessionId,
          response: result.response,
          data: result.data,
          status: result.status,
          duration_ms: result.duration_ms,
          context: result.context,
          serialized: result.serialized,
        });
        controller.enqueue(encoder.encode(`event: done\ndata: ${doneData}\n\n`));

        // First-turn title generation — synchronous w.r.t. the stream so the
        // result can ride out as a `title_updated` event before close. Hard
        // 3s cap so a slow LLM never wedges the stream. Heuristic title
        // (from `deriveTitle` / `saveConversation` COALESCE) persists if this
        // path fails or times out — the next `listConversations()` returns it.
        await Promise.race([
          runFirstTurnTitleGen(result.context, sessionId, userId).then((title) => {
            if (!title) return;
            const payload = JSON.stringify({ sessionId, title });
            controller.enqueue(encoder.encode(`event: title_updated\ndata: ${payload}\n\n`));
          }),
          new Promise<void>((resolve) => setTimeout(resolve, TITLE_GEN_TIMEOUT_MS)),
        ]).catch((err) => console.error("[title-gen] failed:", err));

        controller.close();

        // Fire-and-forget: summarize this turn's tool results in the background.
        // Runs after the SSE stream is closed — user already has the response.
        // Summaries are stored on tool_result events and persisted to session,
        // so they appear as compact pointers on subsequent turns.
        scheduleSummarization(result.context, async () => {
          await saveSession(
            sessionId,
            userId,
            resolvedAgentId,
            serializeContext(result.context),
          );
        }).catch((err) =>
          console.error("[summarize] background summarization failed:", err),
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${JSON.stringify({ sessionId, error: msg })}\n\n`),
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
