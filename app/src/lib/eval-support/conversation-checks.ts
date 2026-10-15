import type { Check, ConversationScenario, ConversationTrace } from './conversation'

const check = (name: string, pass: boolean, detail: string): Check => ({ name, pass, detail })

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

export function grade(
  s: ConversationScenario,
  trace: ConversationTrace,
  baseline: boolean,
): Check[] {
  const final = trace.turns.at(-1)?.response ?? ''
  const events = trace.turns.flatMap((t) => t.events)
  const checks: Check[] = [
    check(
      'every user turn ran',
      trace.turns.length === s.messages.length,
      `${trace.turns.length}/${s.messages.length}`,
    ),
    check(
      'every turn has a response',
      trace.turns.every((t) => t.response.trim().length > 0),
      'nonempty responses',
    ),
    check(
      'final turn completed',
      !['paused', 'error'].includes(trace.turns.at(-1)?.status ?? 'error'),
      trace.turns.at(-1)?.status ?? 'missing',
    ),
  ]
  if (s.noTools)
    checks.push(
      check(
        'answers without tools',
        trace.tools.every((t) => t.name === 'get_neo4j_schema'),
        'excluding construction-time schema lookup',
      ),
    )
  for (const [index, facts] of (s.turnAnswerIncludes ?? []).entries()) {
    for (const fact of facts)
      checks.push(
        check(
          `turn ${index + 1}: answer contains ${fact}`,
          trace.turns[index]?.response.includes(fact) === true,
          trace.turns[index]?.response ?? 'missing',
        ),
      )
  }
  let at = -1
  for (const tool of s.expectedTools) {
    const next = trace.tools.findIndex((t, index) => index > at && t.name === tool && t.success)
    checks.push(check(`successful ordered tool: ${tool}`, next >= 0, `call index ${next}`))
    if (next >= 0) at = next
  }
  for (const tool of s.forbiddenTools)
    checks.push(check(`no ${tool}`, !trace.tools.some((t) => t.name === tool), 'all calls checked'))
  if (s.forbiddenTools.length)
    checks.push(
      check(
        'explains read-only capability',
        /read.only|cannot.*(?:write|create)|can.t.*(?:write|create)/i.test(final),
        final,
      ),
    )
  for (const text of s.answerIncludes)
    checks.push(check(`answer contains ${text}`, final.includes(text), final))
  for (const file of s.artifacts)
    checks.push(
      check(`stash artifact: ${file}`, trace.artifacts.includes(file), trace.artifacts.join(', ')),
    )
  if (s.indexed) {
    checks.push(
      check('markdown index exists', trace.indexed.includes(s.indexed), trace.indexed.join(', ')),
    )
    checks.push(
      check(
        'later turn queried the new index',
        trace.retrievals.some((r) => r.source === s.indexed && r.turn > 0),
        JSON.stringify(trace.retrievals),
      ),
    )
  }
  if (s.citation) {
    const refs = events
      .filter((e) => e.type === 'tool_result')
      .flatMap((e) => {
        const data = record(record(e.data).result)
        return Array.isArray(data.references) ? data.references : []
      })
      .map(record)
    checks.push(
      check(
        'document citation has a locator',
        final.includes(s.citation) &&
          /\[[^\]]+\]\([^)]+\)|\[\d+\]/.test(final) &&
          refs.some(
            (r) =>
              (r.source === s.citation || r.title === s.citation) &&
              (typeof r.docId === 'string' || typeof r.url === 'string'),
          ),
        JSON.stringify(refs),
      ),
    )
  }
  if (s.failFirstTurn) {
    const response = trace.turns[0]?.response ?? ''
    checks.push(
      check(
        'first response acknowledges failure without inventing a count',
        /fail|unavailable|could not|couldn.t/i.test(response) && !response.includes('42'),
        response,
      ),
    )
    checks.push(
      check(
        'first turn recorded a tool failure',
        trace.tools.some((t) => t.turn === 0 && !t.success),
        'injected failure',
      ),
    )
    checks.push(
      check(
        'retry made a fresh successful lookup',
        trace.tools.some((t) => t.turn === 1 && t.name === 'read_neo4j_cypher' && t.success),
        'second turn, same conversation',
      ),
    )
  }
  if (!baseline) {
    for (const route of s.expectedRoutes) {
      checks.push(
        check(
          `route selected: ${route}`,
          events.some(
            (e) =>
              e.type === 'decision_made' &&
              record(e.data).label === route &&
              record(e.data).abstained !== true,
          ),
          'decision_made labels',
        ),
      )
    }
    for (const [index, turn] of trace.turns.entries()) {
      const decisions = turn.events.filter(
        (e) =>
          e.type === 'decision_made' &&
          record(e.data).shadow !== true &&
          record(e.data).abstained !== true &&
          Array.isArray(record(e.data).labels) &&
          (record(e.data).labels as unknown[]).some((label) => record(label).id === 'answer'),
      )
      const labels = decisions.map((e) => record(e.data).label)
      checks.push(
        check(
          `turn ${index + 1}: answer within ${s.maxIterations} decisions`,
          labels.at(-1) === 'answer' && labels.length <= s.maxIterations,
          JSON.stringify(labels),
        ),
      )
    }
  }
  return checks
}
