/**
 * The general-next question-space catalogue (`evals/general-next/scenarios.catalogue.json`)
 * is data for the owner's review: read as text, never imported (src/ may not import evals/).
 * Every rule below is one the review page and a later implementation rely on.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

type Json = Record<string, unknown>
const read = (file: string) => readFileSync(resolve(file), 'utf8')
const catalogue = (): Json => JSON.parse(read('evals/general-next/scenarios.catalogue.json'))
const scenariosMd = read('evals/general-next/SCENARIOS.md')
const moduleIds = readdirSync(resolve('evals/general-next/scenarios'))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => f.replace(/\.ts$/, ''))

const LISTS = ['routes', 'sources', 'output', 'guardPaths']
const SCALARS = ['turnShape', 'toolShape', 'tier']
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
])
const TURNS: Record<string, (n: number) => boolean> = {
  single: (n) => n === 1,
  'follow-up': (n) => n === 2,
  'multi-turn': (n) => n >= 3,
  'failure-recovery': (n) => n >= 1,
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

function validate(c: Json, md: string, modules: string[]): string[] {
  const errors: string[] = []
  const required = c.required as string[]
  const allowed = new Set([...required, ...(c.optional as string[])])
  const vocab = c.dimensions as Record<string, { values: string[] }>
  const checks = new Set(Object.keys(c.checks as Json).filter((k) => k !== '$comment'))
  const scenarios = c.scenarios as Json[]
  const ids = scenarios.map((s) => s.id as string)

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

    const grader = s.grader
    if ('grader' in s) {
      if (!Array.isArray(grader) || !grader.length) errors.push(`${at}: grader must be non-empty`)
      else {
        for (const item of grader as Json[])
          if (!checks.has(item.check as string) || typeof item.says !== 'string')
            errors.push(`${at}: grader check ${String(item.check)}`)
        if (
          s.kind === 'negative' &&
          !(grader as Json[]).some((i) => RESTRAINT.has(i.check as string))
        )
          errors.push(`${at}: a negative needs a restraint check`)
      }
    }
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
  return errors
}

describe('general-next scenario catalogue', () => {
  it('is valid against its own vocabularies and SCENARIOS.md', () => {
    expect(validate(catalogue(), scenariosMd, moduleIds)).toEqual([])
  })

  it('reads the 18 implemented scenarios from SCENARIOS.md, not zero', () => {
    // Guards the parser: an empty heading match would make the cross-check vacuous.
    expect(existingIds(scenariosMd)).toHaveLength(18)
    expect(moduleIds.length).toBeGreaterThanOrEqual(17)
  })

  describe('goes red on each defect', () => {
    const mutate = (edit: (c: Json, scenarios: Json[]) => void): string[] => {
      const c = catalogue()
      edit(c, c.scenarios as Json[])
      return validate(c, scenariosMd, moduleIds)
    }
    const first = (scenarios: Json[], kind: string) =>
      scenarios.find((s) => s.status === 'proposed' && s.kind === kind) as Json

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
    it('a proposed priority of nice', () => {
      expect(mutate((_, s) => (first(s, 'negative').priority = 'nice')).join()).toMatch(
        /bad priority/,
      )
    })
  })
})
