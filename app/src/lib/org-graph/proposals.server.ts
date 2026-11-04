/**
 * The app's half of organizational-knowledge confirmation
 * (`docs/plan/org-knowledge-hook.md`, slice 4). Server only; NOT a
 * `'use server'` module: every function takes the owner, so the browser door is
 * `confirm-actions.server.ts`, which authenticates first (SD-13).
 *
 * The decision state is the blob's `hitl_*` events (ADR-0009); the
 * `hitl_requests` row only HOLDS the payload. A proposal is offered only while
 * the blob has it open, and an answer is bound to that request event by core's
 * `answerProposal`. What a client supplies is a request id and a choice with
 * flags; the payload, the actor and everything written come from here.
 *
 * `answerOrgProposalFor`, in order: bind the answer (core), claim it on the row
 * (first answer wins, before any write), write the selected assertions
 * (`applyOrgProposal`: one transaction each, a stale one refused on its own),
 * then save the context ONCE, conditional on the version it read. The graph
 * write is idempotent (MERGE), so a refused save costs a retry, never a double
 * write: a retry of the same answer finds its nodes and changes nothing.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import {
  deserializeContext,
  HitlAnswerError,
  readProposals,
  serializeContext,
  type HitlAnswerErrorCode,
} from '@hames-ai/harness-patterns'
import { answerProposal } from '@hames-ai/harness-patterns/hitl.server'
import {
  applyOrgProposal,
  ORG_KNOWLEDGE_CONFIRM_ADD,
  ORG_KNOWLEDGE_CONFIRM_KIND,
  parseOrgProposalPayload,
  type OrgProposalPayload,
} from '@hames-ai/harness-patterns/org-knowledge-hook.server'
import { loadConversation, updateConversationContextIfUnchanged } from '../db/conversations.server'
import {
  canonicalAnswer,
  claimHitlProposalAnswer,
  closeHitlRows,
  getHitlProposal,
  listHitlProposals,
  type HitlAnswerValue,
} from '../db/hitl.server'
import { displayText } from '../memory/display-text'
import { orgGraphStore } from './hook.server'

assertServerOnImport()

// ============================================================================
// Listing
// ============================================================================

/** One element of an assertion, as the acceptance card shows it. Every string
 *  is display text, to be rendered as a text node. */
export interface OrgProposalElementView {
  readonly kind: 'node' | 'edge'
  /** The class, or the relation type. */
  readonly label: string
  /** A node's name (or a deadline's label); a fact's text. */
  readonly name: string
  readonly verdict: 'new' | 'reinforces' | 'updates'
  /** A fact's evidence span, verbatim (the design's acceptance card). */
  readonly evidence?: string
  /** An edge's ends, by the name of each node in its assertion. */
  readonly from?: string
  readonly to?: string
  /** Edges a replacement removes, by stored key (slice 5 resolves names). */
  readonly removes?: readonly {
    readonly type: string
    readonly from: string
    readonly to: string
  }[]
}

export interface OrgProposalView {
  readonly requestId: string
  /** A bound answer whose effects are unfinished: offered again, alone. */
  readonly recorded?: { readonly choice: string; readonly flags: Readonly<Record<string, boolean>> }
  readonly expiresAt: number | null
  readonly items: readonly {
    readonly flag: string
    readonly elements: readonly OrgProposalElementView[]
  }[]
}

function viewOf(payload: OrgProposalPayload): OrgProposalView['items'] {
  return payload.assertions.map((a) => {
    const nameOf = new Map<string, string>()
    const nodes = a.nodes.map((n): OrgProposalElementView => {
      const p = n.properties
      const name = displayText(p.name ?? p.label ?? p.displayName ?? p.text ?? '')
      nameOf.set(n.element.ref, name)
      return {
        kind: 'node',
        label: n.element.label,
        name,
        verdict: n.verdict,
        ...(p.evidence !== undefined && n.element.label === 'Fact'
          ? { evidence: displayText(p.evidence) }
          : {}),
      }
    })
    const edges = a.edges.map((e): OrgProposalElementView => ({
      kind: 'edge',
      label: e.element.type,
      name: e.element.type,
      verdict: e.verdict,
      from: nameOf.get(e.element.from) ?? '',
      to: nameOf.get(e.element.to) ?? '',
      ...(e.removes.length > 0 ? { removes: e.removes } : {}),
    }))
    return { flag: `a${a.index}`, elements: [...nodes, ...edges] }
  })
}

/** The open org-knowledge proposals of one conversation, for its owner. */
export async function listOrgProposalsFor(
  userId: string,
  sessionId: string,
): Promise<OrgProposalView[]> {
  const rows = await listHitlProposals(sessionId, userId, ORG_KNOWLEDGE_CONFIRM_KIND)
  if (rows.length === 0) return []
  const conv = await loadConversation(sessionId, userId)
  if (!conv) return []
  const open = new Set(
    readProposals(deserializeContext(conv.serializedContext), Date.now())
      .filter((r) => r.kind === ORG_KNOWLEDGE_CONFIRM_KIND)
      .map((r) => r.requestId),
  )
  const views: OrgProposalView[] = []
  for (const row of rows) {
    if (!open.has(row.requestId)) continue
    const payload = parseOrgProposalPayload(row.payload)
    if (!payload || payload.conversationId !== sessionId) continue
    views.push({
      requestId: row.requestId,
      ...(row.status === 'answering' && row.answer
        ? { recorded: { choice: row.answer.choice, flags: row.answer.flags ?? {} } }
        : {}),
      expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
      items: viewOf(payload),
    })
  }
  return views
}

// ============================================================================
// Answering
// ============================================================================

export type OrgAnswerOutcome =
  | {
      readonly outcome: 'added'
      /** Assertions written, a retry's included. */
      readonly written: number
      /** Assertions refused because what their preview read changed. */
      readonly stale: number
      /** Assertions whose write failed (the answer may be retried). */
      readonly failed: number
      /** The stored key of every node written, by draft ref. */
      readonly keys: Readonly<Record<string, string>>
    }
  | { readonly outcome: 'discarded' }
  | {
      readonly outcome:
        | 'unknown-request'
        | 'expired'
        | 'unavailable'
        | 'already-answered'
        | 'conflict'
        | 'invalid-choice'
        | 'unavailable-option'
        | 'invalid-flag'
        | 'required-flag'
    }

const REFUSAL: Partial<Record<HitlAnswerErrorCode, OrgAnswerOutcome['outcome']>> = {
  'unknown-request': 'unknown-request',
  expired: 'expired',
  'invalid-choice': 'invalid-choice',
  'unavailable-option': 'unavailable-option',
  'invalid-flag': 'invalid-flag',
  'required-flag': 'required-flag',
}

/** Answer one open org-knowledge proposal as `userId` (see the header). */
export async function answerOrgProposalFor(
  userId: string,
  sessionId: string,
  requestId: string,
  answer: string | HitlAnswerValue,
): Promise<OrgAnswerOutcome> {
  const conv = await loadConversation(sessionId, userId)
  if (!conv) return { outcome: 'unknown-request' }
  const ctx = deserializeContext(conv.serializedContext)

  const open = readProposals(ctx).find(
    (r) => r.requestId === requestId && r.kind === ORG_KNOWLEDGE_CONFIRM_KIND,
  )
  if (!open) return { outcome: 'unknown-request' }
  if (open.expiresAt !== undefined && Date.now() >= open.expiresAt) return { outcome: 'expired' }

  const row = await getHitlProposal(requestId, userId)
  if (!row || row.sessionId !== sessionId || row.kind !== ORG_KNOWLEDGE_CONFIRM_KIND) {
    return { outcome: 'unavailable' }
  }
  const payload = parseOrgProposalPayload(row.payload)
  if (!payload || payload.conversationId !== sessionId) return { outcome: 'unavailable' }

  let decided
  try {
    ;[decided] = answerProposal(
      ctx,
      { [requestId]: answer },
      { principal: userId, patternId: 'org-knowledge-confirm' },
    )
  } catch (err) {
    const mapped = err instanceof HitlAnswerError ? REFUSAL[err.code] : undefined
    if (mapped) return { outcome: mapped } as OrgAnswerOutcome
    throw err
  }

  // First answer wins, before any write; a retry of that same answer may
  // finish it, nothing else may.
  const bound = { choice: decided.choice, flags: { ...decided.flags } }
  const claim = await claimHitlProposalAnswer({
    requestId,
    userId,
    sessionId,
    kind: ORG_KNOWLEDGE_CONFIRM_KIND,
    answer: bound,
  })
  if (!claim.claimed) {
    if (!claim.recorded || canonicalAnswer(claim.recorded) !== canonicalAnswer(bound)) {
      return { outcome: 'already-answered' }
    }
  }

  let result: OrgAnswerOutcome = { outcome: 'discarded' }
  if (decided.choice === ORG_KNOWLEDGE_CONFIRM_ADD) {
    const report = await applyOrgProposal(
      { store: orgGraphStore() },
      {
        payload,
        selected: Object.entries(decided.flags)
          .filter(([, chosen]) => chosen === true)
          .map(([flag]) => flag),
        actor: { userId, now: new Date().toISOString() },
      },
    )
    const outcomes = Object.values(report.items)
    result = {
      outcome: 'added',
      written: outcomes.filter((o) => o === 'applied').length,
      stale: outcomes.filter((o) => o === 'stale').length,
      failed: outcomes.filter((o) => o === 'failed').length,
      keys: report.keys,
    }
    // A failed write leaves the answer bound and the payload held, so the same
    // answer can be offered again; nothing is closed and nothing is saved yet.
    if (result.failed > 0) return result
  }

  const saved = await updateConversationContextIfUnchanged(
    sessionId,
    userId,
    serializeContext(ctx),
    conv.version,
  )
  if (!saved) return { outcome: 'conflict' }
  await closeHitlRows([requestId], userId, 'applied').catch((err: unknown) =>
    console.warn('[org-knowledge] answered proposal row not closed:', err),
  )
  return result
}
