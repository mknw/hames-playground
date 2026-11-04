// @vitest-environment node
/**
 * The graph store seam, slice 2 (`docs/plan/org-knowledge-hook.md`).
 *
 * 1. The shared contract against the in-memory adapter (always).
 * 2. The Neo4j adapter's statements against a recording driver: createdBy only
 *    where a node or edge is created, MERGE for a name-keyed node, and nothing
 *    interpolated into Cypher but the ontology's own labels and types.
 *
 * The same contract against a real, DISPOSABLE Neo4j is
 * `org-graph-store-neo4j.test.ts`, skipped unless one is named.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { createMemoryOrgGraphStore } from '@hames-ai/harness-patterns/org-knowledge-store'
import {
  validateOrgDraft,
  type CheckedAssertion,
  type GraphSnapshot,
} from '@hames-ai/harness-patterns/org-knowledge-validate.server'
import { createNeo4jOrgGraphStore } from '../../../lib/org-graph/org-graph-store.server'
import { ORG_ONTOLOGY } from '../../../lib/org-graph/ontology'
import { orgGraphStoreContract, seedNode } from './org-graph-store-contract'

orgGraphStoreContract('in-memory', async (seed) => {
  const store = createMemoryOrgGraphStore(ORG_ONTOLOGY, seed)
  return {
    store,
    read: async () => store.dump() as never,
    setProperty: async (key, prop, value) => store.setProperty(key, prop, value),
    addEdge: async (type, from, to) => store.addEdge(type, from, to),
  }
})

// ----------------------------------------------------------------------------
// The Neo4j adapter against a recording driver
// ----------------------------------------------------------------------------

type Call = { q: string; p: Record<string, unknown> }

/** A driver double: records every statement and answers each with the rows
 *  `answer` gives (a key for a RETURN … AS key, nothing otherwise). */
function recordingDriver(
  stored: Record<string, { labels: string[]; properties: Record<string, string> }> = {},
) {
  const calls: Call[] = []
  const tx = {
    run: async (q: string, p: Record<string, unknown> = {}) => {
      calls.push({ q, p })
      // The in-transaction re-read of stored nodes by key; nothing else is stored.
      const reread = /RETURN n, .* AS key$/.test(q) && /IN \$keys/.test(q) && !/-\[r\]-/.test(q)
      const rows = reread
        ? (p.keys as string[]).filter((k) => stored[k]).map((k) => ({ n: stored[k], key: k }))
        : /AS key\b/.test(q) && !/IN \$keys/.test(q)
          ? [{ key: `id:${String(p.id ?? 'x')}` }]
          : []
      return {
        records: rows.map((r) => ({ get: (k: string) => (r as Record<string, unknown>)[k] })),
      }
    },
  }
  const session = {
    executeRead: async (fn: (t: typeof tx) => unknown) => fn(tx),
    executeWrite: async (fn: (t: typeof tx) => unknown) => fn(tx),
    close: async () => undefined,
  }
  return { calls, driver: () => ({ session: () => session }) as never }
}

const check = (
  elements: Parameters<typeof validateOrgDraft>[0]['elements'],
  message: string,
  snapshot: GraphSnapshot = { nodes: [], edges: [] },
): CheckedAssertion => {
  const v = validateOrgDraft({ elements }, snapshot, ORG_ONTOLOGY, {
    userMessage: message,
    today: '2026-11-04',
    mentionsMember: () => false,
  })
  expect(v.rejected).toEqual({})
  return v.accepted[0]
}

const ACTOR = { userId: 'user-a', now: '2026-11-04T10:00:00.000Z' }

describe('the Neo4j adapter’s statements', () => {
  const heron = () =>
    check(
      [
        {
          kind: 'node',
          ref: 'p',
          label: 'Project',
          properties: { name: 'Heron' },
          evidence: 'workstream Project Heron',
          assertion: 0,
        },
      ],
      "We've started calling the new logistics workstream Project Heron.",
    )

  // Design pin: a repeat applies to the same node. Mutation: CREATE instead of
  // MERGE → this statement no longer merges on the name key.
  it('merges a name-keyed node on (label, nameKey)', async () => {
    const { calls, driver } = recordingDriver()
    await createNeo4jOrgGraphStore({ ontology: ORG_ONTOLOGY, driver, newId: () => 'n1' }).apply(
      heron(),
      ACTOR,
    )
    const write = calls.find((c) => c.q.includes('Project'))!
    expect(write.q.startsWith('MERGE (n:`Project` {nameKey: $nameKey})')).toBe(true)
    expect(write.p).toMatchObject({ nameKey: 'heron', id: 'n1', actor: 'user-a' })
  })

  // Design pin: createdBy is set on create and never on match. Mutation: SET
  // createdBy unconditionally → a statement sets it outside ON CREATE / CREATE.
  it('sets createdBy only where a node or edge is created', async () => {
    const { calls, driver } = recordingDriver({
      'id:osprey': {
        labels: ['Project'],
        properties: { id: 'osprey', name: 'Osprey', nameKey: 'osprey' },
      },
    })
    const snapshot = {
      nodes: [seedNode('osprey', 'Project', { name: 'Osprey', nameKey: 'osprey' })],
      edges: [],
    }
    const fact = check(
      [
        {
          kind: 'node',
          ref: 'f',
          label: 'Fact',
          properties: { text: 'The Osprey budget is 40,000 euro', kind: 'budget' },
          evidence: 'The Osprey budget is 40,000 euro',
          assertion: 0,
        },
        {
          kind: 'node',
          ref: 'p',
          label: 'Project',
          properties: { name: 'Osprey', status: 'active' },
          evidence: 'The Osprey budget',
          assertion: 0,
        },
        {
          kind: 'edge',
          type: 'ABOUT',
          from: 'f',
          to: 'p',
          evidence: 'The Osprey budget is 40,000 euro',
          assertion: 0,
        },
      ],
      'The Osprey budget is 40,000 euro and it is active.',
      snapshot,
    )
    const store = createNeo4jOrgGraphStore({ ontology: ORG_ONTOLOGY, driver, newId: () => 'n1' })
    await store.apply(heron(), ACTOR)
    await store.apply(fact, ACTOR)
    const setsCreatedBy = calls.filter((c) => /createdBy\s*=/.test(c.q))
    expect(setsCreatedBy.length).toBeGreaterThanOrEqual(3) // Heron, the fact, the ABOUT edge
    for (const { q } of setsCreatedBy) {
      for (const clause of q.split(/(?=\bSET\b)/)) {
        if (!/createdBy\s*=/.test(clause)) continue
        // The SET carrying createdBy is an ON CREATE SET, or follows a CREATE.
        const before = q.slice(0, q.indexOf(clause))
        expect(/ON CREATE $/.test(before) || /^CREATE \(/.test(q)).toBe(true)
      }
    }
    // The update of the existing Osprey is a plain MATCH … SET, without createdBy.
    const update = calls.find((c) => c.p.key === 'id:osprey')!
    expect(update.q).not.toMatch(/createdBy/)
  })

  it('refuses a relation type outside the ontology before running it', async () => {
    const { calls, driver } = recordingDriver()
    const bad = {
      ...heron(),
      edges: [
        {
          element: {
            kind: 'edge',
            type: 'REPORTS_TO',
            from: 'p',
            to: 'p',
            evidence: '',
            assertion: 0,
          },
          verdict: 'new',
          removes: [],
        },
      ],
    } as unknown as CheckedAssertion
    await expect(
      createNeo4jOrgGraphStore({ ontology: ORG_ONTOLOGY, driver }).apply(bad, ACTOR),
    ).rejects.toThrow(/REPORTS_TO is not an ontology relation/)
    expect(calls.some((c) => c.q.includes('REPORTS_TO'))).toBe(false)
  })

  // Design pin: every label and type in the Neo4j adapter's Cypher comes from
  // the ontology's sets, never from input. Mutation: interpolate a value into a
  // statement (e.g. `{nameKey: '${props.nameKey}'}`) → this scan names it.
  it('interpolates nothing into Cypher but L(), T() and KEY()', () => {
    const src = readFileSync(
      resolve(__dirname, '../../../lib/org-graph/org-graph-store.server.ts'),
      'utf8',
    )
    // Refusal messages are not Cypher; KEY's own body interpolates its literal alias.
    const keyBody = src.slice(src.indexOf('function KEY('), src.indexOf('// Reading'))
    const rest = src
      .replace(keyBody, '')
      .split('\n')
      .filter((line) => !/throw new Error\(`org-graph store: /.test(line))
      .join('\n')
    const interpolations = [...rest.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1])
    expect(interpolations.length).toBeGreaterThan(10) // the scan sees the statements
    const offending = interpolations.filter(
      (x) => !/^(?:L|T)\(ontology, [\w.!]+\)$/.test(x) && !/^KEY\('[a-z]'\)$/.test(x),
    )
    expect(offending).toEqual([])
  })
})
