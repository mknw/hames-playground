/**
 * Environment-aware service endpoints (`lib/config/endpoints.ts`).
 *
 * The contract is the dev↔container swap: localhost URLs when Vite reports a
 * dev build, docker-compose service names otherwise. Getting that backwards
 * points the app at a host that does not exist in the other environment, so
 * both sides are asserted, plus the per-service accessor agreeing with the
 * bundle it reads from.
 */

import { describe, it, expect, afterEach } from 'vitest'

import { getEndpoints, getEndpoint, resolveIsDev } from '../../../lib/config/endpoints'

const env = import.meta.env as Record<string, unknown>
const originalDev = env.DEV
const originalBoltUrl = process.env.NEO4J_BOLT_URL
const originalHttpUrl = process.env.NEO4J_HTTP_URL

afterEach(() => {
  env.DEV = originalDev
  if (originalBoltUrl === undefined) delete process.env.NEO4J_BOLT_URL
  else process.env.NEO4J_BOLT_URL = originalBoltUrl
  if (originalHttpUrl === undefined) delete process.env.NEO4J_HTTP_URL
  else process.env.NEO4J_HTTP_URL = originalHttpUrl
})

describe('getEndpoints', () => {
  it('uses localhost in a dev build', () => {
    env.DEV = true

    expect(getEndpoints()).toEqual({
      mcpGateway: 'http://localhost:3000/mcp',
      neo4j: { http: 'http://localhost:7474', bolt: 'bolt://localhost:7687' },
    })
  })

  it('uses docker-compose service names otherwise', () => {
    env.DEV = false

    expect(getEndpoints()).toEqual({
      mcpGateway: 'http://mcp-gateway:3000/mcp',
      neo4j: { http: 'http://neo4j:7474', bolt: 'bolt://neo4j:7687' },
    })
  })
})

describe('Neo4j env overrides', () => {
  it('override the dev defaults when set', () => {
    env.DEV = true
    process.env.NEO4J_BOLT_URL = 'bolt://localhost:17687'
    process.env.NEO4J_HTTP_URL = 'http://localhost:17474'

    expect(getEndpoints().neo4j).toEqual({
      http: 'http://localhost:17474',
      bolt: 'bolt://localhost:17687',
    })
  })

  it('override the docker-compose service names too', () => {
    env.DEV = false
    process.env.NEO4J_BOLT_URL = 'bolt://neo4j-rv:17687'
    process.env.NEO4J_HTTP_URL = 'http://neo4j-rv:17474'

    expect(getEndpoints().neo4j).toEqual({
      http: 'http://neo4j-rv:17474',
      bolt: 'bolt://neo4j-rv:17687',
    })
  })

  it('are independent — one set leaves the other at its default', () => {
    env.DEV = true
    process.env.NEO4J_BOLT_URL = 'bolt://localhost:17687'
    delete process.env.NEO4J_HTTP_URL

    expect(getEndpoints().neo4j).toEqual({
      http: 'http://localhost:7474',
      bolt: 'bolt://localhost:17687',
    })
  })

  it('leave the defaults byte-identical when unset, in both environments', () => {
    env.DEV = true
    delete process.env.NEO4J_BOLT_URL
    delete process.env.NEO4J_HTTP_URL
    expect(getEndpoints().neo4j).toEqual({
      http: 'http://localhost:7474',
      bolt: 'bolt://localhost:7687',
    })

    env.DEV = false
    expect(getEndpoints().neo4j).toEqual({
      http: 'http://neo4j:7474',
      bolt: 'bolt://neo4j:7687',
    })
  })

  it('the per-service accessor returns the overridden bolt URL', () => {
    env.DEV = true
    process.env.NEO4J_BOLT_URL = 'bolt://localhost:17687'

    expect(getEndpoint('neo4jBolt')).toBe('bolt://localhost:17687')
  })
})

describe('getEndpoint', () => {
  it('returns the same value as the bundle for every service', () => {
    for (const dev of [true, false]) {
      env.DEV = dev
      const all = getEndpoints()

      expect(getEndpoint('mcpGateway')).toBe(all.mcpGateway)
      expect(getEndpoint('neo4jHttp')).toBe(all.neo4j.http)
      expect(getEndpoint('neo4jBolt')).toBe(all.neo4j.bolt)
    }
  })
})

describe('resolveIsDev', () => {
  // `import.meta.env` is Vite's injection and is absent outside a Vite
  // pipeline — the CLI scripts under `lib/org-graph/scripts/` run under `tsx`,
  // where reading `.DEV` off `undefined` threw before any caller of
  // `getNeo4jDriver` reached the database. The decision is a pure function
  // precisely so this case is assertable: each module has its own
  // `import.meta`, so no test file can make the source's read see `undefined`.
  it('treats an absent env as dev, so a hand-run script gets localhost', () => {
    expect(resolveIsDev(undefined)).toBe(true)
  })

  it('honours an explicit flag either way', () => {
    expect(resolveIsDev({ DEV: true })).toBe(true)
    expect(resolveIsDev({ DEV: false })).toBe(false)
  })

  it('treats a present env with no DEV flag as a build, not as dev', () => {
    // An env object that exists means Vite ran; a missing DEV there is a
    // production bundle, and defaulting it to dev would point the app at
    // localhost from inside the compose network.
    expect(resolveIsDev({})).toBe(false)
  })
})
