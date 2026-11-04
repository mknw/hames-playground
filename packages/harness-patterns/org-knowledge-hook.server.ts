/**
 * The organizational-knowledge hook — after a reply, propose what the user's
 * latest message asserts about the organisation, for a person to accept
 * (`docs/plan/org-knowledge-hook.md`, "The mechanism", slice 3).
 *
 * `settleOrgKnowledge` is a plain async function in `settleMemory`'s shape: the
 * host starts it from its post-turn continuation, awaits it, and so every event
 * it records is in `ctx.events` before that continuation's one save. It never
 * throws and never writes to the graph: it PROPOSES. A failure is a reason code
 * and one log line that never quotes the user's words.
 *
 *   1  preconditions: owner, tier, a turn that did not fail or pause, a final
 *      answer, the user message's event id, the deployment switch on
 *   2  the wake (the host's), under a budget — nothing goes elsewhere instead
 *   3  the gate: ONE choice question over the current user message ALONE
 *   4  the draft: a dry run on a read-only loop (the host's {@link OrgDraftFn},
 *      usually {@link createOrgDraftLoop}), handed the same message alone
 *   5  a strict parse of each candidate and its explicit proposal verdict
 *   6  the snapshot of what the draft names, through the host's store
 *   7  the deterministic validator, feeding refusals back within the loop budget
 *   8  an assertion that only reinforces writes nothing and is not proposed
 *   9  the proposal (`proposeToHuman`, kind `orgKnowledge.confirm`): counts and
 *      the closed class set only — no name, no value, no evidence
 *  10  the hold: the payload goes to the host's store; a hold that throws takes
 *      the proposal back out
 *
 * `applyOrgProposal` is the approval's write: no model, one store transaction
 * per selected assertion, each refused `stale` on its own.
 */

import { assertServerOnImport } from './assert.server'
import { currentRunFrame } from './run-frame.server'
import { proposeToHuman } from './hitl.server'
import { setLivePatternEnabled } from './live-event-context.server'
import { readStoreWindow, DEFAULT_PROPOSAL_TTL_MS } from './memory-store.server'
import { createContext } from './context.server'
import { runChain } from './patterns/chain.server'
import { simpleLoop } from './patterns/simpleLoop.server'
import { withInjectionGuard } from './patterns/withInjectionGuard.server'
import { decide, defineChoice } from './patterns/typedDecision.server'
import { classOf, type GraphOntology } from './org-knowledge-ontology'
import type { OrgActor, OrgApplyResult, OrgGraphStore } from './org-knowledge-store'
import {
  validateOrgDraft,
  type CheckedAssertion,
  type DraftElement,
  type OrgDraft,
  type OrgRule,
} from './org-knowledge-validate.server'
import type {
  ConfiguredPattern,
  ControllerFn,
  DecideFn,
  HitlRequest,
  PatternScope,
  UnifiedContext,
} from './types'

assertServerOnImport()

// ============================================================================
// The store this hook needs
// ============================================================================

/** What the hook reads and writes the graph through: slice 2's graph store
 *  seam. The names below are kept as aliases of it. */
export type OrgKnowledgeStore = OrgGraphStore
export type { OrgActor, OrgApplyResult }

// ============================================================================
// The gate
// ============================================================================

export const ORG_KNOWLEDGE_GATE_KEY = 'orgKnowledge.gate'
export const ORG_KNOWLEDGE_ADD = 'add_to_organizational_kg'
export const ORG_KNOWLEDGE_NONE = 'no_organizational_knowledge'

/** The owner's question, with exactly the owner's two choices (2026-11-04). The
 *  label descriptions are the only text the decision model sees for each. */
export const ORG_KNOWLEDGE_GATE = defineChoice({
  key: ORG_KNOWLEDGE_GATE_KEY,
  question:
    "Does the user's latest message state, as a fact, organizational knowledge that belongs in the shared knowledge graph?",
  labels: [
    {
      id: ORG_KNOWLEDGE_ADD,
      description:
        "The message states, as fact, something about the organisation's projects, deliverables, deadlines, teams, partners, resources, themes or pillars: a name, a link between them, or a budget, status, decision or risk about one of them.",
    },
    {
      id: ORG_KNOWLEDGE_NONE,
      description:
        "Anything else: a question, a request, a hypothetical, an opinion, a rumour, small talk, something about the user themselves, or anything about a person's health, performance or private life.",
    },
  ],
})

// ============================================================================
// The draft
// ============================================================================

/** The read-only tools the draft loop holds — exactly these, nothing else. */
export const ORG_DRAFT_TOOLS = ['read_neo4j_cypher', 'get_neo4j_schema'] as const

/** The dry run: given the user's message and the ontology as text, return
 *  the draft as the loop's final answer. */
export type OrgDraftFn = (input: {
  readonly userMessage: string
  readonly schema: string
  /** Undefined accepts this answer; feedback spends another loop round. */
  readonly validate: (text: string) => Promise<string | undefined>
}) => Promise<string>

/** Only budget exhaustion may preserve the loop's last validator refusal. */
class OrgDraftBudgetExhaustedError extends Error {}

/**
 * The draft as a `simpleLoop` over the two read-only Neo4j tools, inside a K1
 * guard on those tools, in a scratch context that holds the user's message and
 * nothing else. The host routes its controller (in the reference host, the
 * `orgDraft` role; the tier decides which model answers).
 */
export function createOrgDraftLoop(opts: {
  readonly controller: ControllerFn
  readonly maxTurns?: number
}): OrgDraftFn {
  return async ({ userMessage, schema, validate }) => {
    // Built per call: the schema is the loop's config, and a pattern's body
    // reads the config it was built with.
    const loop = simpleLoop(opts.controller, [...ORG_DRAFT_TOOLS], {
      patternId: 'org-knowledge-draft',
      schema,
      // The verdict is JSON the hook parses: 'answer' would tell the model
      // "plain prose (not JSON)" against the schema's own format (LD-22).
      returnStyle: 'json',
      multiToolCalls: 'off',
      rememberPriorTurns: false,
      maxTurns: opts.maxTurns ?? 4,
      validateReturn: (action) => validate(action.tool_args),
    })
    const pattern = withInjectionGuard({ tools: [...ORG_DRAFT_TOOLS] })(
      loop as unknown as ConfiguredPattern<Record<string, unknown>>,
    )
    const scratch = createContext<Record<string, unknown>>(userMessage)
    const done = await runChain(scratch, [pattern])
    const text = (done.data as { returnText?: unknown }).returnText
    if (typeof text !== 'string' || text.trim() === '') {
      const exhausted = done.events.some(
        (event) =>
          event.type === 'error' && (event.data as { kind?: string }).kind === 'budget_exhausted',
      )
      if (exhausted) throw new OrgDraftBudgetExhaustedError('the draft loop returned no answer')
      throw new Error('the draft loop returned no answer')
    }
    return text
  }
}

/** The ontology as the draft loop's schema text, with the answer format. */
export function renderOrgSchema(ontology: GraphOntology): string {
  const classes = ontology.classes.map((c) => {
    const props = [
      ...c.required.map((p) => `${p} (required)`),
      ...c.optional.map((p) => `${p} (optional)`),
    ]
    const closed = Object.entries(c.closed).map(([p, vs]) => `${p} one of ${vs.join('/')}`)
    const dates = c.dates.map((p) => `${p} is an ISO day YYYY-MM-DD`)
    const how = c.creatable ? '' : ' Link only: never propose a new one.'
    return `- ${c.label}: ${[...props, ...closed, ...dates].join('; ')}.${how}`
  })
  const relations = ontology.relations
    .filter((r) => r.proposable)
    .map((r) => `- (${r.from.join('|')})-[:${r.type}]->(${r.to.join('|')})`)
  return [
    'ORGANIZATIONAL ONTOLOGY. Read the graph to find which named nodes already exist; never write.',
    'Classes:',
    ...classes,
    'Relations:',
    ...relations,
    'Rules: every value must be copied from the user message; every element carries `evidence`, a span copied verbatim from the user message; use the stored name of a node that already exists; propose nothing for a question, hypothetical, opinion, rumour or anything about a person.',
    // LD-22: the first live private-tier run declined a new project because the
    // graph did not hold it yet, which is the case the hook exists for.
    'A named node the graph does not hold yet is proposed as a new node, unless its class says Link only: not finding it is no reason for no-proposal.',
    'Answer (Return) with JSON only: {"verdict":"propose","assertions":[{"nodes":[{"ref":"a","label":"Project","properties":{"name":"…"},"evidence":"…"}],"edges":[{"type":"…","from":"a","to":"b","evidence":"…"}]}]}. If nothing is worth proposing, answer {"verdict":"no-proposal","reason":"short reason"}. A propose answer is checked before the loop can finish: use validator feedback to repair it or conclude no-proposal, within the remaining turns. Never override a validator refusal.',
  ].join('\n')
}

/** Most elements one draft may carry; a longer draft is not parsed. */
export const MAX_DRAFT_ELEMENTS = 200

type OrgDraftAnswer =
  | { readonly verdict: 'propose'; readonly draft: OrgDraft }
  | { readonly verdict: 'no-proposal'; readonly reason: string }

/** The loop's closed verdict envelope. The reason stays in scratch context. */
function parseOrgDraftAnswer(text: string): OrgDraftAnswer | null {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text)
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(fenced ? fenced[1] : text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (
    raw.verdict === 'no-proposal' &&
    Object.keys(raw).every((k) => ['verdict', 'reason'].includes(k)) &&
    typeof raw.reason === 'string' &&
    raw.reason.trim() !== ''
  )
    return { verdict: 'no-proposal', reason: raw.reason }
  if (
    raw.verdict !== 'propose' ||
    !Object.keys(raw).every((k) => ['verdict', 'assertions'].includes(k))
  )
    return null
  const draft = parseOrgDraft(JSON.stringify({ assertions: raw.assertions }))
  return draft ? { verdict: 'propose', draft } : null
}

/**
 * Parse the draft strictly: a JSON object (optionally inside ONE ```json
 * fence) with `assertions`, each `{ nodes, edges }` of the closed shapes
 * below and nothing else. Refs are scoped to their assertion. Returns null on
 * anything else — nothing is repaired.
 */
export function parseOrgDraft(text: string): OrgDraft | null {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text)
  let raw: unknown
  try {
    raw = JSON.parse(fenced ? fenced[1] : text)
  } catch {
    return null
  }
  const obj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
  const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
  const only = (o: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(o).every((k) => keys.includes(k))
  if (!obj(raw) || !only(raw, ['assertions']) || !Array.isArray(raw.assertions)) return null
  const elements: DraftElement[] = []
  for (const [i, a] of raw.assertions.entries()) {
    if (!obj(a) || !only(a, ['nodes', 'edges'])) return null
    const nodes = a.nodes ?? []
    const edges = a.edges ?? []
    if (!Array.isArray(nodes) || !Array.isArray(edges)) return null
    for (const n of nodes) {
      if (!obj(n) || !only(n, ['ref', 'label', 'properties', 'evidence'])) return null
      if (!str(n.ref) || !str(n.label) || !str(n.evidence) || !obj(n.properties)) return null
      const properties: Record<string, string> = {}
      for (const [k, v] of Object.entries(n.properties)) {
        if (typeof v !== 'string') return null
        properties[k] = v
      }
      elements.push({
        kind: 'node',
        ref: `${i}:${n.ref}`,
        label: n.label,
        properties,
        evidence: n.evidence,
        assertion: i,
      })
    }
    for (const e of edges) {
      if (!obj(e) || !only(e, ['type', 'from', 'to', 'evidence'])) return null
      if (!str(e.type) || !str(e.from) || !str(e.to) || !str(e.evidence)) return null
      elements.push({
        kind: 'edge',
        type: e.type,
        from: `${i}:${e.from}`,
        to: `${i}:${e.to}`,
        evidence: e.evidence,
        assertion: i,
      })
    }
    if (elements.length > MAX_DRAFT_ELEMENTS) return null
  }
  return { elements }
}

// ============================================================================
// The proposal
// ============================================================================

export const ORG_KNOWLEDGE_CONFIRM_KIND = 'orgKnowledge.confirm'
export const ORG_KNOWLEDGE_CONFIRM_ADD = 'add'
export const ORG_KNOWLEDGE_CONFIRM_DISCARD = 'discard'

/** The request a validated draft is proposed under. One flag per assertion,
 *  labelled positionally; `summary` carries the count and the closed set of
 *  classes — never a name, a value or the user's words, because the event
 *  outlives the payload. `add` may never be picked by a rule; `discard` is the
 *  only option an unattended rule may pick, and `park` picks nothing. */
export function orgKnowledgeConfirmRequest(
  assertions: readonly CheckedAssertion[],
  eventId: string,
  expiresInMs: number = DEFAULT_PROPOSAL_TTL_MS,
): HitlRequest {
  const classes = new Set<string>()
  for (const a of assertions) for (const n of a.nodes) classes.add(n.element.label)
  return {
    kind: ORG_KNOWLEDGE_CONFIRM_KIND,
    key: eventId,
    question:
      assertions.length === 1
        ? 'Add this to the organizational graph?'
        : 'Add these to the organizational graph?',
    options: [
      {
        id: ORG_KNOWLEDGE_CONFIRM_ADD,
        label: 'Add to Org.graph',
        flags: assertions.map((a, i) => ({
          id: `a${a.index}`,
          label: `Item ${i + 1}`,
          default: true,
        })),
      },
      { id: ORG_KNOWLEDGE_CONFIRM_DISCARD, label: 'Discard', unattended: true, tone: 'caution' },
    ],
    defaultOption: ORG_KNOWLEDGE_CONFIRM_ADD,
    summary: { items: assertions.length, classes: [...classes].sort().join(',') },
    unattended: 'park',
    expiresInMs,
  }
}

/** What the host holds for a proposal, under its request id. */
export interface OrgProposalPayload {
  readonly v: 1
  readonly tier: string
  readonly eventId: string
  readonly conversationId: string
  readonly assertions: readonly CheckedAssertion[]
}

/** Where a proposal's payload waits for the person (the host's). */
export interface OrgConfirmSeam {
  hold(entry: {
    readonly requestId: string
    readonly expiresAt: number
    readonly payload: OrgProposalPayload
  }): Promise<void>
  readonly expiresInMs?: number
}

/** Is `value` a payload this module wrote? Server-held, but serialized and read
 *  back: anything that does not parse is refused rather than half-applied. */
export function parseOrgProposalPayload(value: unknown): OrgProposalPayload | null {
  const str = (v: unknown): v is string => typeof v === 'string' && v !== ''
  const rec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
  if (!rec(value)) return null
  if (value.v !== 1 || !str(value.tier) || !str(value.eventId) || !str(value.conversationId))
    return null
  if (!Array.isArray(value.assertions) || value.assertions.length === 0) return null
  const indexes = new Set<number>()
  for (const a of value.assertions as unknown[]) {
    if (!rec(a) || !Number.isInteger(a.index) || indexes.has(a.index as number)) return null
    indexes.add(a.index as number)
    if (!Array.isArray(a.nodes) || !Array.isArray(a.edges) || a.nodes.length === 0) return null
    for (const n of a.nodes as unknown[]) {
      if (!rec(n) || !rec(n.element) || !rec(n.properties)) return null
      if (!['new', 'reinforces', 'updates'].includes(n.verdict as string)) return null
      if (n.existing !== null && !(rec(n.existing) && str(n.existing.key))) return null
    }
    for (const e of a.edges as unknown[]) {
      if (!rec(e) || !rec(e.element) || !Array.isArray(e.removes)) return null
    }
  }
  return value as unknown as OrgProposalPayload
}

// ============================================================================
// The settle
// ============================================================================

export interface OrgKnowledgeConfig {
  /** REQUIRED: the graph store (the host's adapter). */
  readonly store: OrgKnowledgeStore
  /** REQUIRED: the ontology every proposal is checked against. */
  readonly ontology: GraphOntology
  /** REQUIRED: the systemone decision seam. */
  readonly decide: DecideFn
  /** REQUIRED: the dry run. */
  readonly draft: OrgDraftFn
  /** REQUIRED: the turn's owner, from the host's request context. */
  readonly owner: () => string | null
  /** REQUIRED: the deployment switch. Absent or false proposes nothing. */
  readonly enabled: () => boolean | Promise<boolean>
  /** REQUIRED: whether a text names a member of the roster (V9). */
  readonly mentionsMember: (text: string) => boolean
  /** Where a proposal waits. Absent: nothing can be confirmed, so nothing is
   *  proposed (`no-confirmation`). */
  readonly confirm?: OrgConfirmSeam
  /** The wake to wait on before any model call. Absent → no wake. */
  readonly awaitWake?: (budgetMs: number) => Promise<'awake' | 'skipped'>
  readonly wakeBudgetMs?: number
  /** Default: the run frame's `inference.tier`. */
  readonly tier?: () => string | undefined
  /** The ISO day the message was said. Default: today, UTC. */
  readonly today?: () => string
  readonly maxAssertions?: number
}

export type OrgKnowledgeSkip =
  | 'no-user'
  | 'disabled'
  | 'no-tier'
  | 'turn-failed'
  | 'no-pair'
  | 'no-event-id'
  | 'no-confirmation'
  | 'waking'
  | 'gate-error'
  | 'gate'
  | 'draft-error'
  | 'draft-unparseable'
  | 'no-proposal'
  | 'graph-read-error'
  | 'nothing-valid'
  | 'only-reinforces'
  | 'already-proposed'
  | 'error'

export interface OrgKnowledgeReport {
  readonly proposed: number
  readonly rejected: Readonly<Partial<Record<OrgRule, number>>>
  readonly skipped?: OrgKnowledgeSkip
}

const DEFAULT_WAKE_BUDGET_MS = 180_000

function errorKind(e: unknown): string {
  return e instanceof Error && e.name ? e.name : 'Error'
}

function logStop(reason: string, extra = ''): void {
  console.warn(`[org-knowledge] proposed nothing: ${reason}${extra ? ` (${extra})` : ''}`)
}

/** An assertion that writes nothing: every node and edge only reinforces. */
export function onlyReinforces(a: CheckedAssertion): boolean {
  return (
    a.nodes.every((n) => n.verdict === 'reinforces') &&
    a.edges.every((e) => e.verdict === 'reinforces' && e.removes.length === 0)
  )
}

/**
 * Propose what the turn's user message asserts, for a person to accept. Never
 * throws; never writes to the graph.
 */
export async function settleOrgKnowledge(
  ctx: UnifiedContext,
  cfg: OrgKnowledgeConfig,
  turn: { readonly conversationId?: string } = {},
): Promise<OrgKnowledgeReport> {
  const scope: PatternScope<Record<string, never>> = {
    id: 'org-knowledge',
    events: [],
    data: {},
    startTime: Date.now(),
  }
  try {
    return await run(ctx, cfg, turn, scope)
  } catch (err) {
    logStop('unexpected failure', errorKind(err))
    return { proposed: 0, rejected: {}, skipped: 'error' }
  } finally {
    ctx.events.push(...scope.events.splice(0))
  }
}

async function run(
  ctx: UnifiedContext,
  cfg: OrgKnowledgeConfig,
  turn: { readonly conversationId?: string },
  scope: PatternScope<Record<string, never>>,
): Promise<OrgKnowledgeReport> {
  const stop = (
    skipped: OrgKnowledgeSkip,
    extra?: string,
    rejected: OrgKnowledgeReport['rejected'] = {},
  ) => {
    logStop(skipped, extra)
    return { proposed: 0, rejected, skipped }
  }

  // This step's events are never the transcript.
  setLivePatternEnabled(false)

  // --- 1. preconditions -------------------------------------------------------
  const userId = cfg.owner()
  if (userId === null || userId === undefined || userId === '') return stop('no-user')
  try {
    if (!(await cfg.enabled())) return stop('disabled')
  } catch (err) {
    return stop('disabled', `switch unreadable: ${errorKind(err)}`)
  }
  const tier = cfg.tier ? cfg.tier() : currentRunFrame()?.inference?.tier
  if (typeof tier !== 'string' || tier === '') return stop('no-tier')
  if (ctx.status === 'error' || ctx.status === 'paused') return stop('turn-failed', ctx.status)
  const window = readStoreWindow(ctx.events, 1)
  if (!window) return stop('no-pair')
  const userEventId = window.userEventId
  if (!userEventId) return stop('no-event-id')
  if (!cfg.confirm) return stop('no-confirmation')
  // The current user message ALONE: the target is shared, so neither the reply
  // nor an earlier turn is read (LD-8).
  const userMessage = window.pairs[window.pairs.length - 1].user

  // --- 2. the wake --------------------------------------------------------------
  if (cfg.awaitWake) {
    let outcome: 'awake' | 'skipped' = 'skipped'
    try {
      outcome = await cfg.awaitWake(cfg.wakeBudgetMs ?? DEFAULT_WAKE_BUDGET_MS)
    } catch {
      outcome = 'skipped'
    }
    if (outcome !== 'awake') return stop('waking')
  }

  // --- 3. the gate --------------------------------------------------------------
  const gate = await decide(
    scope,
    { decide: cfg.decide, spec: ORG_KNOWLEDGE_GATE, state: userMessage },
    { trackHistory: 'decision_made', errorSeverity: 'recoverable' },
  )
  ctx.events.push(...scope.events.splice(0))
  if (gate.reason === 'error' || gate.label === null) return stop('gate-error')
  if (gate.label !== ORG_KNOWLEDGE_ADD) return stop('gate')

  // --- 4–8. deliberate: parse, snapshot and validate inside the loop ---------------
  let validated:
    | {
        text: string
        checked: ReturnType<typeof validateOrgDraft>
        writing: CheckedAssertion[]
      }
    | undefined
  let failure:
    | {
        skipped: OrgKnowledgeSkip
        rejected: OrgKnowledgeReport['rejected']
      }
    | undefined
  const refuse = (
    skipped: OrgKnowledgeSkip,
    rejected: OrgKnowledgeReport['rejected'] = {},
    summary: string = skipped,
  ) => {
    failure = { skipped, rejected }
    return `Validator: ${summary}; rejected: ${JSON.stringify(rejected)}. Repair the draft using only the user's message, or Return no-proposal with a short reason.`
  }
  const validate = async (text: string): Promise<string | undefined> => {
    validated = undefined
    failure = undefined
    const answer = parseOrgDraftAnswer(text)
    if (!answer) return refuse('draft-unparseable')
    if (answer.verdict === 'no-proposal') return undefined
    const { draft } = answer
    const names: { label: string; name: string }[] = []
    for (const el of draft.elements) {
      if (el.kind !== 'node') continue
      const cls = classOf(cfg.ontology, el.label)
      const name = cls?.nameProperty ? el.properties[cls.nameProperty] : undefined
      if (name) names.push({ label: el.label, name })
    }
    let snapshot
    try {
      snapshot = await cfg.store.snapshot({ names, keys: [] })
    } catch {
      // An infrastructure failure cannot be repaired by a model.
      refuse('graph-read-error')
      throw new Error('org graph snapshot unavailable')
    }
    const checked = validateOrgDraft(draft, snapshot, cfg.ontology, {
      userMessage,
      today: cfg.today ? cfg.today() : new Date().toISOString().slice(0, 10),
      mentionsMember: cfg.mentionsMember,
      ...(cfg.maxAssertions !== undefined && { maxAssertions: cfg.maxAssertions }),
    })
    if (checked.accepted.length === 0 || Object.keys(checked.rejected).length > 0) {
      const label = checked.accepted.length > 0 ? 'partly-valid' : 'nothing-valid'
      const assertions = checked.rejectedAssertions.map(({ index, rule }) => `a${index}: ${rule}`)
      return refuse(
        'nothing-valid',
        checked.rejected,
        `${label}; assertions: ${assertions.join(', ')}`,
      )
    }
    const writing = checked.accepted.filter((a) => !onlyReinforces(a))
    if (writing.length === 0) return refuse('only-reinforces', checked.rejected)
    validated = { text, checked, writing }
    return undefined
  }
  let text: string
  try {
    text = await cfg.draft({ userMessage, schema: renderOrgSchema(cfg.ontology), validate })
  } catch (err) {
    // A later model/transport failure is not the previous round's verdict.
    // Retain it only when the loop actually exhausted its repair budget (or
    // the current validation itself failed to read the graph).
    if (!(err instanceof OrgDraftBudgetExhaustedError) && failure?.skipped !== 'graph-read-error')
      failure = undefined
    return failure
      ? stop(failure.skipped, undefined, failure.rejected)
      : stop('draft-error', errorKind(err))
  }
  const answer = parseOrgDraftAnswer(text)
  if (answer?.verdict === 'no-proposal') return stop('no-proposal')
  // A custom draft seam cannot bypass the deterministic final check or return
  // a different candidate from the one that passed inside the loop.
  if (validated?.text !== text) {
    try {
      await validate(text)
    } catch {
      return stop('graph-read-error')
    }
  }
  if (!validated) return stop(failure?.skipped ?? 'nothing-valid', undefined, failure?.rejected)
  const { checked, writing } = validated

  // --- 9 + 10. propose and hold ------------------------------------------------------
  const ttl = cfg.confirm.expiresInMs ?? DEFAULT_PROPOSAL_TTL_MS
  const before = ctx.events.length
  const outcome = proposeToHuman(ctx, orgKnowledgeConfirmRequest(writing, userEventId, ttl), {
    attended: true,
    patternId: 'org-knowledge',
  })
  if (ctx.events.length === before) return stop('already-proposed', undefined, checked.rejected)
  if (outcome.status !== 'pending')
    return stop('error', 'the proposal was not left pending', checked.rejected)
  try {
    await cfg.confirm.hold({
      requestId: outcome.requestId,
      expiresAt: Date.now() + ttl,
      payload: {
        v: 1,
        tier,
        eventId: userEventId,
        conversationId: turn.conversationId ?? ctx.sessionId,
        assertions: writing,
      },
    })
  } catch (err) {
    ctx.events.splice(before, ctx.events.length - before)
    return stop('error', `the proposal could not be held: ${errorKind(err)}`, checked.rejected)
  }
  return { proposed: writing.length, rejected: checked.rejected }
}

// ============================================================================
// The apply
// ============================================================================

export type OrgApplyOutcome = 'applied' | 'stale' | 'failed'

export interface OrgApplyReport {
  /** Per selected assertion, by its flag id (`a<index>`). */
  readonly items: Readonly<Record<string, OrgApplyOutcome>>
  /** The stored keys of every applied assertion's nodes, by draft ref. */
  readonly keys: Readonly<Record<string, string>>
}

/**
 * Write what the person selected. `payload` is the host's own record, never
 * client input; `selected` are the flag ids the answer chose (an unknown id
 * selects nothing). No model is consulted. Each assertion is one store
 * transaction, refused `stale` on its own when what its preview read changed.
 * Never throws: a store failure is that item's `failed`.
 */
export async function applyOrgProposal(
  cfg: { readonly store: OrgKnowledgeStore },
  input: {
    readonly payload: OrgProposalPayload
    readonly selected: readonly string[]
    readonly actor: OrgActor
  },
): Promise<OrgApplyReport> {
  const items: Record<string, OrgApplyOutcome> = {}
  const keys: Record<string, string> = {}
  const chosen = new Set(input.selected)
  for (const a of input.payload.assertions) {
    const id = `a${a.index}`
    if (!chosen.has(id)) continue
    let result: OrgApplyResult
    try {
      result = await cfg.store.apply(a, input.actor)
    } catch (err) {
      console.warn(`[org-knowledge] an accepted item was not written (${errorKind(err)})`)
      items[id] = 'failed'
      continue
    }
    items[id] = result.status
    if (result.status === 'applied') Object.assign(keys, result.keys)
  }
  return { items, keys }
}

// ============================================================================
// The opt-in
// ============================================================================

/**
 * Opt a harness into the hook: the host gates `settleOrgKnowledge` on
 * `harnessUsesOrgKnowledge(patterns)`. The hook runs after the reply, so no
 * pattern runs for it; the declaration rides the first top-level pattern's
 * `capabilities`, on a copy, and changes nothing about how any pattern runs.
 */
export function withOrgKnowledge() {
  return <T>(patterns: ConfiguredPattern<T>[]): ConfiguredPattern<T>[] => {
    if (patterns.length === 0) throw new Error('withOrgKnowledge: no patterns to opt in')
    const [first, ...rest] = patterns
    return [{ ...first, capabilities: { ...first.capabilities, orgKnowledge: true } }, ...rest]
  }
}
