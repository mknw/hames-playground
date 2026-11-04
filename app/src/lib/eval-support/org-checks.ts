/**
 * The organizational-knowledge graders of the general-next Eval (org-knowledge
 * slice 7). Each reads the {@link OrgTrace} the driver records — the synthetic
 * graph before and after, the proposal each turn raised, the person's answers —
 * or, for the canvas, the turn's own graph tool results. Never the reply's
 * wording: "nothing was proposed" reads the trace, not a reply that says so.
 *
 * Pure: `org-checks.test.ts` holds a red for each (a scripted trace that does
 * the forbidden thing fails it).
 */
import { extractGraphElements } from '@hames-ai/agents/graph-extractor'
import { nameKey } from '@hames-ai/harness-patterns/org-knowledge-ontology'
import type { ContextEvent } from '@hames-ai/harness-patterns'
import type { Check } from './conversation'
import type { OrgCheck, OrgExpectations, OrgNodeSnapshot, OrgTrace } from './org-scenario'

const check = (name: string, pass: boolean, detail: string): Check => ({ name, pass, detail })

/** What a node is called: its name, a member's display name, a deadline's
 *  label, a fact's text. */
export function nodeName(n: OrgNodeSnapshot): string {
  const p = n.properties
  return p.name ?? p.displayName ?? p.label ?? p.text ?? ''
}

const contains = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase())

/** A proposal on the turn (any turn when none is named) whose elements carry
 *  every term (a class or relation type) and name every fact. */
export function proposalRaisedCheck(
  trace: OrgTrace | undefined,
  c: Extract<OrgCheck, { check: 'proposalRaised' }>,
): Check {
  const turns = (trace?.turns ?? []).flatMap((t, i) =>
    c.turn === undefined || c.turn === i + 1 ? [t] : [],
  )
  const hit = turns.find((t) => {
    const els = t.proposal?.elements ?? []
    const names = els.flatMap((e) => [...e.names, ...e.removes])
    return (
      els.length > 0 &&
      c.terms.every((term) => els.some((e) => e.term === term)) &&
      c.facts.every((f) => names.some((n) => contains(n, f)))
    )
  })
  const seen = turns.map((t, i) =>
    t.proposal
      ? `turn ${i + 1}: ${t.proposal.elements.map((e) => `${e.term}(${e.names.join('/')})`).join(', ')}`
      : `turn ${i + 1}: none (${t.settle.skipped ?? 'no stop'})`,
  )
  return check(`proposal raised: ${c.says}`, !!hit, seen.join('; ') || 'no org turn recorded')
}

/** No turn raised an org-knowledge proposal (and so none named a fact). */
export function noProposalRaisedCheck(
  trace: OrgTrace | undefined,
  c: Extract<OrgCheck, { check: 'noProposalRaised' }>,
): Check {
  const raised = (trace?.turns ?? []).flatMap((t, i) => (t.proposal ? [i + 1] : []))
  return check(
    `no proposal raised: ${c.says}`,
    !!trace && raised.length === 0,
    !trace
      ? 'no org trace: the hook did not run'
      : raised.length
        ? `proposal on turn ${raised.join(', ')}`
        : trace.turns.map((t, i) => `turn ${i + 1}: ${t.settle.skipped ?? 'no stop'}`).join('; '),
  )
}

/** After the last turn, exactly `count` entries: nodes of a label in `terms`
 *  (any label when none is) named one of `facts` (any name when none is), or —
 *  when a term is a relation type — edges of that type touching a node named
 *  one of `facts`. */
export function graphEntryCountCheck(
  trace: OrgTrace | undefined,
  c: Extract<OrgCheck, { check: 'graphEntryCount' }>,
): Check {
  if (!trace) return check(`graph count: ${c.says}`, false, 'no org trace')
  const { nodes, edges } = trace.final
  const keys = (c.facts ?? []).map(nameKey)
  const named = (n: OrgNodeSnapshot | undefined) =>
    !!n && (keys.length === 0 || keys.includes(nameKey(nodeName(n))))
  const types = new Set(edges.map((e) => e.type))
  const relation = (c.terms ?? []).find((t) => types.has(t) || /^[A-Z_]+$/.test(t))
  let found: number
  if (relation) {
    const byKey = new Map(nodes.map((n) => [n.key, n]))
    found = edges.filter(
      (e) => e.type === relation && (named(byKey.get(e.from)) || named(byKey.get(e.to))),
    ).length
  } else {
    found = nodes.filter((n) => (!c.terms?.length || c.terms.includes(n.label)) && named(n)).length
  }
  return check(`graph count: ${c.says}`, found === c.count, `${found} found, want ${c.count}`)
}

/** No node after the last turn is named (in part) by any of the facts. */
export function graphLacksEntryCheck(
  trace: OrgTrace | undefined,
  c: Extract<OrgCheck, { check: 'graphLacksEntry' }>,
): Check {
  if (!trace) return check(`graph lacks: ${c.says}`, false, 'no org trace')
  const hits = trace.final.nodes.filter((n) => c.facts.some((f) => contains(nodeName(n), f)))
  return check(
    `graph lacks: ${c.says}`,
    hits.length === 0,
    hits.length ? `present: ${hits.map((n) => `${n.label} ${nodeName(n)}`).join(', ')}` : 'absent',
  )
}

/** The node named `node` carries `property` = `equals` (an owner placeholder
 *  such as `$userA` is resolved to that owner's id). */
export function graphNodePropertyCheck(
  trace: OrgTrace | undefined,
  c: Extract<OrgCheck, { check: 'graphNodeProperty' }>,
): Check {
  if (!trace) return check(`node property: ${c.says}`, false, 'no org trace')
  const want = c.equals.startsWith('$') ? trace.owners[c.equals] : c.equals
  const n = trace.final.nodes.find((x) => nameKey(nodeName(x)) === nameKey(c.node))
  const got = n?.properties[c.property]
  return check(
    `node property: ${c.says}`,
    want !== undefined && got === want,
    n
      ? `${c.property} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`
      : `no node ${c.node}`,
  )
}

/** The canvas of the 1-based turn receives every fact: an element the turn's
 *  graph tool results draw is named by it. */
export function graphElementsIncludeCheck(
  turns: ReadonlyArray<{ events: readonly ContextEvent[] }>,
  c: Extract<OrgCheck, { check: 'graphElementsInclude' }>,
): Check {
  const events = turns[c.turn - 1]?.events ?? []
  const labels = extractGraphElements([...events]).map((el) => {
    const d = (el as { data?: Record<string, unknown> }).data ?? {}
    return String(d.label ?? d.name ?? d.id ?? '')
  })
  const missing = c.facts.filter((f) => !labels.some((l) => contains(l, f)))
  return check(
    `canvas includes: ${c.says}`,
    missing.length === 0,
    missing.length ? `missing ${missing.join(', ')}` : `${labels.length} element(s)`,
  )
}

/** Every org check of a row, in order. */
export function orgChecks(
  expect: OrgExpectations,
  trace: OrgTrace | undefined,
  turns: ReadonlyArray<{ events: readonly ContextEvent[] }>,
): Check[] {
  return expect.map((c) => {
    switch (c.check) {
      case 'proposalRaised':
        return proposalRaisedCheck(trace, c)
      case 'noProposalRaised':
        return noProposalRaisedCheck(trace, c)
      case 'graphEntryCount':
        return graphEntryCountCheck(trace, c)
      case 'graphLacksEntry':
        return graphLacksEntryCheck(trace, c)
      case 'graphNodeProperty':
        return graphNodePropertyCheck(trace, c)
      case 'graphElementsInclude':
        return graphElementsIncludeCheck(turns, c)
    }
  })
}
