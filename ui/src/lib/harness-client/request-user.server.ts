/**
 * Request-scoped execution context for harness runs.
 *
 * Mirrors `settings-context.server.ts`: a tiny AsyncLocalStorage that lets
 * pattern closures and app-side tools read *who* and *which conversation* a
 * call belongs to at runtime, without threading either through every signature.
 *
 * `runTurn` / `resolveApproval` (actions.server.ts) and `runAgentInBackground`
 * (action-runner.server.ts) wrap their bodies in `runWithRequestContext(…)`.
 * Consumers read `getRequestUserId()` / `getRequestSessionId()` at the point of
 * execution — e.g. code-mode reading `data.codeModeAllowedTools`, or the
 * `graph_file_ingest` app tool resolving the Data Stash session to write into.
 *
 * ## Why the sessionId belongs here and not in tool args
 * Same reason as the userId (#107 principle 1): anything the model can name, the
 * model can point somewhere else. A `session_id` argument would let one
 * conversation write documents into another's stash. Both ids are therefore
 * ambient and server-resolved, and callers handle `null` by refusing.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { assertServerOnImport } from "../harness-patterns/assert.server";

assertServerOnImport();

/** What a harness run knows about its own request. */
export interface RequestContext {
  /** Authenticated user id (Entra `oid`). */
  userId: string;
  /** Conversation/run this execution belongs to; `null` when there isn't one. */
  sessionId: string | null;
}

const requestStore = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with the full request context in scope. */
export function runWithRequestContext<T>(
  ctx: RequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  return requestStore.run(ctx, fn);
}

/**
 * Back-compat wrapper for callers that only have a userId. Establishes the
 * user scope with **no** session, so session-dependent tools fail closed rather
 * than writing into a guessed conversation.
 */
export function runWithUserId<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ userId, sessionId: null }, fn);
}

/** Returns the request's userId, or null when called outside a request scope
 *  (e.g. background summarization). Callers must handle null. */
export function getRequestUserId(): string | null {
  return requestStore.getStore()?.userId ?? null;
}

/** Returns the request's sessionId, or null outside a request scope — and also
 *  inside a `runWithUserId` scope, which deliberately carries no session. */
export function getRequestSessionId(): string | null {
  return requestStore.getStore()?.sessionId ?? null;
}
