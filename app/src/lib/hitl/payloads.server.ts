/**
 * The host's half of a blocking request's payload (decision-loop-agent slice 8)
 * — Server Only, and deliberately NOT a `'use server'` module: every function
 * here takes an owner, and a browser-callable RPC that takes an owner lets the
 * caller choose it (SD-13).
 *
 * - {@link createHitlPayloadStore}: the `HitlPayloadStore` core's
 *   `askHumanHolding` writes through, bound to ONE owner and ONE conversation
 *   by the turn that builds it, so core never names either.
 * - {@link purgeClosedPayloads}: after a save, the payloads of every request
 *   the blob no longer waits on go (F20b's rule, extended to held payloads).
 * - {@link resolveHitlAnswer}: the host's `resolve`, dispatching on the
 *   request's kind.
 */
import {
  readHitl,
  type ContextEvent,
  type HitlPayloadStore,
  type HitlRequestEventData,
  type UnifiedContext,
} from '@hames-ai/harness-patterns'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { deleteHitlPayloads, deleteQuarantine, holdHitlPayload } from '../db/hitl.server'

assertServerOnImport()

/** The store a run's `askHumanHolding` writes through, for one owner and one
 *  conversation. */
export function createHitlPayloadStore(userId: string, sessionId: string): HitlPayloadStore {
  return {
    hold: (input) =>
      holdHitlPayload({
        userId,
        sessionId,
        callKey: input.callKey,
        kind: input.kind,
        payload: input.payload,
        expiresAt: new Date(input.expiresAt),
      }),
    drop: async (payloadRef) => {
      await deleteHitlPayloads([payloadRef], userId)
    },
  }
}

/**
 * Delete the held payloads of every blocking request in `ctx` that is no
 * longer waiting: answered, superseded or expired. Called after a save, so a
 * request the save just recorded as pending keeps its payload. Issues no query
 * when no request in the blob names a payload.
 */
export async function purgeClosedPayloads(
  ctx: Pick<UnifiedContext, 'events'>,
  userId: string,
): Promise<number> {
  const waiting = new Set(readHitl(ctx).pending.map((r) => r.requestId))
  const closed = ctx.events
    .filter(
      (e: ContextEvent): e is ContextEvent & { data: HitlRequestEventData } =>
        e.type === 'hitl_request',
    )
    .filter((e) => e.data.blocking && typeof e.data.payloadRef === 'string')
    .filter((e) => !waiting.has(e.data.requestId))
    .map((e) => e.data.payloadRef as string)
  return closed.length > 0 ? deleteHitlPayloads(closed, userId) : 0
}

/** One kind's side effect for an answer. Must be idempotent per `requestId`
 *  (core's Δ4 rule: a retried resume calls every `resolve` again). */
type Resolver = (
  request: HitlRequestEventData,
  answer: { readonly choice: string; readonly flags: Readonly<Record<string, boolean>> },
  userId: string,
) => Promise<unknown>

/** Drop the held content of a provenance request (#433 F2): DELETE is
 *  idempotent per requestId. */
const dropQuarantine: Resolver = (request, _answer, userId) =>
  deleteQuarantine(request.requestId, userId)

/** Each kind's resolver. A kind with none keeps the original behaviour. */
const RESOLVERS: Readonly<Record<string, Resolver>> = {
  provenance: dropQuarantine,
}

/** The host's `resolve` for one owner's resume: the request's kind picks it. */
export function resolveHitlAnswer(userId: string) {
  return (
    request: HitlRequestEventData,
    answer: { readonly choice: string; readonly flags: Readonly<Record<string, boolean>> },
  ): Promise<unknown> => (RESOLVERS[request.kind] ?? dropQuarantine)(request, answer, userId)
}
