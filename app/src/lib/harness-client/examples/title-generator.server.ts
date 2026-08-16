/**
 * Title Generator — minimal one-pattern harness example.
 *
 * The smallest legal harness-patterns composition: a single `synthesizer`
 * pattern wired through `harness()`, with a custom `synthesize` fn that
 * calls a single BAML function (`GenerateConversationTitle`).
 *
 * Demonstrates that the harness is appropriate for one-shot LLM jobs, not
 * just multi-pattern agentic workflows. Used both in production (by
 * `/api/events` post-stream to generate the conversation title after the
 * first turn) and as a reference example for the harness-patterns library
 * extraction (this file is what consumers see when looking for the
 * "absolute minimum viable agent").
 *
 * Why `synthesizer({ mode: 'message' })`?
 *   In `mode: 'message'`, the synthesizer's input carries the latest user
 *   message and expects a string back from the optional `synthesize` fn.
 *   That's exactly the shape of "give the LLM the user's first message,
 *   get a title string." No loops, no tools, no router.
 *
 * Library boundary: imports only from `~/lib/harness-patterns` and
 * `~/baml_client`. No imports from `~/components` or other consumers —
 * keeps the agent extractable as a standalone npm package example.
 */
"use server";

import { harness, synthesizer } from "../../harness-patterns";
import type {
  HarnessData,
  UnifiedContext,
  UserMessageEventData,
} from "../../harness-patterns";
import { b } from "../../../../baml_client";
import { updateConversationTitle } from "../../db/conversations.server";

/**
 * Data shape carried through the title agent's harness context. Has to
 * satisfy both `harness()`'s `HarnessData & Record<string, unknown>` and
 * `synthesizer()`'s `SynthesizerData` (which expects optional `response`,
 * `synthesizedResponse`, `intent`, `loopHistory`). The empty index
 * signature wires up the structural subtype.
 */
interface TitleAgentData extends HarnessData {
  response?: string;
  synthesizedResponse?: string;
  [key: string]: unknown;
}

// ============================================================================
// Validation & sanitization
// ============================================================================

const MAX_TITLE_CHARS = 50;

/**
 * Best-effort cleanup of model output. The prompt asks for a bare title,
 * but small/fast models occasionally wrap in quotes, add a trailing
 * period, or echo a multiline preamble — strip all of those defensively.
 * Empty / unreasonably long → returns null so the caller skips the DB write.
 */
export function sanitizeTitle(raw: string): string | null {
  const stripped = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "") // surrounding quotes / backticks
    .replace(/[.!?]+$/, "")           // trailing punctuation
    .split("\n")[0]                    // first line only
    .trim();
  if (!stripped) return null;
  return stripped.slice(0, MAX_TITLE_CHARS);
}

// ============================================================================
// The agent
// ============================================================================

/**
 * The whole agent is one pattern. `mode: 'message'` makes the synthesizer
 * a thin shell around our custom `synthesize` fn — no default BAML call,
 * no event tracking beyond `assistant_message`.
 */
export const titleAgent = harness<TitleAgentData>(
  synthesizer<TitleAgentData>({
    patternId: "title-gen",
    mode: "message",
    synthesize: async ({ userMessage }) => {
      const { clientOverrideFor } = await import("../../harness-patterns/clients.server");
      const titleOpts = clientOverrideFor('describe');
      const raw = titleOpts
        ? await b.GenerateConversationTitle(userMessage, titleOpts)
        : await b.GenerateConversationTitle(userMessage);
      return sanitizeTitle(raw) ?? "";
    },
  }),
);

// ============================================================================
// Production entry points
// ============================================================================

/** Extract the user_message events from a UnifiedContext, oldest first.
 *  Untyped data parameter so callers can pass `deserializeContext()` output
 *  (UnifiedContext<unknown>) without first widening it. */
function userMessages(ctx: UnifiedContext<unknown>): string[] {
  return (ctx.events ?? [])
    .filter((e) => e.type === "user_message")
    .map((e) => (e.data as UserMessageEventData).content ?? "");
}

/** Returns true iff this turn was the first user_message of the conversation. */
function isFirstTurn(ctx: UnifiedContext<unknown>): boolean {
  return userMessages(ctx).length === 1;
}

/**
 * First-turn entry point. Called from `/api/events` after the SSE `done`
 * frame, before the stream closes. Skips (returns null) when this isn't
 * the first turn — titles are only auto-generated once per conversation.
 *
 * Failure modes (LLM throws, returns empty, sanitizer rejects) all return
 * null, leaving the heuristic title (set by `deriveTitle` in
 * `saveConversation`) in place. No retry, no error event.
 */
export async function runFirstTurnTitleGen(
  ctx: UnifiedContext<unknown>,
  sessionId: string,
  userId: string,
): Promise<string | null> {
  if (!isFirstTurn(ctx)) return null;
  const firstUserMessage = userMessages(ctx)[0];
  if (!firstUserMessage) return null;
  return runTitleAgent(firstUserMessage, sessionId, userId);
}

/**
 * On-demand entry point. No first-turn gate. Called from the sidebar's
 * regenerate-title button via `regenerateConversationTitle` server action
 * — re-runs the agent with the most recent user message in context (so
 * a chat that has drifted topic gets a refreshed title).
 *
 * Could be evolved to summarize across all messages, but keeps the same
 * one-pattern shape for now — first iteration: take the latest user message.
 */
export async function runRegenerateTitle(
  ctx: UnifiedContext<unknown>,
  sessionId: string,
  userId: string,
): Promise<string | null> {
  const messages = userMessages(ctx);
  const seed = messages[messages.length - 1] ?? messages[0];
  if (!seed) return null;
  return runTitleAgent(seed, sessionId, userId);
}

/** Shared helper — runs the agent, persists on success, swallows failures. */
async function runTitleAgent(
  userMessage: string,
  sessionId: string,
  userId: string,
): Promise<string | null> {
  try {
    // The agent generates its own throwaway sessionId for the harness
    // context; we pass a deterministic one for traceability in logs.
    const result = await titleAgent(userMessage, `title-gen-${sessionId}`);
    const title = sanitizeTitle(result.response);
    if (!title) return null;
    await updateConversationTitle(sessionId, userId, title);
    return title;
  } catch (err) {
    // Silent fallthrough — heuristic title remains in the DB row.
    console.error("[title-gen] failed:", err);
    return null;
  }
}
