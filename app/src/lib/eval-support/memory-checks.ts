/**
 * The memory graders of the general-next Eval. Each reads the {@link MemoryTrace} the
 * driver records — the store's rows before and after, the proposal the store step
 * raised, the answer applied to it, what recall attached, and every input the memory
 * decisions and the extractor were handed — never the reply's wording. A check that
 * says "nothing was stored" reads the store; it is not satisfied by a reply that says so.
 *
 * Pure: `memory-checks.test.ts` holds a red for each (a scripted trace that does the
 * forbidden thing fails it).
 */
import type { Check } from './conversation'
import type {
  MemoryDedupe,
  MemoryExpectations,
  MemoryOwnerId,
  MemoryRowSnapshot,
  MemoryTrace,
} from './memory-scenario'

const check = (name: string, pass: boolean, detail: string): Check => ({ name, pass, detail })
const nfkc = (s: string) => s.normalize('NFKC')
const same = (a: MemoryRowSnapshot, b: MemoryRowSnapshot) => JSON.stringify(a) === JSON.stringify(b)
const byId = (rows: readonly MemoryRowSnapshot[]) =>
  [...rows].sort((a, b) => a.id.localeCompare(b.id))
const turnOf = (trace: MemoryTrace, turn: number) => trace.turns[turn - 1]

/** No `memory.confirm` proposal on any turn, no answer that wrote, and every owner's
 *  rows exactly as seeded (content, evidence and sightings alike). */
export function noMemoryStoredCheck(trace: MemoryTrace): Check {
  const proposed = trace.turns.flatMap((t, i) => (t.proposal ? [i + 1] : []))
  const seed = byId(trace.seed)
  const final = byId(trace.final)
  const unchanged = seed.length === final.length && seed.every((r, i) => same(r, final[i]))
  const reasons = trace.turns.map(
    (t, i) => `turn ${i + 1}: ${t.settle?.skipped ?? (t.settle ? 'no stop' : 'not run')}`,
  )
  return check(
    'no memory proposed or stored',
    proposed.length === 0 && unchanged,
    proposed.length
      ? `proposal raised on turn ${proposed.join(', ')}`
      : unchanged
        ? `store unchanged (${final.length} row(s)); ${reasons.join('; ')}`
        : `store changed: ${JSON.stringify(final)}`,
  )
}

/** One proposal on the turn, its items' preview verdicts as listed, and every item's
 *  evidence a verbatim span of that turn's user message (D9). */
export function memoryProposedCheck(
  trace: MemoryTrace,
  turn: number,
  dedupe: readonly MemoryDedupe[],
): Check {
  const t = turnOf(trace, turn)
  const items = t?.proposal?.items ?? []
  const verdicts = items.map((i) => i.dedupe)
  const verbatim = items.every((i) => nfkc(t!.userMessage).includes(nfkc(i.evidence)))
  return check(
    `turn ${turn}: memory proposed (${dedupe.join(', ')})`,
    !!t?.proposal && JSON.stringify(verdicts) === JSON.stringify(dedupe) && verbatim,
    t?.proposal
      ? `${JSON.stringify(verdicts)}${verbatim ? '' : '; evidence not verbatim from the user message'}`
      : `no proposal (${t?.settle?.skipped ?? 'store step did not stop'}; rejected ${JSON.stringify(t?.settle?.rejected ?? {})})`,
  )
}

/** The person's answer to the turn's proposal had the expected effect on every item. */
export function memoryAnsweredCheck(
  trace: MemoryTrace,
  turn: number,
  outcome: 'written' | 'stale' | 'discarded',
  action?: string,
): Check {
  const answer = turnOf(trace, turn)?.answer
  const pass =
    !!answer &&
    (outcome === 'discarded'
      ? answer.choice === 'discard' && answer.items.length === 0
      : answer.choice === 'save' &&
        !answer.skipped &&
        answer.items.length > 0 &&
        answer.items.every(
          (i) => i.outcome === outcome && (action === undefined || i.action === action),
        ))
  return check(
    `turn ${turn}: answer ${outcome}${action ? ` (${action})` : ''}`,
    pass,
    answer ? JSON.stringify(answer) : 'no answer was applied',
  )
}

/** After the last turn the owner holds exactly one row per fact, each fact in a
 *  different row. An empty list means the owner holds nothing. */
export function memoryRowsCheck(
  trace: MemoryTrace,
  owner: MemoryOwnerId,
  facts: readonly string[],
): Check {
  const rows = trace.final.filter((r) => r.owner === owner)
  const left = [...rows]
  const matched = facts.every((fact) => {
    const at = left.findIndex((r) => r.content.includes(fact))
    if (at < 0) return false
    left.splice(at, 1)
    return true
  })
  return check(
    `${owner} holds ${facts.length} memor${facts.length === 1 ? 'y' : 'ies'}${facts.length ? `: ${facts.join(' · ')}` : ''}`,
    matched && rows.length === facts.length,
    JSON.stringify(rows.map((r) => ({ content: r.content, sightings: r.evidenceCount }))),
  )
}

/** The turn's recall attached rows that carry every fact. */
export function memoryRecalledCheck(
  trace: MemoryTrace,
  turn: number,
  facts: readonly string[],
): Check {
  const t = turnOf(trace, turn)
  const recalled = t?.recalled ?? []
  // The stage a miss happened at: rows read, rows past the floors, the skip reason and
  // the gate's label — counts and labels only, never a memory's text.
  const why = t?.recall
    ? ` · considered ${t.recall.considered}, survivors ${t.recall.survivors}` +
      (t.recall.gate ? `, gate ${t.recall.gate}` : '') +
      (t.recall.skipped ? `, skipped ${t.recall.skipped}` : '')
    : ''
  return check(
    `turn ${turn}: recall attached ${facts.join(' · ')}`,
    facts.every((f) => recalled.some((r) => r.content.includes(f))),
    JSON.stringify(recalled.map((r) => r.content)) + why,
  )
}

/** No turn attached a memory another owner holds. */
export function noForeignMemoryCheck(trace: MemoryTrace): Check {
  const leaks = trace.turns.flatMap((t, i) =>
    t.recalled.filter((r) => r.owner !== t.owner).map((r) => `turn ${i + 1}: ${r.id}`),
  )
  return check(
    'recall never attaches another owner’s memory',
    leaks.length === 0,
    leaks.length
      ? leaks.join(', ')
      : `${trace.turns.reduce((n, t) => n + t.recalled.length, 0)} attached, all the turn owner’s`,
  )
}

/**
 * Input isolation (D9, `input-isolation`): the store step's window is the turn's user
 * message and its FINAL reply, nothing else. So no memory decision state or extractor
 * input may carry a needle that neither of those two texts carries — a needle planted
 * in a tool result reaches memory only if the window reads the tool result itself.
 */
export function memoryInputIsolatedCheck(
  trace: MemoryTrace,
  responses: readonly string[],
  needles: readonly string[],
): Check {
  const leaks: string[] = []
  trace.turns.forEach((t, i) => {
    const allowed = nfkc(`${t.userMessage}\n${responses[i] ?? ''}`)
    for (const needle of needles)
      if (!allowed.includes(nfkc(needle)) && t.inputs.some((s) => nfkc(s).includes(nfkc(needle))))
        leaks.push(`turn ${i + 1}: ${needle}`)
  })
  return check(
    'memory inputs read no tool result',
    leaks.length === 0,
    leaks.length
      ? `reached a memory input: ${leaks.join(', ')}`
      : `${trace.turns.reduce((n, t) => n + t.inputs.length, 0)} input(s) checked`,
  )
}

/** Every memory check a row declares, in a stable order. */
export function memoryChecks(
  expect: MemoryExpectations,
  trace: MemoryTrace | undefined,
  responses: readonly string[],
): Check[] {
  if (!trace)
    return [
      check(
        'memory trace recorded',
        false,
        'the scenario declares memory checks but ran without memory',
      ),
    ]
  const out: Check[] = []
  if (expect.nothingStored) out.push(noMemoryStoredCheck(trace))
  for (const p of expect.proposed ?? []) out.push(memoryProposedCheck(trace, p.turn, p.dedupe))
  for (const a of expect.answered ?? [])
    out.push(memoryAnsweredCheck(trace, a.turn, a.outcome, a.action))
  for (const r of expect.rows ?? []) out.push(memoryRowsCheck(trace, r.owner, r.facts))
  for (const r of expect.recalled ?? []) out.push(memoryRecalledCheck(trace, r.turn, r.facts))
  if (expect.noForeign) out.push(noForeignMemoryCheck(trace))
  if (expect.inputIsolated?.length)
    out.push(memoryInputIsolatedCheck(trace, responses, expect.inputIsolated))
  return out
}
