/**
 * Chat-history replay — convert a serialized `UnifiedContext` back into the
 * minimal `{ id, role, content, timestamp }[]` list the UI paints when a
 * conversation is restored from the sidebar.
 *
 * Pure data transformation — no server-only dependencies, no DB, no auth.
 * Lives outside `actions.server.ts` so it can be unit-tested directly
 * without dragging in the auth/DB import graph.
 *
 * Key rule (issue: residual "Let me look into that…" on hydration):
 * router emits `assistant_message` events for intermediate routing status
 * AND the compactExecution (or direct-response router) emits one for the
 * user-facing final response. We discriminate via
 * `AssistantMessageEventData.final === true` — only `final` emits become
 * chat bubbles on replay.
 */
import type {
  ContextEvent,
  AssistantMessageEventData,
  UserMessageEventData,
  ErrorEventData,
} from '../harness-patterns'

export interface ReplayedMessage {
  id: string
  role: 'user' | 'assistant' | 'warning' | 'error'
  content: string
  /** Epoch ms — convert to Date on the client. */
  timestamp: number
  /** Error/warning only — mirrors the `Message` fields of the same names. */
  hint?: string
  patternId?: string
  turnInfo?: string
}

/**
 * The presentation of one `error` event as a chat bubble.
 *
 * Shared by the LIVE stream handler (`ChatInterface`, which builds the bubble
 * from an SSE event as it arrives) and by replay below, so the same event
 * cannot render one way while streaming and another way after a reload. The
 * two were written separately once and replay simply had no error branch at
 * all: the amber bubble vanished when the user left the thread and came back,
 * even though the event was persisted the whole time.
 *
 * `severity` is optional on the event; anything other than an explicit
 * 'recoverable' is treated as terminal, which keeps an event that predates the
 * field (or arrives malformed) loud rather than silently downgraded.
 */
export function errorBubble(data: ErrorEventData): {
  role: 'warning' | 'error'
  content: string
  hint?: string
  turnInfo?: string
} {
  // 0-indexed on the wire, 1-indexed for humans — matches the turn numbering
  // the observability panel shows.
  const parts: string[] = []
  if (data.turn !== undefined) parts.push(`turn ${data.turn + 1}`)
  if (data.iteration !== undefined) parts.push(`attempt ${data.iteration + 1}`)
  return {
    role: data.severity === 'recoverable' ? 'warning' : 'error',
    content: data.error ?? '',
    ...(data.hint !== undefined ? { hint: data.hint } : {}),
    ...(parts.length > 0 ? { turnInfo: `(${parts.join(', ')})` } : {}),
  }
}

export function replayMessages(serializedContext: string): ReplayedMessage[] {
  let parsed: { events?: ContextEvent[] }
  try {
    parsed = JSON.parse(serializedContext) as { events?: ContextEvent[] }
  } catch {
    return []
  }
  const events = parsed.events ?? []
  const out: ReplayedMessage[] = []
  for (const ev of events) {
    if (ev.type === 'user_message') {
      const data = ev.data as UserMessageEventData
      out.push({
        id: ev.id ?? `replay-${out.length}`,
        role: 'user',
        content: data.content ?? '',
        timestamp: ev.ts,
      })
    } else if (ev.type === 'assistant_message') {
      const data = ev.data as AssistantMessageEventData
      // Skip intermediate router status messages ("Let me look into that…").
      // Only the compactExecution's (or direct-response router's) final emit
      // carries `final: true` and should surface as a chat bubble on replay.
      // The live UI handles this implicitly by only painting `finalResult.response`.
      if (!data.final) continue
      out.push({
        id: ev.id ?? `replay-${out.length}`,
        role: 'assistant',
        content: data.content ?? '',
        timestamp: ev.ts,
      })
    } else if (ev.type === 'error') {
      // Errors are tracked regardless of `trackHistory`, so a persisted context
      // always carries them — replaying every one matches the live stream, which
      // paints a bubble per error event.
      out.push({
        id: ev.id ?? `replay-${out.length}`,
        timestamp: ev.ts,
        ...(ev.patternId !== undefined ? { patternId: ev.patternId } : {}),
        ...errorBubble(ev.data as ErrorEventData),
      })
    }
  }
  return out
}
