/**
 * The views of a conversation's waiting blocking requests (decision-loop-agent
 * slice 9) — Server Only, and deliberately NOT `'use server'`: it takes an
 * owner, and a browser-callable function that takes an owner lets the caller
 * choose it (SD-13). The gated RPC in `actions.server.ts` calls it with the
 * session's user.
 *
 * The blob decides what waits (ADR-0009): `readHitl(ctx).pending` of a PAUSED
 * conversation. A request's held payload is read by its `payloadRef` through
 * the owner-scoped repository, so another user's ref reads as nothing.
 */
import { deserializeContext, readHitl } from '@hames-ai/harness-patterns'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { getHitlPayload, loadHitlAnswerRows } from '../db/hitl.server'
import { loadSession } from '../harness-client/session.server'
import type { BlockingRequestView } from './blocking-view'

assertServerOnImport()

export async function listBlockingRequestViews(
  sessionId: string,
  userId: string,
): Promise<BlockingRequestView[]> {
  const loaded = await loadSession(sessionId, userId)
  // The ROW decides whether the pause is still live, as the inbox reads it: a
  // pause a `chain-changed` refusal ended for good leaves its blob `paused`
  // and its row `error`, and offering it again would loop on that refusal.
  if (!loaded || loaded.status !== 'paused') return []
  const ctx = deserializeContext(loaded.serializedContext)
  if (ctx.status !== 'paused') return []
  const pending = readHitl(ctx).pending
  if (pending.length === 0) return []
  const recorded = new Map(
    (await loadHitlAnswerRows(sessionId, userId)).map((r) => [r.requestId, r.answer?.choice]),
  )
  return Promise.all(
    pending.map(async (r): Promise<BlockingRequestView> => {
      const held =
        r.payloadRef !== undefined ? await getHitlPayload(r.payloadRef, userId) : undefined
      return {
        requestId: r.requestId,
        kind: r.kind,
        question: r.question,
        options: r.options.map((o) => ({
          id: o.id,
          label: o.label,
          ...(o.tone === 'danger' || o.tone === 'caution' ? { tone: o.tone } : {}),
          ...(o.unavailable ? { unavailable: o.unavailable } : {}),
        })),
        defaultOption: r.defaultOption,
        summary: r.summary,
        expiresAt: r.expiresAt ?? null,
        recorded: recorded.get(r.requestId) ?? null,
        ...(r.payloadRef !== undefined ? { payload: held ? held.payload : null } : {}),
      }
    }),
  )
}
