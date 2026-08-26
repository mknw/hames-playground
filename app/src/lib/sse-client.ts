/**
 * Typed SSE parser for the `/api/events` chat stream.
 *
 * Wraps a `Response.body` ReadableStream and yields a discriminated union of
 * event types. Replaces the hand-rolled byte-stream → frame-split → field-scan
 * logic that used to live inline in `ChatInterface.handleSendMessage`.
 *
 * Adding a new SSE event type is a one-line extension to `ChatStreamEvent`;
 * TypeScript then surfaces any consumer `switch` that doesn't handle it.
 *
 * Wire format (per the W3C SSE spec, subset we emit):
 *
 *   event: <name>\n      (optional; default 'message')
 *   data: <json>\n        (one or more `data:` lines, joined)
 *   \n                    (blank line = end of frame)
 *
 * Frames whose `data:` payload isn't valid JSON are skipped, not thrown —
 * defensive against partial truncation or stray comment lines (`: keepalive`).
 */
import type { ContextEvent, UnifiedContext } from './harness-patterns'

/**
 * How often the server writes a comment frame while a turn produces nothing.
 *
 * Lives HERE, next to the parser that must ignore it, rather than in
 * `routes/api/events.ts` where it is used: SolidStart's API-route transform
 * keeps only the HTTP-verb exports of a route module and drops everything else,
 * so a constant declared there is stripped from the built route and the handler
 * that references it throws `ReferenceError` at request time — invisible to
 * typecheck, to vitest (which imports the module raw) and to `vinxi build`.
 * Found the only way it can be: by opening a real conversation.
 *
 * The value: a turn can legitimately write nothing for many minutes — one call
 * to the self-hosted deployment blocks for its whole `request_timeout_ms`
 * (600s), and a cold start alone measured 146s on 2026-08-26. Zero bytes for
 * that long is indistinguishable from a dead connection to any intermediary
 * with an idle read timeout. This is DEFENCE IN DEPTH, not the fix for a
 * measured drop: the proxy actually in front of the preview is Caddy, and
 * `configs/Caddyfile` says in as many words that Caddy's default has no
 * response timeout. What the frame buys is "provably alive on the wire" —
 * against a future intermediary, against NAT idle eviction, and as a property
 * worth having on its own. What it does NOT buy is a user-visible signal: a
 * comment frame is invisible to a human by construction, so the silence a
 * person reloads out of is untouched and remains an open owner decision.
 * 15s is the conventional heartbeat: under every default idle timeout worth
 * surviving (nginx / ELB use 60s) without being chatty.
 */
export const SSE_KEEPALIVE_MS = 15_000

/** The heartbeat itself — an SSE comment, which {@link parseFrame} drops
 *  because it carries no `data:` field. Producer and parser read the same
 *  constant so "the client ignores it" cannot drift into a lie. */
export const SSE_KEEPALIVE_FRAME = ': keepalive\n\n'

// ============================================================================
// Event union
// ============================================================================

/** Final-result payload emitted as `event: done`. */
export interface DoneEventData {
  sessionId: string
  response: string
  data: Record<string, unknown>
  status: string
  duration_ms?: number
  context: UnifiedContext
  serialized?: string
}

/** Notification that the conversation's title was just regenerated server-side.
 *  Emitted on the same stream after `done`, before the stream closes. The
 *  client should patch its local thread list — no refetch needed. */
export interface TitleUpdatedEventData {
  sessionId: string
  title: string
}

/** A standard harness event with the sessionId envelope added in #47.
 *  Carries no `event:` header on the wire (default `message`). */
export type MessageEventData = ContextEvent & { sessionId?: string }

/**
 * Discriminated union of all event kinds the chat stream can emit.
 *
 * `event` here is *not* the harness `EventType` — it's the SSE-protocol
 * event name (the value of the `event:` header line). The two are unrelated
 * namespaces; only `message` frames carry a harness `ContextEvent`.
 *
 * Forward-compat: unknown event names still come through at runtime
 * (see `parseChatStream`) but are not part of the static union; consumers
 * should handle them in a `default` branch and treat `data` as `unknown`.
 * Including a `{ event: string; data: unknown }` arm here would defeat
 * literal-name narrowing on the known variants.
 */
export type ChatStreamEvent =
  | { event: 'message'; data: MessageEventData }
  | { event: 'done'; data: DoneEventData }
  | { event: 'error'; data: { sessionId?: string; error: string } }
  | { event: 'title_updated'; data: TitleUpdatedEventData }

// ============================================================================
// Parser
// ============================================================================

/** Parse a single SSE frame's lines into `(eventName, dataString)`. */
function parseFrame(frame: string): { eventName: string; dataStr: string } | null {
  let eventName = 'message'
  let dataStr = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) {
      eventName = line.slice(7).trim()
    } else if (line.startsWith('data: ')) {
      // Multiple `data:` lines are concatenated per the SSE spec.
      dataStr += line.slice(6)
    }
    // Lines starting with `:` are comments; lines without a recognized field
    // prefix are ignored. Both fall through silently.
  }
  if (!dataStr) return null
  return { eventName, dataStr }
}

/**
 * Yield typed events from a `fetch()` response carrying an SSE body.
 *
 * Usage:
 * ```ts
 * for await (const evt of parseChatStream(response)) {
 *   switch (evt.event) {
 *     case 'message':       progress.ingest(evt.data); break
 *     case 'done':          finalResult = evt.data; break
 *     case 'error':         throw new Error(evt.data.error)
 *     case 'title_updated': onTitleUpdated(evt.data.sessionId, evt.data.title); break
 *   }
 * }
 * ```
 */
export async function* parseChatStream(
  response: Response,
): AsyncGenerator<ChatStreamEvent, void, void> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response stream')

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    // Frames are delimited by blank lines (\n\n). The last segment may be
    // an incomplete frame; hold it in the buffer for the next read.
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''

    for (const frame of frames) {
      if (!frame.trim()) continue
      const parsed = parseFrame(frame)
      if (!parsed) continue

      let data: unknown
      try {
        data = JSON.parse(parsed.dataStr)
      } catch {
        // Skip malformed JSON rather than aborting the whole stream.
        continue
      }

      // The `as` casts are safe here: consumers narrow via `evt.event`, and
      // unknown event names fall through to the `{ event: string; data: unknown }`
      // arm. We trust the server to emit well-shaped payloads per type.
      yield { event: parsed.eventName, data } as ChatStreamEvent
    }
  }

  // Flush any final trailing frame if the stream closed without a blank line.
  if (buffer.trim()) {
    const parsed = parseFrame(buffer)
    if (parsed) {
      try {
        const data = JSON.parse(parsed.dataStr)
        yield { event: parsed.eventName, data } as ChatStreamEvent
      } catch {
        /* ignore */
      }
    }
  }
}
