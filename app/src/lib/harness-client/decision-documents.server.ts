/**
 * What the Decide step may be told about the conversation's documents (#507;
 * design: docs/plan/decide-document-context.md) and about the turn's recalled
 * memories (#829).
 *
 * This is the ONE place the tier line is drawn ({@link privateDecisionRun}).
 * Core's `decisionLoop` never reads a tier and renders whatever it is handed;
 * the host decides what a run may reveal:
 *
 *   - the run frame's raw tier slot is exactly `'self_deployed'` (the private tier:
 *     the self-hosted decisions shim, no public provider) → the visible total
 *     AND every visible document's name, type and size; the recalled memories'
 *     text;
 *   - anything else (`'anthropic'`, an unrecognised value, a frame with no tier
 *     slot) → the visible total only; the memories' count only. No uploaded-file
 *     name and no memory text reaches the Anthropic tier's decisions host.
 *
 * Three spellings of that check are wrong and each has a pin
 * (`decision-documents.test.ts`): `!== 'anthropic'` lets an unrecognised value or
 * a typo see names; a comparison with `'private'` is false everywhere (no such
 * tier value exists in code), so the ruling would be silently never in force; and
 * `activeInferenceTier()` instead of the raw slot would hand names to a frameless
 * run on a deployment whose default is `'self_deployed'`, where the safe error is a count.
 * The policy is set here in code, never by an environment variable.
 *
 * Hidden and archived documents are left out of the list AND the count: they are
 * out of LLM context, and retrieval honours the same flags.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import type { DecisionDocuments, DecisionDocumentsSource } from '@hames-ai/harness-patterns'
import { currentRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import {
  listDocumentSummariesStrict,
  type StashDocumentSummary,
} from '@hames-ai/harness-patterns/stash/document-store.server'
import { userOwnsSession } from '../stash/ownership.server'
import { getRequestUserId } from './request-user.server'

assertServerOnImport()

/**
 * The tier line: true only when this run's RAW tier slot is the private tier's
 * literal. A frame still carrying the pre-rename `verda` is routed as
 * self_deployed by `activeInferenceTier()` but is false here: the closed
 * direction, on purpose. Read when CALLED, because built patterns outlive the
 * turn. It is also `AgentDeps.quoteMemoriesToDecider`.
 */
export function privateDecisionRun(): boolean {
  return currentRunFrame()?.inference?.tier === 'self_deployed'
}

/** Seams for the unit tests; production uses the defaults. */
export interface DecisionDocumentsDeps {
  readonly list?: (sessionId: string, signal: AbortSignal) => Promise<StashDocumentSummary[]>
  readonly owns?: (sessionId: string, userId: string) => Promise<boolean>
  readonly userId?: () => string | null | undefined
}

/**
 * The source for one conversation, called by `decisionLoop` once per run. The
 * session id is fixed at construction (like `createRedisBackend`); everything
 * that changes between turns — the owner in scope, the tier, the document set —
 * is read when the source is CALLED, because built patterns outlive all three.
 *
 * Throws (the loop renders "unknown" and records a warning) when the owner
 * cannot be established or the stash cannot be read. Returns nothing to show
 * for a session the requester does not own, without touching the stash.
 */
export function createDecisionDocuments(
  sessionId: string,
  deps: DecisionDocumentsDeps = {},
): DecisionDocumentsSource {
  const list =
    deps.list ??
    ((id: string, signal: AbortSignal) => listDocumentSummariesStrict(id, undefined, signal))
  const owns = deps.owns ?? userOwnsSession
  const currentUserId = deps.userId ?? getRequestUserId

  return async (signal): Promise<DecisionDocuments> => {
    const userId = currentUserId()
    if (!userId) throw new Error('no authenticated user: document ownership cannot be established')
    if (!(await owns(sessionId, userId))) return { total: 0 }

    const visible = (await list(sessionId, signal)).filter((d) => !d.excluded)
    if (!privateDecisionRun()) return { total: visible.length }
    return {
      total: visible.length,
      names: visible.map((d) => ({
        id: d.id,
        name: d.filename,
        mimeType: d.mimeType,
        size: d.size,
        uploadedAt: d.uploadedAt,
        searchable: d.ingestStatus === 'indexed',
      })),
    }
  }
}
