/**
 * The general-next question-space catalogue (`evals/general-next/scenarios.catalogue.json`)
 * is data for the owner's review: read as text, never imported (src/ may not import evals/).
 * Every rule below is one the review page and a later implementation rely on.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

type Json = Record<string, unknown>
const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (file: string) => readFileSync(join(APP, file), 'utf8')
const catalogue = (): Json => JSON.parse(read('evals/general-next/scenarios.catalogue.json'))
const scenariosMd = read('evals/general-next/SCENARIOS.md')
const moduleIds = readdirSync(join(APP, 'evals/general-next/scenarios'))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => f.replace(/\.ts$/, ''))
const moduleText = (id: string) => read(`evals/general-next/scenarios/${id}.ts`)

/** Tool names general-next is handed, read from the source that hands them, so a tool
 * added there without a row in saturation.tools fails here rather than going unseen. */
function sourceTools(): string[] {
  const list = (file: string, name: string) => {
    const body = read(file).match(new RegExp(`${name}[^=]*=\\s*\\[([^\\]]*)\\]`))?.[1] ?? ''
    return [...body.matchAll(/'([a-z_-]+)'/g)].map((m) => m[1])
  }
  return [
    ...list('../packages/agents/agents/microsoft-365.server.ts', 'MICROSOFT_365_TOOLS'),
    ...[
      ...read('src/lib/eval-support/synthetic-sandbox.ts').matchAll(/name: '(sandbox_[a-z]+)'/g),
    ].map((m) => m[1]),
    'graph_file_ingest',
    'sandbox_bash',
  ]
}

/** The tool names the Eval driver registers; a proposed row naming another one needs driver work. */
function driverTools(): Set<string> {
  const body = read('evals/general-next/driver.ts').match(
    /const NAMESPACES[^{]*\{([\s\S]*?)\n\}/,
  )?.[1]
  return new Set([...(body ?? '').matchAll(/\n {2}'?([a-z][a-z0-9_-]*)'?: '/g)].map((m) => m[1]))
}

const LISTS = [
  'routes',
  'sources',
  'intents',
  'output',
  'guardPaths',
  'languages',
  'timeExpressions',
]
const SCALARS = ['turnShape', 'toolShape', 'tier', 'scale']
// A negative is graded on what did not happen, so it needs at least one of these.
const RESTRAINT = new Set([
  'forbiddenTools',
  'forbiddenRoutes',
  'onlyRoutes',
  'noTools',
  'maxToolCalls',
  'noArgNeedle',
  'fetchUrlGiven',
  'noHost',
  'noCypherWrite',
  'noSandboxCommand',
  'answerNotMatches',
  'answerExcludes',
  'noToolsOnTurn',
  'noWriteClaim',
  'noSandboxPath',
  'noUncoveredAbsenceClaim',
])
const TURNS: Record<string, (n: number) => boolean> = {
  single: (n) => n === 1,
  'follow-up': (n) => n === 2,
  'multi-turn': (n) => n >= 3,
  'failure-recovery': (n) => n >= 1,
}
/** Checks that grade a call of the named tool as correct: a tool's positive case. */
const CALLS = ['orderedTools', 'allTools', 'oneOfTools']
const CALL = ['validArgs', 'toolFailedThenSucceeded']
/** Checks that restrain a tool by kind rather than by listing it. */
const RESTRAINS: Record<string, string[]> = {
  noCypherWrite: ['read_neo4j_cypher', 'write_neo4j_cypher'],
  noSandboxCommand: ['sandbox_bash', 'sandbox_write'],
  noSandboxPath: ['sandbox_bash', 'sandbox_write', 'sandbox_edit'],
  fetchUrlGiven: ['fetch'],
}
const STATUSES = ['notMeaningful', 'equivalent', 'deferred']
const EXPOSURES = ['offered', 'conditional', 'withheld', 'construction']
const EGRESS = ['web', 'context7']
const ROUTE: Record<string, string> = {
  'office-data': 'office',
  'info-retrieval': 'info',
  'read-documents': 'docs',
  think: 'think',
  answer: 'answer',
}

/** Scenario ids headed under "## Scenario matrix" in SCENARIOS.md: the implemented contract. */
function existingIds(md: string): string[] {
  const start = md.indexOf('## Scenario matrix')
  const end = md.indexOf('\n## ', start + 1)
  const section = md.slice(start, end < 0 ? undefined : end)
  return [...section.matchAll(/^### (\d{2}-[a-z0-9-]+) — /gm)].map((m) => m[1])
}

function idPattern(s: Json): RegExp {
  if (s.status === 'existing') return /^\d{2}-[a-z0-9-]+$/
  return s.kind === 'negative' ? /^tn\d{2}-[a-z0-9-]+$/ : /^p\d{2}-[a-z0-9-]+$/
}

type Item = Json & {
  check: string
  says?: unknown
  tools?: string[]
  tool?: string
  routes?: string[]
  facts?: string[]
  needles?: string[]
  namespaces?: string[]
  hosts?: string[]
  files?: string[]
  pattern?: string
  examples?: { match?: unknown; noMatch?: unknown }
  turn?: number
  max?: number
}
const nonEmpty = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.trim().length > 0)
const reasoned = (r: unknown) => typeof r === 'string' && r.trim().length > 0
const graderOf = (s: Json) => (Array.isArray(s.grader) ? s.grader : []) as Item[]
const dims = (s: Json) => (s.dimensions ?? {}) as Record<string, string | string[]>
const flat = (v: unknown) => [v ?? []].flat() as string[]
/** The intent x source pairs a row exercises: its declared cells, else the one pair its tags make. */
const cellsOf = (s: Json): string[] =>
  Array.isArray(s.cells)
    ? (s.cells as string[][]).map(([i, src]) => `${i} x ${src}`)
    : flat(dims(s).intents).flatMap((i) => flat(dims(s).sources).map((src) => `${i} x ${src}`))
/** A passive claim ("the file has been changed") must be shown a negated correct answer. */
const PASSIVE = /\b(?:was|were|has been|have been)\b/
const NEGATED = /\b(?:no|not|never|nothing)\b|n['’]t\b/i

/** Each check's parameters: present, non-empty and inside their vocabularies. */
function contract(at: string, item: Item, turns: number, routes: string[]): string[] {
  const bad = (what: string) => [`${at}: ${item.check} ${what}`]
  switch (item.check) {
    case 'orderedTools':
    case 'allTools':
    case 'oneOfTools':
    case 'forbiddenTools':
      return nonEmpty(item.tools) ? [] : bad('needs tools')
    case 'noToolsOnTurn':
      if (!nonEmpty(item.tools)) return bad('needs tools')
      return Number.isInteger(item.turn) && item.turn! >= 1 && item.turn! <= turns
        ? []
        : bad('turn')
    case 'turnAnswerContains':
      if (!nonEmpty(item.facts)) return bad('needs facts')
      return Number.isInteger(item.turn) && item.turn! >= 1 && item.turn! <= turns
        ? []
        : bad('turn')
    case 'answerContains':
    case 'answerExcludes':
      return nonEmpty(item.facts) ? [] : bad('needs facts')
    case 'noArgNeedle':
      if (!nonEmpty(item.needles)) return bad('needs needles')
      return nonEmpty(item.namespaces) && item.namespaces.every((n) => EGRESS.includes(n))
        ? []
        : bad('namespaces must be outgoing (web, context7)')
    case 'noHost':
      return nonEmpty(item.hosts) ? [] : bad('needs hosts')
    case 'forbiddenRoutes':
    case 'onlyRoutes':
    case 'routeCompleted':
    case 'reportRoutes':
      return nonEmpty(item.routes) && item.routes.every((r) => routes.includes(r))
        ? []
        : bad('needs routes from the vocabulary')
    case 'validArgs':
    case 'toolFailedThenSucceeded':
      return reasoned(item.tool) ? [] : bad('needs a tool')
    case 'artifact':
    case 'writtenArtifact':
      return nonEmpty(item.files) ? [] : bad('needs files')
    case 'artifactContains': {
      if (
        !reasoned(item.file) ||
        !(nonEmpty(item.contains) || nonEmpty(item.parts) || nonEmpty(item.matches))
      )
        return bad('needs a file and contains, parts or matches')
      const broken = flat(item.matches).filter((p) => {
        try {
          return !new RegExp(resolveShared(p), 'i')
        } catch {
          return true
        }
      })
      return broken.length ? bad('matches has a pattern that does not compile') : []
    }
    case 'citationLocator':
      return reasoned(item.source) ? [] : bad('needs a source')
    case 'indexedAndRetrieved':
      return reasoned(item.file) ? [] : bad('needs a file')
    case 'maxToolCalls':
    case 'answerWithinDecisions':
    case 'answerMaxWords':
      return Number.isInteger(item.max) && item.max! > 0 ? [] : bad('needs a positive max')
    case 'answerLanguage':
      return ['en', 'nl', 'fr'].includes(item.lang as string) ? [] : bad('lang')
    case 'noUncoveredAbsenceClaim':
      return reasoned(item.coverage) ? [] : bad('needs a coverage condition')
    default:
      return []
  }
}

/** Shared named patterns ({{name}} in a grader pattern), set from the catalogue under test. */
let SHARED: Record<string, string> = {}
function resolveShared(pattern: string): string {
  let p = pattern
  for (let pass = 0; pass < 4 && /\{\{\w+\}\}/.test(p); pass++)
    p = p.replace(/\{\{(\w+)\}\}/g, (m, name: string) => SHARED[name] ?? m)
  return p
}

/** A pattern is pinned by what it accepts: it compiles, and its examples come out as declared. */
function patternErrors(at: string, item: Item): string[] {
  if (!('pattern' in item)) return []
  const pattern = resolveShared(item.pattern as string)
  if (/\{\{\w+\}\}/.test(pattern)) return [`${at}: ${item.check} names an unknown shared pattern`]
  let re: RegExp
  try {
    re = new RegExp(pattern, 'i')
  } catch {
    return [`${at}: ${item.check} pattern does not compile`]
  }
  const ex = item.examples ?? {}
  if (!nonEmpty(ex.match) || !nonEmpty(ex.noMatch))
    return [`${at}: ${item.check} "${String(item.says)}" needs examples.match and examples.noMatch`]
  const claim = ['answerNotMatches', 'noUncoveredAbsenceClaim'].includes(item.check)
  const negatedShown = ex.noMatch.some((t) => NEGATED.test(t))
  return [
    ...(claim && PASSIVE.test(pattern) && !negatedShown
      ? [`${at}: "${String(item.says)}" is a passive claim with no negated noMatch example`]
      : []),
    ...ex.match
      .filter((t) => !re.test(t))
      .map((t) => `${at}: "${String(item.says)}" misses ${JSON.stringify(t)}`),
    ...ex.noMatch
      .filter((t) => re.test(t))
      .map((t) => `${at}: "${String(item.says)}" matches ${JSON.stringify(t)}`),
  ]
}

/** What a proposed row needs before it can run: new checks and tools the driver lacks. */
function derivedNeeds(
  s: Json,
  checks: Record<string, { exists?: boolean }>,
  driver: Set<string>,
): string[] {
  const need = new Set<string>()
  for (const item of graderOf(s)) {
    if (checks[item.check] && !checks[item.check].exists) need.add(`check:${item.check}`)
    if (item.check === 'forbiddenTools') need.add('check:forbiddenTools-decoupled')
    const named = [...CALLS, 'forbiddenTools', 'noToolsOnTurn'].includes(item.check)
      ? (item.tools ?? [])
      : item.tool
        ? [item.tool]
        : []
    for (const t of named) if (!driver.has(t)) need.add(`driver:${t}`)
  }
  return [...need].sort()
}

function validate(c: Json, md: string, modules: string[], handed = sourceTools()): string[] {
  const errors: string[] = []
  SHARED = (c.sharedPatterns ?? {}) as Record<string, string>
  const required = c.required as string[]
  const allowed = new Set([...required, ...(c.optional as string[])])
  const vocab = c.dimensions as Record<string, { values: string[] }>
  const checks = c.checks as Record<string, { exists?: boolean }>
  const checkNames = new Set(Object.keys(checks).filter((k) => k !== '$comment'))
  const scenarios = c.scenarios as Json[]
  const ids = scenarios.map((s) => s.id as string)
  const byId = new Map(scenarios.map((s) => [s.id as string, s]))
  const driver = driverTools()

  if (new Set(ids).size !== ids.length) errors.push('duplicate scenario ids')
  if (ids.join('\n') !== [...ids].sort().join('\n')) errors.push('scenarios are not sorted by id')

  for (const s of scenarios) {
    const at = String(s.id)
    for (const key of required) if (!(key in s)) errors.push(`${at}: missing ${key}`)
    for (const key of Object.keys(s))
      if (!allowed.has(key)) errors.push(`${at}: unknown key ${key}`)
    if (!['existing', 'proposed'].includes(s.status as string)) errors.push(`${at}: bad status`)
    if (!['positive', 'negative'].includes(s.kind as string)) errors.push(`${at}: bad kind`)
    if (typeof s.id !== 'string' || !idPattern(s).test(s.id)) errors.push(`${at}: id format`)
    const priorities = s.status === 'existing' ? ['must', 'should', 'nice'] : ['must', 'should']
    if (!priorities.includes(s.priority as string)) errors.push(`${at}: bad priority`)
    for (const key of ['title', 'expected'])
      if (key in s && (typeof s[key] !== 'string' || !(s[key] as string).trim()))
        errors.push(`${at}: empty ${key}`)

    const turns = s.turns
    const turnsOk =
      Array.isArray(turns) &&
      turns.length > 0 &&
      turns.every((t) => typeof t === 'string' && t.trim().length > 0)
    if ('turns' in s && !turnsOk) errors.push(`${at}: turns must be non-empty strings`)

    const d = s.dimensions as Json | undefined
    if (d) {
      const keys = Object.keys(d).sort().join()
      if (keys !== Object.keys(vocab).sort().join()) errors.push(`${at}: dimension keys`)
      for (const key of LISTS) {
        const v = d[key]
        if (!Array.isArray(v) || !v.length || v.some((x) => !vocab[key]?.values.includes(x)))
          errors.push(`${at}: dimension ${key}`)
      }
      for (const key of SCALARS)
        if (!vocab[key]?.values.includes(d[key] as string)) errors.push(`${at}: dimension ${key}`)
      if (turnsOk && !TURNS[d.turnShape as string]?.((turns as string[]).length))
        errors.push(
          `${at}: turnShape ${String(d.turnShape)} does not fit ${(turns as string[]).length} turns`,
        )
    }
    if (
      'requestedRoutes' in s &&
      !flat(s.requestedRoutes).every((r) => vocab.routes.values.includes(r))
    )
      errors.push(`${at}: requestedRoutes outside the route vocabulary`)

    const grader = s.grader
    if ('grader' in s) {
      if (!Array.isArray(grader) || !grader.length) errors.push(`${at}: grader must be non-empty`)
      else {
        for (const item of grader as Item[]) {
          if (!checkNames.has(item.check) || typeof item.says !== 'string')
            errors.push(`${at}: grader check ${String(item.check)}`)
          const n = turnsOk ? (turns as string[]).length : 0
          errors.push(...contract(at, item, n, vocab.routes.values), ...patternErrors(at, item))
        }
        if (
          s.kind === 'negative' &&
          !(grader as Item[]).some(
            (i) => RESTRAINT.has(i.check) && !contract(at, i, 99, vocab.routes.values).length,
          )
        )
          errors.push(`${at}: a negative needs a restraint check`)
      }
    }

    if ('twin' in s) {
      const twin = byId.get(s.twin as string)
      if (s.kind !== 'negative' || !twin || twin.kind !== 'positive')
        errors.push(`${at}: twin must name a positive scenario, on a negative row`)
    } else if (s.kind === 'negative' && s.status === 'proposed')
      errors.push(`${at}: a proposed negative needs a twin`)
    const pairs = flat(d?.intents).length * flat(d?.sources).length
    if (pairs > 1 && !Array.isArray(s.cells))
      errors.push(`${at}: several intents or sources, so cells must say which pairs it exercises`)
    if (Array.isArray(s.cells))
      for (const cell of s.cells as unknown[]) {
        const [i, src] = Array.isArray(cell) ? (cell as string[]) : []
        if (!flat(d?.intents).includes(i) || !flat(d?.sources).includes(src))
          errors.push(
            `${at}: cell ${JSON.stringify(cell)} is not one of its own intent x source tags`,
          )
      }
    if (s.status === 'proposed') {
      const want = derivedNeeds(s, checks, driver).join()
      // `agent:` names a change in the agent itself that the row waits for; it is prose, not derived.
      const got = flat(s.needs)
        .filter((n) => !n.startsWith('agent:'))
        .join()
      if (got !== want) errors.push(`${at}: needs should be [${want}]`)
    } else if ('needs' in s) errors.push(`${at}: needs is for proposed rows`)
  }

  const existing = new Set(scenarios.filter((s) => s.status === 'existing').map((s) => s.id))
  const documented = existingIds(md)
  for (const id of documented)
    if (!existing.has(id)) errors.push(`${id}: in SCENARIOS.md but not existing in the catalogue`)
  for (const id of existing)
    if (!documented.includes(id as string))
      errors.push(`${String(id)}: existing but not in SCENARIOS.md`)
  for (const id of modules) if (!existing.has(id)) errors.push(`${id}: module not in the catalogue`)
  for (const s of scenarios)
    if (s.status === 'proposed' && !md.includes(`\`${String(s.id)}\``))
      errors.push(`${String(s.id)}: proposed but not listed in SCENARIOS.md`)
  for (const id of modules)
    if (byId.has(id)) errors.push(...againstModule(byId.get(id)!, moduleText(id)))
  return [
    ...errors,
    ...saturation(c, scenarios, handed, byId),
    ...retiredAndMemory(c, scenarios, byId),
    ...rulings(c, byId),
    ...markdown(c, md),
  ]
}

/**
 * The shared memory graph is retired (PR #744) and per-user memory is what remains: no row,
 * vocabulary value or saturation cell may name the graph or its tools; a row that declares
 * `memory: true` runs with the synthetic owner-scoped store, and a module that turns memory on
 * says so in its row; the arithmetic row computes in the sandbox (#742 is the calculator
 * follow-up) and says what the agent must change first; and the cross-owner row asks for a
 * fact that the synthetic store really holds under the other owner.
 */
function retiredAndMemory(c: Json, scenarios: Json[], byId: Map<string, Json>): string[] {
  const errors: string[] = []
  const sat = c.saturation as Json
  const retired =
    /memory-graph|memory graph|MCP memory|search_nodes|open_nodes|read_graph|create_entities|create_relations|add_observations|delete_entities|delete_observations|delete_relations/
  const scanned: Array<[string, unknown]> = [
    ['dimensions', c.dimensions],
    ['intentSource', sat.intentSource],
    ['negativeOnlyCells', sat.negativeOnlyCells],
    // A row's notes may say what it replaced; everything the Eval reads or grades may not.
    ...scenarios.map((s): [string, unknown] => [String(s.id), { ...s, notes: undefined }]),
  ]
  for (const [at, value] of scanned)
    if (retired.test(JSON.stringify(value)))
      errors.push(`${at}: names the retired shared memory graph or its tools (PR #744)`)
  // Keyed on the row's own `memory` field, not on the user-memory source: tn35 and tn36 name
  // that source and expect memory OFF, so a source key would force memory on for them.
  for (const s of scenarios)
    if (s.status === 'existing') {
      const on =
        moduleIds.includes(String(s.id)) && /\bmemory:\s*true\b/.test(moduleText(String(s.id)))
      if (s.memory === true && !on)
        errors.push(`${String(s.id)}: declares memory but its module does not turn memory on`)
      if (s.memory !== true && on)
        errors.push(`${String(s.id)}: its module turns memory on but the row does not declare it`)
    } else if ('memory' in s) errors.push(`${String(s.id)}: memory is for existing rows`)
  const sum = byId.get('p87-arithmetic-in-sandbox')
  if (!sum) errors.push('p87-arithmetic-in-sandbox: missing (owner, 2026-10-22: use the sandbox)')
  else {
    const g = graderOf(sum)
    const calls = g.some(
      (i) => i.check === 'orderedTools' && (i.tools ?? []).join() === 'sandbox_bash',
    )
    if (!calls || g.some((i) => ['noTools', 'onlyRoutes'].includes(i.check)))
      errors.push('p87-arithmetic-in-sandbox: arithmetic must be computed in the sandbox (#742)')
    if (!g.some((i) => i.check === 'validArgs' && i.tool === 'sandbox_bash'))
      errors.push('p87-arithmetic-in-sandbox: must grade that the command carries both operands')
    // The answer fact is the product of the operands in the query, and the fixture says so.
    const [, a, b] = String(flat(sum.turns)[0]).match(/(\d+) times (\d+)/) ?? []
    const product = String(Number(a) * Number(b))
    const fact = g.find((i) => i.check === 'answerContains')?.facts ?? []
    if (!a || fact.join() !== product || !flat(sum.fixtures).join().includes(product))
      errors.push(`p87-arithmetic-in-sandbox: the answer fact must be the product, ${product}`)
    // The agent: item records the route/decider change (#748); #742's calculator is the later version.
    if (!flat(sum.needs).some((n) => n.startsWith('agent:')))
      errors.push('p87-arithmetic-in-sandbox: needs must name the agent-side change (agent:)')
  }
  const other = byId.get('tn58-other-owner-memory')
  const facts = other
    ? graderOf(other)
        .filter((i) => i.check === 'answerExcludes')
        .flatMap((i) => i.facts ?? [])
    : []
  const store = read('src/lib/eval-support/synthetic-memory.ts')
  if (!facts.length || !facts.every((f) => store.includes(f)))
    errors.push('tn58-other-owner-memory: must exclude a fact the synthetic store holds')
  // The row cannot go red from a production defect (the double does the owner filtering), so
  // it must say so and point at the pin that can: the owner-scoped store test.
  const pin = 'src/__tests__/lib/db/memories-db-store.test.ts'
  if (other && (other.twin !== '05-memory-lookup' || !String(other.notes).includes(pin)))
    errors.push(`tn58-other-owner-memory: twin must be 05 and the notes must point at ${pin}`)
  if (other && !existsSync(join(APP, pin.replace(/^src\//, 'src/'))))
    errors.push(`tn58-other-owner-memory: ${pin} does not exist`)
  // A .docx or .xlsx is built by a script, so the text of a sandbox_write cannot grade it.
  for (const s of scenarios)
    for (const i of graderOf(s))
      if (i.check === 'writtenArtifact' && (i.files ?? []).some((f) => /\.(docx|xlsx)$/.test(f)))
        errors.push(
          `${String(s.id)}: writtenArtifact cannot grade an office file; use artifactContains`,
        )
  // The owner's tn04 change is an OFFER, so it is graded: the refusal, the offer and the
  // statement that the user uploads the edited file themselves.
  const tn04 = byId.get('tn04-edit-sharepoint-file')
  if (tn04 && graderOf(tn04).filter((i) => i.check === 'answerMatches').length < 3)
    errors.push('tn04-edit-sharepoint-file: refusal, offer and “you upload it” must each be graded')
  // The owner's p15 verdict: the answer returns the person's contact details from the graph.
  const p15 = byId.get('p15-find-person-by-skill')
  const mail = graderOf(p15 ?? {}).find((i) => i.check === 'answerContains')?.facts ?? []
  if (p15 && !mail.some((f) => /@example\.test$/.test(f) && flat(p15.fixtures).join().includes(f)))
    errors.push('p15-find-person-by-skill: the answer must carry the contact email the graph holds')
  return errors
}

/** An existing row carries its module's own checks, so the owner reviews what the suite runs. */
function againstModule(s: Json, t: string): string[] {
  const at = String(s.id)
  const strs = (body = '') =>
    [...body.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\(.)/g, '$1'))
  const arr = (key: string) =>
    strs((t.match(new RegExp(`\\n  ${key}: \\[([\\s\\S]*?)\\],?\\n`)) ?? [])[1])
  const one = (key: string) => t.match(new RegExp(`\\n  ${key}: '([^']*)'`))?.[1]
  const args =
    t.match(/\n {2}expectedArgs: \{(.+)\},?\n/)?.[1] ??
    t.match(/\n {2}expectedArgs: \{\n([\s\S]*?)\n {2}\},?\n/)?.[1]
  const turnFacts = [
    ...((t.match(/\n {2}turnAnswerIncludes: \[(.*)\],?\n/) ?? [])[1] ?? '').matchAll(
      /\[([^\]]*)\]/g,
    ),
  ].map((m) => strs(m[1]))
  const gr = graderOf(s)
  const find = (check: string) => gr.filter((i) => i.check === check)
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const errors: string[] = []
  const expect = (ok: boolean, what: string) =>
    ok || errors.push(`${at}: differs from its module on ${what}`)
  expect(s.title === one('title'), 'title')
  expect(s.priority === one('priority'), 'priority')
  expect(same(s.turns, arr('messages')), 'messages')
  const tools = arr('expectedTools')
  expect(
    tools.length ? same(find('orderedTools')[0]?.tools, tools) : !find('orderedTools').length,
    'expectedTools',
  )
  const argKeys = [...(args ?? '').matchAll(/(?:^|\{|\n)\s*'?([a-z][a-z0-9_-]*)'?:\s/g)].map(
    (m) => m[1],
  )
  expect(
    same(
      find('validArgs').map((i) => i.tool),
      argKeys,
    ),
    'expectedArgs',
  )
  const facts = arr('answerIncludes')
  expect(
    facts.length ? same(find('answerContains')[0]?.facts, facts) : !find('answerContains').length,
    'answerIncludes',
  )
  turnFacts.forEach((f, n) =>
    expect(
      !f.length || find('turnAnswerContains').some((i) => i.turn === n + 1 && same(i.facts, f)),
      `turn ${n + 1} facts`,
    ),
  )
  expect(
    find('turnAnswerContains').every((i) =>
      turnFacts.some((f, n) => i.turn === n + 1 && same(i.facts, f)),
    ),
    'turnAnswerIncludes (a catalogue turn fact the module does not carry)',
  )
  const artifacts = arr('artifacts')
  expect(
    artifacts.length ? same(find('artifact')[0]?.files, artifacts) : !find('artifact').length,
    'artifacts',
  )
  const routes = arr('expectedRoutes')
  expect(
    routes.length
      ? same(find('routeCompleted')[0]?.routes, routes)
      : !find('routeCompleted').length,
    'expectedRoutes',
  )
  const forbidden = arr('forbiddenTools')
  expect(
    forbidden.length
      ? same(find('forbiddenTools')[0]?.tools, forbidden)
      : !find('forbiddenTools').length,
    'forbiddenTools',
  )
  expect((one('citation') ?? null) === (find('citationLocator')[0]?.source ?? null), 'citation')
  expect((one('indexed') ?? null) === (find('indexedAndRetrieved')[0]?.file ?? null), 'indexed')
  expect(/\n {2}noTools: true/.test(t) === !!find('noTools').length, 'noTools')
  expect(/\n {2}p4: true/.test(t) === !!find('p4Gated').length, 'p4')
  expect(
    /\n {2}failFirstTurn: true/.test(t) === !!find('failureThenFreshLookup').length,
    'failFirstTurn',
  )
  return errors
}

type ToolEntry = {
  namespace: string
  exposure: string
  positiveReason?: string
  negativeReason?: string
}

/** Tool coverage, derived the same way for the validator and the SCENARIOS.md table. */
function toolCases(scenarios: Json[], tools: Record<string, ToolEntry>) {
  const positive = new Map<string, Set<string>>()
  const negative = new Map<string, Set<string>>()
  const add = (m: Map<string, Set<string>>, t: string, id: string) =>
    m.set(t, (m.get(t) ?? new Set()).add(id))
  for (const s of scenarios)
    for (const item of graderOf(s)) {
      const called = CALLS.includes(item.check)
        ? (item.tools ?? [])
        : CALL.includes(item.check)
          ? [item.tool as string]
          : []
      for (const t of called) {
        add(positive, t, s.id as string)
        if (s.kind === 'negative') add(negative, t, s.id as string)
      }
      const listed = ['forbiddenTools', 'noToolsOnTurn'].includes(item.check)
        ? (item.tools ?? [])
        : []
      const byNamespace =
        item.check === 'noArgNeedle'
          ? Object.keys(tools).filter((t) => item.namespaces?.includes(tools[t].namespace))
          : []
      for (const t of [...listed, ...(RESTRAINS[item.check] ?? []), ...byNamespace])
        add(negative, t, s.id as string)
    }
  return { positive, negative }
}

/** The saturation method: what is covered is derived from the scenarios; what is not must
 * be declared once, with a reason; a declaration for something covered is stale. */
function saturation(
  c: Json,
  scenarios: Json[],
  handed: string[],
  byId: Map<string, Json>,
): string[] {
  const errors: string[] = []
  const sat = (c.saturation ?? {}) as Json
  const vocab = c.dimensions as Record<string, { values: string[] }>

  // 1. every intent x source cell: covered by a scenario, or declared once with a reason
  const covered = new Set<string>()
  for (const s of scenarios) for (const cell of cellsOf(s)) covered.add(cell)
  const declared = new Map<string, string>()
  for (const [n, group] of ((sat.intentSource ?? []) as Json[]).entries()) {
    if (!STATUSES.includes(group.status as string) || !reasoned(group.reason))
      errors.push(`intentSource[${n}]: needs a status and a reason`)
    const sameAs = flat(group.sameAs)
    if (
      group.status === 'equivalent'
        ? !sameAs.length || sameAs.some((id) => !byId.has(id))
        : 'sameAs' in group
    )
      errors.push(
        `intentSource[${n}]: equivalent needs sameAs naming catalogue rows, and only equivalent has it`,
      )
    for (const i of group.intents as string[])
      for (const src of group.sources as string[]) {
        const cell = `${i} x ${src}`
        if (!vocab.intents.values.includes(i) || !vocab.sources.values.includes(src))
          errors.push(`intentSource[${n}]: ${cell} is outside the vocabularies`)
        if (declared.has(cell)) errors.push(`${cell}: declared twice`)
        if (covered.has(cell)) errors.push(`${cell}: declared ${String(group.status)} but covered`)
        declared.set(cell, group.status as string)
      }
  }
  for (const i of vocab.intents.values)
    for (const src of vocab.sources.values)
      if (!covered.has(`${i} x ${src}`) && !declared.has(`${i} x ${src}`))
        errors.push(`${i} x ${src}: neither covered nor declared`)
  // A negative-only intent is declared, so an intent cannot lose its positives silently.
  const negativeOnly = (sat.negativeOnlyIntents ?? {}) as Record<string, string>
  // ...and so is a covered cell no positive row exercises.
  const positiveCells = new Set(scenarios.filter((s) => s.kind === 'positive').flatMap(cellsOf))
  const negOnlyCells = new Set<string>()
  for (const group of (sat.negativeOnlyCells ?? []) as Json[]) {
    if (!reasoned(group.reason)) errors.push('negativeOnlyCells: a group needs a reason')
    for (const i of flat(group.intents))
      for (const src of flat(group.sources)) {
        const cell = `${i} x ${src}`
        negOnlyCells.add(cell)
        if (positiveCells.has(cell) || !covered.has(cell))
          errors.push(
            `${cell}: declared negative-only but ${positiveCells.has(cell) ? 'a positive covers it' : 'nothing covers it'}`,
          )
      }
  }
  for (const cell of covered)
    if (
      !positiveCells.has(cell) &&
      !negOnlyCells.has(cell) &&
      !reasoned(negativeOnly[cell.split(' x ')[0]])
    )
      errors.push(
        `${cell}: covered only by negatives, with no positive and no negative-only reason`,
      )
  for (const i of vocab.intents.values) {
    const has = scenarios.some((s) => s.kind === 'positive' && flat(dims(s).intents).includes(i))
    if (!has && !reasoned(negativeOnly[i])) errors.push(`intent ${i}: no positive scenario`)
    if (has && i in negativeOnly)
      errors.push(`intent ${i}: declared negative-only but has a positive`)
  }

  // 2. every tool: a positive and a negative case, or a reason in place of each
  const tools = (sat.tools ?? {}) as Record<string, ToolEntry>
  const { positive, negative } = toolCases(scenarios, tools)
  for (const s of scenarios)
    for (const item of graderOf(s))
      for (const t of CALLS.includes(item.check)
        ? (item.tools ?? [])
        : CALL.includes(item.check)
          ? [item.tool]
          : [])
        if (t && !(t in tools))
          errors.push(`${String(s.id)}: ${item.check} names ${t}, not in saturation.tools`)
  for (const [t, e] of Object.entries(tools)) {
    if (typeof e.namespace !== 'string' || !EXPOSURES.includes(e.exposure))
      errors.push(`tool ${t}: needs a namespace and an exposure`)
    if (e.exposure === 'withheld' && positive.has(t))
      errors.push(`tool ${t}: withheld but graded as a correct call`)
    for (const [side, has, reason] of [
      ['positive', positive.has(t), e.positiveReason],
      ['negative', negative.has(t), e.negativeReason],
    ] as const) {
      if (!has && !reasoned(reason)) errors.push(`tool ${t}: no ${side} case and no reason`)
      if (has && reason !== undefined)
        errors.push(`tool ${t}: ${side} reason but a ${side} case exists`)
    }
  }
  // Exposure is derived from the source that hands the tools over, not only declared.
  for (const t of handed) {
    if (!(t in tools)) errors.push(`tool ${t}: handed to general-next but not in saturation.tools`)
    else if (!['offered', 'conditional'].includes(tools[t].exposure))
      errors.push(`tool ${t}: handed to general-next but declared ${tools[t].exposure}`)
  }
  for (const [t, e] of Object.entries(tools))
    if (
      ['offered', 'conditional'].includes(e.exposure) &&
      ['graph', 'memory', 'sandbox'].includes(e.namespace) &&
      !handed.includes(t)
    )
      errors.push(`tool ${t}: declared ${e.exposure} but general-next is not handed it`)

  // 3. every dimension value: used by a scenario, or declared unused with a reason
  const unused = (sat.unusedValues ?? {}) as Record<string, string>
  for (const [dim, { values }] of Object.entries(vocab))
    for (const v of values) {
      const used = scenarios.some((s) => flat(dims(s)[dim]).includes(v))
      const key = `${dim}:${v}`
      if (!used && !reasoned(unused[key])) errors.push(`${key}: unused and no reason`)
      if (used && key in unused) errors.push(`${key}: declared unused but used`)
    }
  return errors
}

/** The owner's open rulings: stable option ids and exactly one recommendation among them. */
function rulings(c: Json, byId: Map<string, Json>): string[] {
  const errors: string[] = []
  const list = (c.rulings ?? []) as Json[]
  if (!list.length) errors.push('rulings: none')
  const keys = list.map((r) => r.key as string)
  if (new Set(keys).size !== keys.length) errors.push('rulings: duplicate key')
  for (const r of list) {
    const at = `ruling ${String(r.key)}`
    if (!reasoned(r.key) || !reasoned(r.question)) errors.push(`${at}: needs a key and a question`)
    const options = (Array.isArray(r.options) ? r.options : []) as Json[]
    const ids = options.map((o) => o.id as string)
    if (options.length < 2 || !options.every((o) => reasoned(o.id) && reasoned(o.label)))
      errors.push(`${at}: needs two or more options with an id and a label`)
    if (new Set(ids).size !== ids.length) errors.push(`${at}: duplicate option id`)
    const rec = (r.recommendation ?? {}) as Json
    if (!ids.includes(rec.option as string))
      errors.push(`${at}: recommendation is not one of its options`)
    if (!reasoned(rec.reason)) errors.push(`${at}: recommendation needs a reason`)
    if (!nonEmpty(r.affects) || r.affects.some((id) => !byId.has(id)))
      errors.push(`${at}: affects must name catalogue scenarios`)
  }
  return errors
}

/** Rows of the first table after a heading, cells unescaped. */
function tableAfter(md: string, heading: string): string[][] {
  const lines = md.split('\n')
  const at = lines.findIndex((l) => l.trim() === heading)
  if (at < 0) return []
  const rows: string[][] = []
  let started = false
  for (const line of lines.slice(at + 1)) {
    if (line.startsWith('|')) {
      started = true
      rows.push(
        line
          .trim()
          .slice(1, -1)
          .split(/(?<!\\)\|/)
          .map((cell) =>
            cell
              .trim()
              .replace(/\\\|/g, '|')
              .replace(/<br>/g, '\n')
              .replace(/&nbsp;/g, ' '),
          ),
      )
    } else if (started || line.startsWith('#')) break
  }
  return rows.slice(2)
}

/** SCENARIOS.md's question-space tables are generated from the catalogue; recompute and compare. */
function markdown(c: Json, md: string): string[] {
  const errors: string[] = []
  const scenarios = c.scenarios as Json[]
  const vocab = c.dimensions as Record<string, { values: string[] }>
  const sat = c.saturation as Json
  const compare = (heading: string, want: string[][]) => {
    const got = new Map(tableAfter(md, heading).map((r) => [r[0], r]))
    if (got.size !== want.length)
      errors.push(`SCENARIOS.md ${heading}: ${got.size} rows, want ${want.length}`)
    for (const row of want)
      if (JSON.stringify(got.get(row[0])) !== JSON.stringify(row))
        errors.push(`SCENARIOS.md ${heading}: row ${row[0]} is stale`)
  }
  const count = (dim: string, v: string, pred: (s: Json) => boolean) =>
    scenarios.filter((s) => pred(s) && flat(dims(s)[dim]).includes(v)).length
  const coverage: string[][] = []
  for (const [dim, { values }] of Object.entries(vocab))
    for (const v of values) {
      const e = count(dim, v, (s) => s.status === 'existing')
      coverage.push([
        dim,
        `\`${v}\``,
        e ? String(e) : '**0**',
        String(count(dim, v, (s) => s.status === 'proposed' && s.kind === 'positive')),
        String(count(dim, v, (s) => s.status === 'proposed' && s.kind === 'negative')),
      ])
    }
  // The coverage table's first cell repeats per dimension, so key it by dimension and value.
  const covGot = new Map(tableAfter(md, '### Coverage').map((r) => [`${r[0]} ${r[1]}`, r]))
  if (covGot.size !== coverage.length)
    errors.push(`SCENARIOS.md ### Coverage: ${covGot.size} rows, want ${coverage.length}`)
  for (const row of coverage)
    if (JSON.stringify(covGot.get(`${row[0]} ${row[1]}`)) !== JSON.stringify(row))
      errors.push(`SCENARIOS.md ### Coverage: row ${row[0]} ${row[1]} is stale`)

  const declared = new Map<string, string>()
  for (const g of (sat.intentSource ?? []) as Json[])
    for (const i of g.intents as string[])
      for (const src of g.sources as string[])
        declared.set(
          `${i} x ${src}`,
          g.status === 'notMeaningful' ? '–' : g.status === 'equivalent' ? '=' : 'd',
        )
  compare(
    '### Intent × source',
    vocab.intents.values.map((i) => [
      `\`${i}\``,
      ...vocab.sources.values.map((src) => {
        const n = scenarios.filter((s) => cellsOf(s).includes(`${i} x ${src}`)).length
        return n ? String(n) : (declared.get(`${i} x ${src}`) ?? '?')
      }),
    ]),
  )
  compare(
    '### Scenario matrix (existing and proposed)',
    scenarios.map((s) => {
      const d = dims(s)
      return [
        `\`${String(s.id)}\``,
        s.kind === 'positive' ? '+' : '−',
        s.priority as string,
        s.status as string,
        flat(d.routes)
          .map((r) => ROUTE[r])
          .join(', '),
        flat(d.sources).join(', '),
        flat(d.intents).join(', '),
        d.turnShape as string,
        d.toolShape as string,
        flat(d.output).join(', '),
        flat(d.guardPaths).join(', '),
        flat(d.languages).join(', '),
        flat(d.timeExpressions).join(', '),
        d.scale as string,
      ]
    }),
  )
  compare(
    '### Proposed scenarios',
    scenarios
      .filter((s) => s.status === 'proposed')
      .map((s) => [
        `\`${String(s.id)}\``,
        s.priority as string,
        (s.turns as string[]).map((t) => `“${t}”`).join(' → '),
        s.expected as string,
      ]),
  )
  const toolRows = new Set(tableAfter(md, '### Tools').map((r) => r[0]))
  for (const t of Object.keys((sat.tools ?? {}) as Json))
    if (!toolRows.has(`\`${t}\``)) errors.push(`SCENARIOS.md ### Tools: ${t} missing`)
  const rulingRows = new Set(tableAfter(md, '### For the owner to rule').map((r) => r[0]))
  const rulingTable = tableAfter(md, '### For the owner to rule')
  const rulings = (c.rulings ?? []) as Json[]
  for (const r of rulings) {
    if (!rulingRows.has(`\`${String(r.key)}\``))
      errors.push(`SCENARIOS.md: ruling ${String(r.key)} missing`)
    // The table is compared with the JSON in both directions: options and recommendation too.
    const got = rulingTable.find((x) => x[0] === `\`${String(r.key)}\``)
    const rec = (r.recommendation as Json).option
    if (got && !got[3].startsWith(`\`${String(rec)}\``))
      errors.push(`SCENARIOS.md: ruling ${String(r.key)} recommends something else`)
    for (const o of r.options as Json[])
      if (got && !got[2].includes(`\`${String(o.id)}\``))
        errors.push(`SCENARIOS.md: ruling ${String(r.key)} lacks option ${String(o.id)}`)
  }
  if (rulingTable.length !== rulings.length)
    errors.push(`SCENARIOS.md: ${rulingTable.length} ruling rows, want ${rulings.length}`)
  return errors
}

describe('general-next scenario catalogue', () => {
  it('is valid against its own vocabularies, its modules and SCENARIOS.md', () => {
    expect(validate(catalogue(), scenariosMd, moduleIds)).toEqual([])
  })

  it('reads the 18 implemented scenarios from SCENARIOS.md, not zero', () => {
    // Guards the parser: an empty heading match would make the cross-check vacuous.
    expect(existingIds(scenariosMd)).toHaveLength(18)
    expect(moduleIds.length).toBeGreaterThanOrEqual(17)
  })

  it('reads its sources, not zero', () => {
    // Guards the drift pins: an empty parse would let a new tool or a stale table through.
    const tools = sourceTools()
    expect(tools).toContain('graph_files_shared')
    expect(tools).toContain('graph_me')
    expect(tools).toContain('sandbox_edit')
    expect(tools.length).toBeGreaterThanOrEqual(15)
    expect(driverTools()).toContain('graph_mail_recent')
    expect(
      tableAfter(scenariosMd, '### Scenario matrix (existing and proposed)').length,
    ).toBeGreaterThan(100)
    expect(tableAfter(scenariosMd, '### Coverage').length).toBeGreaterThan(50)
  })

  describe('goes red on each defect', () => {
    const mutate = (edit: (c: Json, scenarios: Json[]) => void, md = scenariosMd): string[] => {
      const c = catalogue()
      edit(c, c.scenarios as Json[])
      return validate(c, md, moduleIds)
    }
    const row = (s: Json[], id: string) => s.find((x) => x.id === id) as Json
    const first = (scenarios: Json[], kind: string) =>
      scenarios.find((s) => s.status === 'proposed' && s.kind === kind) as Json
    const itemOf = (s: Json[], id: string, check: string) =>
      graderOf(row(s, id)).find((i) => i.check === check) as Item

    it.each([
      'id',
      'title',
      'kind',
      'priority',
      'dimensions',
      'turns',
      'expected',
      'grader',
      'status',
    ])('a scenario missing %s', (key) => {
      const errors = mutate((_, s) => delete s[0][key])
      expect(errors.length).toBeGreaterThan(0)
    })
    it('a duplicate id', () => {
      expect(mutate((_, s) => (s[1].id = s[0].id))).toContain('duplicate scenario ids')
    })
    it('an existing scenario marked proposed', () => {
      expect(mutate((_, s) => (s[0].status = 'proposed')).join()).toMatch(
        /not existing in the catalogue/,
      )
    })
    it('an unknown grader check', () => {
      expect(mutate((_, s) => ((s[0].grader as Json[])[0].check = 'vibes')).join()).toMatch(
        /grader check vibes/,
      )
    })
    it('a dimension value outside its vocabulary', () => {
      expect(mutate((_, s) => ((s[0].dimensions as Json).routes = ['sandbox'])).join()).toMatch(
        /dimension routes/,
      )
    })
    it('a negative graded only on what did happen', () => {
      const errors = mutate((_, s) => {
        const neg = first(s, 'negative')
        neg.grader = [{ check: 'answerContains', says: '', facts: ['x'] }]
      })
      expect(errors.join()).toMatch(/needs a restraint check/)
    })
    it('a turn shape that does not fit the turns', () => {
      expect(mutate((_, s) => (first(s, 'positive').turns = ['a', 'b'])).join()).toMatch(
        /turnShape/,
      )
    })
    it('an intent value dropped from the vocabulary', () => {
      const errors = mutate((c) => {
        const intents = (c.dimensions as Record<string, { values: string[] }>).intents
        intents.values = intents.values.filter((v) => v !== 'repair')
      })
      expect(errors.join()).toMatch(/dimension intents/)
    })
    it('a scenario without the new dimension keys', () => {
      expect(mutate((_, s) => delete (s[0].dimensions as Json).languages).join()).toMatch(
        /dimension keys/,
      )
    })
    it('an intent x source cell neither covered nor declared', () => {
      const errors = mutate((c) => {
        const sat = c.saturation as Json
        sat.intentSource = (sat.intentSource as Json[]).filter(
          (g) => !(g.sources as string[]).includes('user-memory'),
        )
      })
      expect(errors.join()).toMatch(/find-person x user-memory: neither covered nor declared/)
    })
    it('a declared cell that a scenario covers', () => {
      const errors = mutate((c) => {
        const groups = (c.saturation as Json).intentSource as Json[]
        groups.push({
          intents: ['lookup-fact'],
          sources: ['knowledge-graph'],
          status: 'deferred',
          reason: 'x',
        })
      })
      expect(errors.join()).toMatch(/lookup-fact x knowledge-graph: declared deferred but covered/)
    })
    it('an intent with no positive scenario', () => {
      const errors = mutate((_, s) => {
        for (const r of s)
          (r.dimensions as Json).intents = flat((r.dimensions as Json).intents).map((i) =>
            i === 'plan' && r.kind === 'positive' ? 'lookup-fact' : i,
          )
      })
      expect(errors.join()).toMatch(/intent plan: no positive scenario/)
    })
    it('a tool with no negative case and no reason', () => {
      const errors = mutate((c) => {
        delete (((c.saturation as Json).tools as Json).sandbox_list as Json).negativeReason
      })
      expect(errors.join()).toMatch(/tool sandbox_list: no negative case and no reason/)
    })
    it('a tool reason that a case makes stale', () => {
      const errors = mutate((c) => {
        ;(((c.saturation as Json).tools as Json).graph_me as Json).negativeReason = 'x'
      })
      expect(errors.join()).toMatch(/tool graph_me: negative reason but a negative case exists/)
    })
    it('a withheld tool graded as a correct call', () => {
      const errors = mutate((_, s) => {
        ;(s[0].grader as Json[]).push({
          check: 'oneOfTools',
          says: '',
          tools: ['write_neo4j_cypher'],
        })
      })
      expect(errors.join()).toMatch(
        /tool write_neo4j_cypher: withheld but graded as a correct call/,
      )
    })
    it('a tool general-next is handed but the catalogue omits', () => {
      const errors = mutate((c) => delete ((c.saturation as Json).tools as Json).graph_files_recent)
      expect(errors.join()).toMatch(/graph_files_recent: handed to general-next but not in/)
    })
    it('a dimension value unused and unreasoned', () => {
      const errors = mutate((c) => {
        delete ((c.saturation as Json).unusedValues as Json)['tier:anthropic']
      })
      expect(errors.join()).toMatch(/tier:anthropic: unused and no reason/)
    })
    it('a proposed priority of nice', () => {
      expect(mutate((_, s) => (first(s, 'negative').priority = 'nice')).join()).toMatch(
        /bad priority/,
      )
    })

    // Pattern behaviour (Opus wording review finding 1 on 858101b8)
    it('the curly-apostrophe handling undone', () => {
      const errors = mutate((_, s) => {
        for (const r of s)
          for (const i of graderOf(r))
            if (typeof i.pattern === 'string') i.pattern = i.pattern.replace(/\['’\]/g, "'")
      })
      expect(errors.join()).toMatch(/misses ".*’/)
    })
    it('a pattern that stops accepting a correct answer', () => {
      const errors = mutate(
        (_, s) => (itemOf(s, 'tn18-unsupplied-fetch-address', 'answerMatches').pattern = 'xyzzy'),
      )
      expect(errors.join()).toMatch(/tn18-unsupplied-fetch-address: "says none was found" misses/)
    })
    it('a pattern item with no examples', () => {
      const errors = mutate(
        (_, s) => delete itemOf(s, 'tn01-send-mail', 'answerNotMatches').examples,
      )
      expect(errors.join()).toMatch(
        /tn01-send-mail: answerNotMatches "no sent claim" needs examples/,
      )
    })

    // Parameter contract (Sonnet review finding 1, mutants M9a-d, M13)
    it.each([
      [
        'M9a: needles deleted',
        (s: Json[]) => delete itemOf(s, 'tn10-sender-name-to-web', 'noArgNeedle').needles,
        /needs needles/,
      ],
      [
        'M9b: needles empty',
        (s: Json[]) => (itemOf(s, 'tn11-internal-price-to-web', 'noArgNeedle').needles = []),
        /needs needles/,
      ],
      [
        'M9c: a pattern that does not compile',
        (s: Json[]) => (itemOf(s, 'tn01-send-mail', 'answerMatches').pattern = '(unclosed'),
        /pattern does not compile/,
      ],
      [
        'M9d: needles on a namespace that never leaves',
        (s: Json[]) =>
          (itemOf(s, 'tn10-sender-name-to-web', 'noArgNeedle').namespaces = ['sandbox']),
        /namespaces must be outgoing/,
      ],
      [
        'M13: a restraint with nothing to restrain',
        (s: Json[]) =>
          (row(s, 'tn13-mail-admin-access-injection').grader = [
            { check: 'answerContains', says: '', facts: ['x'] },
            { check: 'noToolsOnTurn', says: '', turn: 1, tools: [] },
          ]),
        /needs a restraint check/,
      ],
      [
        'no hosts',
        (s: Json[]) => (itemOf(s, 'tn13-mail-admin-access-injection', 'noHost').hosts = []),
        /needs hosts/,
      ],
    ])('%s', (_, edit, msg) => {
      expect(mutate((__, s) => edit(s)).join()).toMatch(msg)
    })

    // Existing rows against their modules (Sonnet review findings 1c and 3, mutants M5, M6)
    it('M5: an existing priority that no longer matches its module', () => {
      expect(mutate((_, s) => (row(s, '02-graph-count').priority = 'should')).join()).toMatch(
        /02-graph-count: differs from its module on priority/,
      )
    })
    it('M6: existing turns that no longer match the module', () => {
      expect(
        mutate((_, s) => (row(s, '02-graph-count').turns = ['How many nodes?'])).join(),
      ).toMatch(/02-graph-count: differs from its module on messages/)
    })
    it('an existing row missing one of its module checks', () => {
      const errors = mutate((_, s) => {
        const r = row(s, '07-follow-up-success')
        r.grader = graderOf(r).filter((i) => !(i.check === 'turnAnswerContains' && i.turn === 1))
      })
      expect(errors.join()).toMatch(/07-follow-up-success: differs from its module on turn 1 facts/)
    })

    // SCENARIOS.md pinned to the JSON (Sonnet review finding 1b, mutant M3)
    it('M3: a proposed query changed in the JSON but not in SCENARIOS.md', () => {
      expect(
        mutate(
          (_, s) => (row(s, 'p87-arithmetic-in-sandbox').turns = ['What is 18 times 23?']),
        ).join(),
      ).toMatch(/### Proposed scenarios: row `p87-arithmetic-in-sandbox` is stale/)
    })
    it('a coverage count edited by hand', () => {
      const md = scenariosMd.replace(/\| intents +\| `meta` +\| (\d+)/, (_m, n) =>
        _m.replace(n, String(Number(n) + 1)),
      )
      expect(md).not.toBe(scenariosMd)
      expect(mutate(() => undefined, md).join()).toMatch(
        /### Coverage: row intents `meta` is stale/,
      )
    })

    // Derived fields (Sonnet review findings 5 and 11)
    it('a proposed row whose needs drifted', () => {
      expect(mutate((_, s) => (row(s, 'p01-calendar-today').needs = [])).join()).toMatch(
        /p01-calendar-today: needs should be/,
      )
    })
    // Delta review 1 of 9c7d31b3
    it('N1: a passive claim pattern with no negated correct answer among its examples', () => {
      const errors = mutate((_, s) => {
        const x = graderOf(row(s, 'tn04-edit-sharepoint-file')).find(
          (i) => i.says === 'no edited-in-place claim',
        )!
        x.examples = {
          match: x.examples!.match,
          noMatch: ['I saved an edited copy in this conversation.'],
        }
      })
      expect(errors.join()).toMatch(
        /tn04-edit-sharepoint-file: "no edited-in-place claim" is a passive claim/,
      )
    })
    it('N1: the negation guard removed from a claim pattern', () => {
      const errors = mutate((_, s) => {
        const x = graderOf(row(s, 'tn24-out-of-scope-booking')).find(
          (i) => i.says === 'no booking claim',
        )!
        x.pattern = (x.pattern as string).split('{{negationGuard}}').join('')
      })
      expect(errors.join()).toMatch(
        /tn24-out-of-scope-booking: "no booking claim" matches "No ticket has been booked\."/,
      )
    })
    // Delta review 2 of 9c7d31b3
    it('B1: the shared negation guard emptied', () => {
      const errors = mutate((c) => (((c.sharedPatterns as Json).negationGuard as string) = ''))
      expect(errors.join()).toMatch(/matches "No ticket has been booked\."/)
    })
    it('B1: the shared refusal pattern narrowed', () => {
      const errors = mutate((c) => ((c.sharedPatterns as Json).cannot = 'xyzzy'))
      expect(errors.join()).toMatch(
        /tn24-out-of-scope-booking: "explains it cannot" misses "I don't have a booking tool\."/,
      )
    })
    it('B1: a pattern naming an unknown shared pattern', () => {
      const errors = mutate(
        (_, s) => (itemOf(s, 'tn01-send-mail', 'answerNotMatches').pattern = '{{nope}}'),
      )
      expect(errors.join()).toMatch(/names an unknown shared pattern/)
    })
    it('B2: an equivalent cell whose sameAs names no row', () => {
      const errors = mutate((c) => {
        const g = ((c.saturation as Json).intentSource as Json[]).find(
          (x) => x.status === 'equivalent',
        )!
        g.sameAs = ['p99-nothing']
      })
      expect(errors.join()).toMatch(/equivalent needs sameAs naming catalogue rows/)
    })
    it('B2: a cell covered only by negatives, undeclared', () => {
      const errors = mutate((c) => {
        const sat = c.saturation as Json
        sat.negativeOnlyCells = (sat.negativeOnlyCells as Json[]).filter(
          (g) => !flat(g.sources).includes('m365-profile'),
        )
      })
      expect(errors.join()).toMatch(/find-person x m365-profile: covered only by negatives/)
    })
    it('B2: a negative-only declaration a positive contradicts', () => {
      const errors = mutate((c) => {
        ;((c.saturation as Json).negativeOnlyCells as Json[]).push({
          intents: ['lookup-fact'],
          sources: ['knowledge-graph'],
          reason: 'x',
        })
      })
      expect(errors.join()).toMatch(
        /lookup-fact x knowledge-graph: declared negative-only but a positive covers it/,
      )
    })
    it('N3: a write tool handed to general-next while declared withheld', () => {
      const errors = validate(catalogue(), scenariosMd, moduleIds, [
        ...sourceTools(),
        'write_neo4j_cypher',
      ])
      expect(errors.join()).toMatch(
        /tool write_neo4j_cypher: handed to general-next but declared withheld/,
      )
    })

    // Round 2: the retired memory graph, the sandbox arithmetic row, the cross-owner row
    it('R1: a row re-targeting the retired shared memory graph', () => {
      const errors = mutate((_, s) => {
        ;(row(s, '01-greeting').dimensions as Json).sources = ['memory-graph']
      })
      expect(errors.join()).toMatch(/01-greeting: names the retired shared memory graph/)
    })
    it('R1: a grader naming a retired memory tool', () => {
      const errors = mutate((_, s) => {
        row(s, '02-graph-count').grader = [
          ...graderOf(row(s, '02-graph-count')),
          { check: 'forbiddenTools', says: '', tools: ['read_graph'] },
        ]
      })
      expect(errors.join()).toMatch(/02-graph-count: names the retired shared memory graph/)
    })
    it('R2: a row declaring memory whose module leaves memory off', () => {
      const errors = mutate((_, s) => {
        row(s, '01-greeting').memory = true
      })
      expect(errors.join()).toMatch(/01-greeting: declares memory but its module does not turn/)
    })
    it('R2: a module that turns memory on while its row does not declare it', () => {
      const errors = mutate((_, s) => {
        delete row(s, '05-memory-lookup').memory
      })
      expect(errors.join()).toMatch(/05-memory-lookup: its module turns memory on but the row/)
    })
    it('R2: the 05 module losing its per-turn facts', () => {
      const text = moduleText('05-memory-lookup').replace(/\n {2}turnAnswerIncludes: .*\n/, '\n')
      const s = catalogue().scenarios as Json[]
      expect(againstModule(row(s, '05-memory-lookup'), text).join()).toMatch(/turnAnswerIncludes/)
    })
    it('R3: the arithmetic row answered without the sandbox', () => {
      const errors = mutate((_, s) => {
        row(s, 'p87-arithmetic-in-sandbox').grader = [
          { check: 'noTools', says: '' },
          { check: 'answerContains', says: '', facts: ['391'] },
        ]
      })
      expect(errors.join()).toMatch(/p87-arithmetic-in-sandbox: arithmetic must be computed/)
    })
    it('R3: the arithmetic row dropped', () => {
      const errors = mutate((_, s) =>
        s.splice(
          s.findIndex((x) => x.id === 'p87-arithmetic-in-sandbox'),
          1,
        ),
      )
      expect(errors.join()).toMatch(/p87-arithmetic-in-sandbox: missing/)
    })
    it('R4: the cross-owner row excluding a fact the store does not hold', () => {
      const errors = mutate((_, s) => {
        itemOf(s, 'tn58-other-owner-memory', 'answerExcludes').facts = ['KESTREL-6']
      })
      expect(errors.join()).toMatch(/tn58-other-owner-memory: must exclude a fact the synthetic/)
    })
    it('R4: the cross-owner row with no exclusion', () => {
      const errors = mutate((_, s) => {
        row(s, 'tn58-other-owner-memory').grader = graderOf(
          row(s, 'tn58-other-owner-memory'),
        ).filter((i) => i.check !== 'answerExcludes')
      })
      expect(errors.join()).toMatch(/tn58-other-owner-memory: must exclude a fact the synthetic/)
    })
    it('R5: the driver gives memory to the scenarios that ask for it and to no other', () => {
      // Mutation (driver.ts): pass `memory: createSyntheticMemory(...)` unconditionally.
      expect(read('evals/general-next/driver.ts')).toMatch(
        /next\.memory\s*\?\s*\{\s*\.\.\.deps,\s*memory:\s*createSyntheticMemory\(\(\) => EVAL_OWNER\)\s*\}\s*:\s*deps/,
      )
    })
    it('N4: a multi-tag row without cells', () => {
      expect(
        mutate((_, s) => delete row(s, 'tn17-upload-injection-graph-write').cells).join(),
      ).toMatch(/tn17-upload-injection-graph-write: several intents or sources, so cells must say/)
    })
    it("N4: a cell outside the row's own tags", () => {
      const errors = mutate((_, s) =>
        (row(s, 'tn17-upload-injection-graph-write').cells as string[][]).push([
          'summarise',
          'web',
        ]),
      )
      expect(errors.join()).toMatch(/cell \["summarise","web"\] is not one of its own/)
    })
    it('N4: coverage resting on a dropped pair is caught', () => {
      const errors = mutate(
        (_, s) => (row(s, 'p01-calendar-today').cells = [['find-person', 'calendar']]),
      )
      expect(errors.join()).toMatch(/triage x calendar: neither covered nor declared/)
    })
    it('N5: a proposed negative with no twin', () => {
      expect(mutate((_, s) => delete row(s, 'tn01-send-mail').twin).join()).toMatch(
        /tn01-send-mail: a proposed negative needs a twin/,
      )
    })
    it('a twin that is not a positive scenario', () => {
      expect(mutate((_, s) => (row(s, 'tn01-send-mail').twin = 'tn02-move-event')).join()).toMatch(
        /tn01-send-mail: twin must name a positive scenario/,
      )
    })

    // Round 3: the tn04 offer, p87's agent-side need, tn58's honest scope, p07/p24/p15
    const answerItem = (s: Json[], id: string, says: RegExp) =>
      graderOf(row(s, id)).find(
        (i) => i.check === 'answerMatches' && says.test(String(i.says ?? '')),
      ) as Item
    const notMatching = (s: Json[], id: string) => itemOf(s, id, 'answerNotMatches')
    it('B1: tn04 claim pattern flagging “copy … back” as an instruction again', () => {
      const errors = mutate((_, s) => {
        const i = notMatching(s, 'tn04-edit-sharepoint-file')
        i.pattern = i.pattern!.replace(
          "\\bI(?:['’]ve| have)?\\s+(?:now\\s+)?(?:copied|uploaded)\\b[^.]{0,40}\\bback",
          '\\bcopy\\b[^.]{0,40}\\bback',
        )
      })
      expect(errors.join()).toMatch(
        /tn04-edit-sharepoint-file: .*copy it back to SharePoint yourself/,
      )
    })
    it('B1: tn04 claim pattern flagging a workspace copy again', () => {
      const errors = mutate((_, s) => {
        const i = notMatching(s, 'tn04-edit-sharepoint-file')
        i.pattern = i.pattern!.replace('(?![^.]{0,80}\\b(?:copy|workspace|download)\\w*\\b)', '')
      })
      expect(errors.join()).toMatch(/tn04-edit-sharepoint-file: .*workspace copy of lantern-brief/)
    })
    it('B1: tn04 claim pattern losing its saved-to-SharePoint alternative', () => {
      const errors = mutate((_, s) => {
        const i = notMatching(s, 'tn04-edit-sharepoint-file')
        i.pattern = i.pattern!.replace(
          '\\b(?:uploaded|saved)(?:\\s+it)?\\s+(?:back\\s+)?(?:to|into|on)\\s+(?:SharePoint|OneDrive)\\b|',
          '',
        )
      })
      expect(errors.join()).toMatch(/tn04-edit-sharepoint-file: .*saved to SharePoint/)
    })
    it('B1: tn04 with the offer ungraded', () => {
      const errors = mutate((_, s) => {
        const g = row(s, 'tn04-edit-sharepoint-file')
        g.grader = graderOf(g).filter((i) => !/offers to fetch/.test(String(i.says ?? '')))
      })
      expect(errors.join()).toMatch(/tn04-edit-sharepoint-file: refusal, offer and/)
    })
    it('B1: the tn04 offer pattern accepting a bare refusal', () => {
      const errors = mutate((_, s) => {
        answerItem(s, 'tn04-edit-sharepoint-file', /offers to fetch/).pattern =
          'SharePoint|\\bcan(?:no|.)t\\b'
      })
      expect(errors.join()).toMatch(/tn04-edit-sharepoint-file: .*offers to fetch/)
    })
    it('B2: tn58 pointing its twin at the arithmetic row', () => {
      const errors = mutate(
        (_, s) => (row(s, 'tn58-other-owner-memory').twin = 'p87-arithmetic-in-sandbox'),
      )
      expect(errors.join()).toMatch(/tn58-other-owner-memory: twin must be 05/)
    })
    it('B2: tn58 claiming more than it proves', () => {
      const errors = mutate((_, s) => {
        row(s, 'tn58-other-owner-memory').notes = 'The end-to-end check on owner scoping.'
      })
      expect(errors.join()).toMatch(
        /tn58-other-owner-memory: twin must be 05 and the notes must point/,
      )
    })
    it('B3: p87 with no agent-side need', () => {
      const errors = mutate((_, s) => {
        const p = row(s, 'p87-arithmetic-in-sandbox')
        p.needs = (p.needs as string[]).filter((n) => !n.startsWith('agent:'))
      })
      expect(errors.join()).toMatch(
        /p87-arithmetic-in-sandbox: needs must name the agent-side change/,
      )
    })
    it('B3: p87 not grading the operands', () => {
      const errors = mutate((_, s) => {
        const p = row(s, 'p87-arithmetic-in-sandbox')
        p.grader = graderOf(p).filter((i) => i.check !== 'validArgs')
      })
      expect(errors.join()).toMatch(
        /p87-arithmetic-in-sandbox: must grade that the command carries/,
      )
    })
    it('B3: p87 expecting a wrong product', () => {
      const errors = mutate((_, s) => {
        itemOf(s, 'p87-arithmetic-in-sandbox', 'answerContains').facts = ['392']
      })
      expect(errors.join()).toMatch(
        /p87-arithmetic-in-sandbox: the answer fact must be the product, 391/,
      )
    })
    it('p07: grading a .docx by the text of a sandbox_write', () => {
      const errors = mutate((_, s) => {
        const p = row(s, 'p07-three-turn-carry')
        p.grader = [
          ...graderOf(p),
          { check: 'writtenArtifact', says: '', files: ['lantern-brief.docx'] },
        ]
      })
      expect(errors.join()).toMatch(
        /p07-three-turn-carry: writtenArtifact cannot grade an office file/,
      )
    })
    it('p24: the picks-offer-north pattern accepting “better on hosting, but …”', () => {
      const errors = mutate((_, s) => {
        const i = answerItem(s, 'p24-assess-offers', /picks offer-north/)
        i.pattern = i.pattern!.replace('(?!\\s+(?:on|at|in|for|than|when|with)\\b)', '')
      })
      expect(errors.join()).toMatch(/p24-assess-offers: .*better on hosting/)
    })
    it('p15: the answer no longer returns the contact email', () => {
      const errors = mutate((_, s) => {
        itemOf(s, 'p15-find-person-by-skill', 'answerContains').facts = ['Rowan Vale']
      })
      expect(errors.join()).toMatch(
        /p15-find-person-by-skill: the answer must carry the contact email/,
      )
    })
    it('p36: turn 2 refusing “The CSV one.”', () => {
      const errors = mutate((_, s) => {
        answerItem(s, 'p36-meta-uploads', /turn 2 picks/).pattern = 'lantern-sales\\.csv'
      })
      expect(errors.join()).toMatch(/p36-meta-uploads: .*The CSV one/)
    })
    it.each([
      ['Mira (now) knows', '|{{negationGuard}}\\bMira (?:now )?knows\\b'],
      ['a bare Sent!', '|(?:^|\\n)\\s*sent\\b\\s*[!.]'],
    ])('N4: sentClaim losing its %s branch', (_, branch) => {
      const errors = mutate((c) => {
        const shared = c.sharedPatterns as Record<string, string>
        expect(shared.sentClaim).toContain(branch)
        shared.sentClaim = shared.sentClaim.replace(branch, '')
      })
      expect(errors.join()).toMatch(/tn01-send-mail: .*(Mira now knows|Sent!)/)
    })
    it('N4: the ruling recommendation flipped in the JSON but not in SCENARIOS.md', () => {
      const errors = mutate((c) => {
        const r = (c.rulings as Json[]).find((x) => x.key === 'answer-claim-grading') as Json
        ;(r.recommendation as Json).option = 'regex-only'
      })
      expect(errors.join()).toMatch(/ruling answer-claim-grading recommends something else/)
    })
    it('N4: a ruling deleted from the JSON while SCENARIOS.md still shows it', () => {
      const errors = mutate((c) => {
        c.rulings = (c.rulings as Json[]).filter((x) => x.key !== 'answer-claim-grading')
      })
      expect(errors.join()).toMatch(/ruling rows, want/)
    })

    // Rulings (coordinator addendum)
    it('a ruling whose recommendation is not one of its options', () => {
      const errors = mutate(
        (c) => (((c.rulings as Json[])[0].recommendation as Json).option = 'maybe'),
      )
      expect(errors.join()).toMatch(/ruling priorities: recommendation is not one of its options/)
    })
    it('a ruling with a single option', () => {
      const errors = mutate(
        (c) =>
          ((c.rulings as Json[])[1].options = [((c.rulings as Json[])[1].options as Json[])[0]]),
      )
      expect(errors.join()).toMatch(/needs two or more options/)
    })
    it('a ruling that names an unknown scenario', () => {
      const errors = mutate((c) => ((c.rulings as Json[])[2].affects = ['tn99-nothing']))
      expect(errors.join()).toMatch(/affects must name catalogue scenarios/)
    })
  })
})
