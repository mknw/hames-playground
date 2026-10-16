/** Live metadata rule for the general-next driver: only the withheld write tool may fall back. */
import { it, expect } from 'vitest'
import { liveDescriptions } from '../../../../evals/general-next/driver'

const d = (name: string, description = name) => ({ name, description, inputSchema: {} })
const names = ['read_neo4j_cypher', 'write_neo4j_cypher', 'search']
const fixtures = names.map((n) => d(n, `fixture ${n}`))

it('falls back to the fixture only for the read-only-withheld write tool', () => {
  const live = [d('read_neo4j_cypher', 'prod'), d('search', 'prod')]
  const out = liveDescriptions(names, live, fixtures)
  expect(out.map((t) => t.description)).toEqual(['prod', 'fixture write_neo4j_cypher', 'prod'])
})

it('prefers the production description when the gateway does list the write tool', () => {
  const live = names.map((n) => d(n, 'prod'))
  expect(liveDescriptions(names, live, fixtures).every((t) => t.description === 'prod')).toBe(true)
})

it('still refuses a missing production description for any other tool', () => {
  const live = [d('read_neo4j_cypher', 'prod')]
  expect(() => liveDescriptions(names, live, fixtures)).toThrow(
    'Production tool metadata missing: search',
  )
})
