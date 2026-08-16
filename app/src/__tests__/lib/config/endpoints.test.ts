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

import { getEndpoints, getEndpoint } from '../../../lib/config/endpoints'

const env = import.meta.env as Record<string, unknown>
const originalDev = env.DEV

afterEach(() => {
  env.DEV = originalDev
})

describe('getEndpoints', () => {
  it('uses localhost in a dev build', () => {
    env.DEV = true

    expect(getEndpoints()).toEqual({
      mcpGateway: 'http://localhost:3000/mcp',
      n8n: 'http://localhost:5678',
      neo4j: { http: 'http://localhost:7474', bolt: 'bolt://localhost:7687' },
    })
  })

  it('uses docker-compose service names otherwise', () => {
    env.DEV = false

    expect(getEndpoints()).toEqual({
      mcpGateway: 'http://mcp-gateway:3000/mcp',
      n8n: 'http://n8n:5678',
      neo4j: { http: 'http://neo4j:7474', bolt: 'bolt://neo4j:7687' },
    })
  })
})

describe('getEndpoint', () => {
  it('returns the same value as the bundle for every service', () => {
    for (const dev of [true, false]) {
      env.DEV = dev
      const all = getEndpoints()

      expect(getEndpoint('mcpGateway')).toBe(all.mcpGateway)
      expect(getEndpoint('n8n')).toBe(all.n8n)
      expect(getEndpoint('neo4jHttp')).toBe(all.neo4j.http)
      expect(getEndpoint('neo4jBolt')).toBe(all.neo4j.bolt)
    }
  })
})
