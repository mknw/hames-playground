/**
 * The dev-only in-memory org graph (the browser suite's second seam), and the
 * opt-in that keeps it off. `browser-e2e-not-in-ci.test.ts` pins both gates by
 * reading the source; this pins the BEHAVIOUR a source scan cannot see.
 * `import.meta.env.DEV` is true under vitest, so the DEV gate is the source
 * pin's to cover.
 *
 * Mutations, each verified red:
 * - drop the opt-in check → "builds nothing without the opt-in" goes red.
 * - keep the store in a module variable → "one store across module instances" goes red.
 * - consult the Neo4j adapter before the seam → "orgGraphStore uses it" goes red.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const KEY = Symbol.for('hames.devMemoryOrgGraph')
const original = process.env.E2E_ORG_GRAPH

async function load() {
  vi.resetModules()
  return import('~/lib/org-graph/dev-memory-org-graph.server')
}

afterEach(() => {
  if (original === undefined) delete process.env.E2E_ORG_GRAPH
  else process.env.E2E_ORG_GRAPH = original
  delete (globalThis as Record<symbol, unknown>)[KEY]
})

describe('the dev-only in-memory org graph', () => {
  it('builds nothing without the opt-in, or with another value', async () => {
    delete process.env.E2E_ORG_GRAPH
    expect((await load()).devMemoryOrgGraph()).toBeNull()
    process.env.E2E_ORG_GRAPH = 'neo4j'
    expect((await load()).devMemoryOrgGraph()).toBeNull()
  })

  it('with the opt-in, starts empty and is one store across module instances', async () => {
    process.env.E2E_ORG_GRAPH = 'memory'
    const a = (await load()).devMemoryOrgGraph()!
    const b = (await load()).devMemoryOrgGraph()!
    expect(a).toBe(b)
    expect(await a.snapshot({ names: [{ label: 'Project', name: 'Heron' }], keys: [] })).toEqual({
      nodes: [],
      edges: [],
    })
  })

  it('orgGraphStore uses it ahead of the Neo4j adapter, and a test override ahead of both', async () => {
    process.env.E2E_ORG_GRAPH = 'memory'
    vi.resetModules()
    const { orgGraphStore, configureOrgGraphStore } = await import('~/lib/org-graph/hook.server')
    const { devMemoryOrgGraph } = await import('~/lib/org-graph/dev-memory-org-graph.server')
    expect(orgGraphStore()).toBe(devMemoryOrgGraph())
    const override = { snapshot: vi.fn(), apply: vi.fn() }
    configureOrgGraphStore(override)
    expect(orgGraphStore()).toBe(override)
    configureOrgGraphStore(undefined)
  })
})
