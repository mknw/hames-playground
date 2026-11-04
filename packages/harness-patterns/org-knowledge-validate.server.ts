/**
 * The organizational-knowledge validator — the deterministic check every
 * drafted node, property and edge passes before a person sees it
 * (`docs/plan/org-knowledge-hook.md`, "The validator", slice 1).
 *
 * The draft is a model's output and is trusted for nothing. Each element runs
 * the rules below in order; the FIRST failure drops the element's whole
 * assertion (so no half-assertion survives) and is counted under its rule id.
 * Nothing is repaired and no model is consulted.
 *
 *   V1  the label / relation type is in the ontology and may be proposed; a
 *       node of a class the hook may not create (a member, a pillar) must
 *       already exist
 *   V2  properties: required present (new nodes), nothing undeclared or
 *       derived drafted, closed sets, ISO days, one-line texts
 *   V3  the element's evidence is a verbatim span of the CURRENT user message,
 *       at least 8 characters after NFKC (the memory store's D9 rule)
 *   V4  value closure: every drafted value's token sequence occurs
 *       contiguously in the message's ({@link valueTokens}); closed-set values
 *       are vocabulary and exempt; an ISO day passes when its day, month and
 *       year are in the message (the year may be implied, below). Nothing but
 *       the message is searched — not the graph rows the snapshot carries
 *   V5  an endpoint resolves to at most one existing node; a node the hook may
 *       not create carries nothing but its name
 *   V6  cardinalities, over the snapshot and the whole draft: `max` per node,
 *       `min` for a new node, and an existing edge to another node either
 *       replaced (shown as removed) or refused
 *   V7  an edge's ends are nodes of its own assertion with the declared labels
 *   V8  the injection sanitizer reports zero findings on every stored value,
 *       because another user's turn reads it with K1 only
 *   V9  a person-free class (a fact) names no member of the roster in its
 *       text or evidence
 *   V10 not a drop: each surviving element's verdict, `new`, `reinforces` or
 *       `updates`
 *
 * At most `maxAssertions` (default 8) assertions are checked, in draft order;
 * the rest are counted under `cap`.
 */

import { assertServerOnImport } from './assert.server'
import { sanitizeUntrusted } from './injection-guard'
import { MIN_EVIDENCE_CHARS } from './memory-acceptance.server'
import {
  MAX_TEXT_CHARS,
  classOf,
  nameKey,
  relationOf,
  valueTokens,
  type GraphOntology,
  type OntologyClass,
} from './org-knowledge-ontology'

assertServerOnImport()

// ============================================================================
// Inputs
// ============================================================================

/** A drafted node. `ref` names it within the draft; an edge points at refs. An
 *  existing node is drafted the same way, by its label and name, and resolves
 *  against the snapshot. */
export interface DraftNode {
  readonly kind: 'node'
  readonly ref: string
  readonly label: string
  readonly properties: Readonly<Record<string, string>>
  /** The span of the user's message this element rests on. */
  readonly evidence: string
  readonly assertion: number
}

export interface DraftEdge {
  readonly kind: 'edge'
  readonly type: string
  readonly from: string
  readonly to: string
  readonly evidence: string
  readonly assertion: number
}

export type DraftElement = DraftNode | DraftEdge

export interface OrgDraft {
  readonly elements: readonly DraftElement[]
}

/** A node the host read for the names and ids the draft references. `key` is
 *  its stable identity (its `id`, or a legacy key the host chose). */
export interface SnapshotNode {
  readonly key: string
  readonly label: string
  readonly properties: Readonly<Record<string, string>>
}

export interface SnapshotEdge {
  readonly type: string
  /** Node keys. */
  readonly from: string
  readonly to: string
}

export interface GraphSnapshot {
  readonly nodes: readonly SnapshotNode[]
  readonly edges: readonly SnapshotEdge[]
}

export interface OrgValidateContext {
  /** The CURRENT user message — the only text a value may come from. */
  readonly userMessage: string
  /** The ISO day the message was said, for derived `today` values and implied
   *  years. */
  readonly today: string
  /** Whether `text` names a person in the host's roster (V9). */
  readonly mentionsMember: (text: string) => boolean
  readonly maxAssertions?: number
}

// ============================================================================
// Output
// ============================================================================

export type OrgVerdict = 'new' | 'reinforces' | 'updates'

export type OrgRule = 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6' | 'V7' | 'V8' | 'V9' | 'cap'

export interface CheckedNode {
  readonly element: DraftNode
  readonly verdict: OrgVerdict
  /** The node this one merges onto, when it is not new. */
  readonly existing: SnapshotNode | null
  /** What would be stored: the drafted properties plus the derived ones. */
  readonly properties: Readonly<Record<string, string>>
}

export interface CheckedEdge {
  readonly element: DraftEdge
  readonly verdict: Exclude<OrgVerdict, 'updates'>
  /** Existing edges this one replaces (a coordinator, a pillar): shown to the
   *  person and removed in the same write. */
  readonly removes: readonly SnapshotEdge[]
}

export interface CheckedAssertion {
  readonly index: number
  readonly nodes: readonly CheckedNode[]
  readonly edges: readonly CheckedEdge[]
}

export interface OrgValidation {
  readonly accepted: readonly CheckedAssertion[]
  readonly rejected: Readonly<Partial<Record<OrgRule, number>>>
}

export const DEFAULT_MAX_ASSERTIONS = 8

// ============================================================================
// The validator
// ============================================================================

class Drop extends Error {
  constructor(readonly rule: OrgRule) {
    super(rule)
  }
}

const nfkc = (s: string): string => s.normalize('NFKC')
const LINE_BREAK = /[\r\n\u2028\u2029\u0085]/u
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

export function validateOrgDraft(
  draft: OrgDraft,
  snapshot: GraphSnapshot,
  ontology: GraphOntology,
  ctx: OrgValidateContext,
): OrgValidation {
  const rejected: Partial<Record<OrgRule, number>> = {}
  const count = (rule: OrgRule, n = 1): void => {
    rejected[rule] = (rejected[rule] ?? 0) + n
  }

  // Group by assertion, in draft order; cap the number checked.
  const groups = new Map<number, DraftElement[]>()
  for (const el of draft.elements) {
    const g = groups.get(el.assertion) ?? []
    g.push(el)
    groups.set(el.assertion, g)
  }
  const max = ctx.maxAssertions ?? DEFAULT_MAX_ASSERTIONS
  const ordered = [...groups.entries()]
  if (ordered.length > max) count('cap', ordered.length - max)
  const kept = ordered.slice(0, max)

  const messageTokens = valueTokens(ctx.userMessage)
  const message = nfkc(ctx.userMessage)

  // Resolve every node once; the draft-wide cardinality count needs every
  // assertion's endpoints, not only the one being checked.
  const refCounts = new Map<string, number>()
  for (const [, els] of kept)
    for (const el of els)
      if (el.kind === 'node') refCounts.set(el.ref, (refCounts.get(el.ref) ?? 0) + 1)

  const draftEdges = kept.flatMap(([, els]) => els.filter((e): e is DraftEdge => e.kind === 'edge'))
  const draftNodes = new Map<string, DraftNode>()
  for (const [, els] of kept)
    for (const el of els) if (el.kind === 'node') draftNodes.set(el.ref, el)

  const accepted: CheckedAssertion[] = []
  for (const [index, els] of kept) {
    try {
      accepted.push(
        checkAssertion(index, els, {
          ontology,
          snapshot,
          ctx,
          message,
          messageTokens,
          refCounts,
          draftEdges,
          draftNodes,
        }),
      )
    } catch (e) {
      if (!(e instanceof Drop)) throw e
      count(e.rule)
    }
  }
  return { accepted, rejected }
}

interface Env {
  readonly ontology: GraphOntology
  readonly snapshot: GraphSnapshot
  readonly ctx: OrgValidateContext
  readonly message: string
  readonly messageTokens: readonly string[]
  readonly refCounts: ReadonlyMap<string, number>
  readonly draftEdges: readonly DraftEdge[]
  readonly draftNodes: ReadonlyMap<string, DraftNode>
}

function checkAssertion(index: number, els: readonly DraftElement[], env: Env): CheckedAssertion {
  const { ontology, snapshot, ctx } = env
  const nodes = els.filter((e): e is DraftNode => e.kind === 'node')
  const edges = els.filter((e): e is DraftEdge => e.kind === 'edge')

  // --- nodes: V1, V5, V2, V3, V4 ------------------------------------------------
  const resolved = new Map<string, SnapshotNode | null>()
  for (const node of nodes) {
    if ((env.refCounts.get(node.ref) ?? 0) > 1) throw new Drop('V7')
    const cls = classOf(ontology, node.label)
    if (!cls) throw new Drop('V1')
    const matches = matchByName(cls, node, snapshot)
    if (matches.length > 1) throw new Drop('V5')
    if (!cls.creatable) {
      if (matches.length === 0) throw new Drop('V1')
      const drafted = Object.keys(node.properties)
      if (drafted.some((p) => p !== cls.nameProperty)) throw new Drop('V5')
    }
    resolved.set(node.ref, matches[0] ?? null)
    checkProperties(cls, node, matches.length === 0)
    checkEvidence(node.evidence, env.message)
    checkClosure(cls, node, env)
  }

  // --- edges: V1, V7, V3 ------------------------------------------------------------
  const byRef = new Map(nodes.map((n) => [n.ref, n]))
  for (const edge of edges) {
    const rel = relationOf(ontology, edge.type)
    if (!rel || !rel.proposable) throw new Drop('V1')
    const from = byRef.get(edge.from)
    const to = byRef.get(edge.to)
    if (!from || !to || !rel.from.includes(from.label) || !rel.to.includes(to.label)) {
      throw new Drop('V7')
    }
    checkEvidence(edge.evidence, env.message)
  }

  // --- owner-identified nodes resolve under their owner ------------------------------
  for (const node of nodes) {
    const cls = classOf(ontology, node.label)!
    if (cls.identity !== 'owner') continue
    resolved.set(node.ref, matchUnderOwner(cls, node, edges, resolved, env))
  }

  const keyOf = (ref: string): string => resolved.get(ref)?.key ?? `ref:${ref}`
  const draftKeyOf = (ref: string): string => {
    const n = env.draftNodes.get(ref)
    if (!n) return `ref:${ref}`
    const cls = classOf(ontology, n.label)
    if (!cls) return `ref:${ref}`
    const m = cls.identity === 'nameKey' ? matchByName(cls, n, snapshot) : []
    return m.length === 1 ? m[0].key : `ref:${ref}`
  }

  // --- V6: cardinalities ---------------------------------------------------------
  const removesByEdge = new Map<DraftEdge, SnapshotEdge[]>()
  for (const edge of edges) {
    const rel = relationOf(ontology, edge.type)!
    const card = rel.cardinality
    if (!card) continue
    const pinnedRef = card.side === 'from' ? edge.from : edge.to
    const otherRef = card.side === 'from' ? edge.to : edge.from
    // The whole draft: two edges of this type on one node, to two other nodes.
    const pinnedInDraft = draftKeyOf(pinnedRef)
    const others = new Set(
      env.draftEdges
        .filter((e) => e.type === edge.type)
        .filter((e) => draftKeyOf(card.side === 'from' ? e.from : e.to) === pinnedInDraft)
        .map((e) => draftKeyOf(card.side === 'from' ? e.to : e.from)),
    )
    if (others.size > card.max) throw new Drop('V6')
    // The graph: an existing edge on this node to a different node.
    const pinned = keyOf(pinnedRef)
    const other = keyOf(otherRef)
    const existing = snapshot.edges.filter(
      (e) => e.type === edge.type && (card.side === 'from' ? e.from : e.to) === pinned,
    )
    const conflicting = existing.filter((e) => (card.side === 'from' ? e.to : e.from) !== other)
    if (conflicting.length > 0) {
      if (card.onExisting === 'refuse') throw new Drop('V6')
      removesByEdge.set(edge, conflicting)
    }
  }
  // `min` binds a new node on the pinned side.
  for (const rel of ontology.relations) {
    const card = rel.cardinality
    if (!card || card.min === 0) continue
    const sideLabels = card.side === 'from' ? rel.from : rel.to
    for (const node of nodes) {
      if (!sideLabels.includes(node.label) || resolved.get(node.ref)) continue
      const has = edges.some(
        (e) => e.type === rel.type && (card.side === 'from' ? e.from : e.to) === node.ref,
      )
      if (!has) throw new Drop('V6')
    }
  }

  // --- stored properties, V9, V8, V10 ----------------------------------------------
  const checkedNodes: CheckedNode[] = nodes.map((node) => {
    const cls = classOf(ontology, node.label)!
    const properties: Record<string, string> = { ...node.properties }
    for (const [prop, source] of Object.entries(cls.derived)) {
      properties[prop] = source === 'evidence' ? nfkc(node.evidence).trim() : ctx.today
    }
    if (cls.personFree) {
      const texts = [...cls.lines.map((p) => properties[p] ?? ''), node.evidence]
      if (texts.some((t) => t !== '' && ctx.mentionsMember(t))) throw new Drop('V9')
    }
    for (const value of Object.values(properties)) {
      const { report } = sanitizeUntrusted(
        value,
        { tool: 'org_knowledge', namespace: 'org_knowledge' },
        { spotlight: 'off' },
      )
      if (report.findings.length > 0) throw new Drop('V8')
    }
    const existing = resolved.get(node.ref) ?? null
    return { element: node, verdict: nodeVerdict(cls, node, existing), existing, properties }
  })

  const checkedEdges: CheckedEdge[] = edges.map((edge) => {
    const from = resolved.get(edge.from)
    const to = resolved.get(edge.to)
    const exists =
      !!from &&
      !!to &&
      snapshot.edges.some((e) => e.type === edge.type && e.from === from.key && e.to === to.key)
    return {
      element: edge,
      verdict: exists ? 'reinforces' : 'new',
      removes: removesByEdge.get(edge) ?? [],
    }
  })

  return { index, nodes: checkedNodes, edges: checkedEdges }
}

// ============================================================================
// Rules
// ============================================================================

function matchByName(cls: OntologyClass, node: DraftNode, snapshot: GraphSnapshot): SnapshotNode[] {
  if (cls.identity !== 'nameKey' || cls.nameProperty === null) return []
  const name = node.properties[cls.nameProperty]
  if (typeof name !== 'string' || name.trim() === '') return []
  const key = nameKey(name)
  return snapshot.nodes.filter(
    (n) =>
      n.label === cls.label &&
      typeof n.properties[cls.nameProperty!] === 'string' &&
      nameKey(n.properties[cls.nameProperty!]) === key,
  )
}

/** A node identified under its owner: the same name on a node the owner
 *  already points at with the owning relation (a deadline's label under its
 *  project). A new owner owns nothing yet. */
function matchUnderOwner(
  cls: OntologyClass,
  node: DraftNode,
  edges: readonly DraftEdge[],
  resolved: ReadonlyMap<string, SnapshotNode | null>,
  env: Env,
): SnapshotNode | null {
  if (cls.nameProperty === null) return null
  const name = node.properties[cls.nameProperty]
  if (typeof name !== 'string') return null
  const owning = edges.filter((e) => e.to === node.ref)
  const owners = owning.map((e) => ({ type: e.type, owner: resolved.get(e.from) ?? null }))
  for (const { type, owner } of owners) {
    if (!owner) continue
    const children = new Set(
      env.snapshot.edges.filter((e) => e.type === type && e.from === owner.key).map((e) => e.to),
    )
    const match = env.snapshot.nodes.filter(
      (n) =>
        n.label === cls.label &&
        children.has(n.key) &&
        typeof n.properties[cls.nameProperty!] === 'string' &&
        nameKey(n.properties[cls.nameProperty!]) === nameKey(name),
    )
    if (match.length > 1) throw new Drop('V5')
    if (match.length === 1) return match[0]
  }
  return null
}

function checkProperties(cls: OntologyClass, node: DraftNode, isNew: boolean): void {
  const allowed = new Set([...cls.required, ...cls.optional])
  for (const [prop, value] of Object.entries(node.properties)) {
    if (!allowed.has(prop) || typeof value !== 'string' || value.trim() === '') {
      throw new Drop('V2')
    }
    const closed = cls.closed[prop]
    if (closed && !closed.includes(value)) throw new Drop('V2')
    if (cls.dates.includes(prop) && !isIsoDay(value)) throw new Drop('V2')
    if (
      cls.lines.includes(prop) &&
      (LINE_BREAK.test(value) || Array.from(value).length > MAX_TEXT_CHARS)
    ) {
      throw new Drop('V2')
    }
  }
  if (isNew) {
    for (const prop of cls.required) if (!(prop in node.properties)) throw new Drop('V2')
  }
}

function checkEvidence(evidence: string, message: string): void {
  const span = typeof evidence === 'string' ? nfkc(evidence).trim() : ''
  if (Array.from(span).length < MIN_EVIDENCE_CHARS || !message.includes(span)) {
    throw new Drop('V3')
  }
}

function checkClosure(cls: OntologyClass, node: DraftNode, env: Env): void {
  for (const [prop, value] of Object.entries(node.properties)) {
    if (cls.closed[prop]) continue
    if (cls.dates.includes(prop)) {
      if (!dayIsInMessage(value, env.messageTokens, env.ctx.today)) throw new Drop('V4')
      continue
    }
    if (!containsRun(env.messageTokens, valueTokens(value))) throw new Drop('V4')
  }
}

function nodeVerdict(
  cls: OntologyClass,
  node: DraftNode,
  existing: SnapshotNode | null,
): OrgVerdict {
  if (!existing) return 'new'
  const changed = Object.entries(node.properties).some(
    ([prop, value]) => prop !== cls.nameProperty && (existing.properties[prop] ?? '') !== value,
  )
  return changed ? 'updates' : 'reinforces'
}

// ============================================================================
// Tokens and days
// ============================================================================

/** `needle` occurs as a contiguous run of `hay`. An empty needle never does. */
function containsRun(hay: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0) return false
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

function isIsoDay(value: string): boolean {
  const m = ISO_DAY.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

/**
 * An ISO day passes value closure when the message says it: the day of the
 * month as a token (`15`, `15th`), the month by English name, three-letter
 * abbreviation or number, and the year as a token. When the message names no
 * four-digit year, the year must be the one the day next falls in, on or after
 * the day it was said — the only year the user can have meant without saying
 * it. A message naming a different year fails.
 */
function dayIsInMessage(value: string, tokens: readonly string[], today: string): boolean {
  const m = ISO_DAY.exec(value)
  if (!m || !isIsoDay(today)) return false
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dayForms = new Set([String(day), String(day).padStart(2, '0')])
  const hasDay = tokens.some(
    (t) => dayForms.has(t) || dayForms.has(t.replace(/(st|nd|rd|th)$/u, '')),
  )
  const name = MONTHS[month - 1]
  const monthForms = new Set([
    name,
    name.slice(0, 3),
    String(month),
    String(month).padStart(2, '0'),
  ])
  const hasMonth = tokens.some((t) => monthForms.has(t))
  if (!hasDay || !hasMonth) return false
  const years = tokens.filter((t) => /^\d{4}$/u.test(t)).map(Number)
  if (years.length > 0) return years.includes(year)
  const [ty, tm, td] = today.split('-').map(Number)
  const implied = month > tm || (month === tm && day >= td) ? ty : ty + 1
  return year === implied
}
