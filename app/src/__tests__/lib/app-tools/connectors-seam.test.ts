/**
 * The connectors seam pin (#225 PR-C2) — ONE registry, composed once.
 *
 * Modeled on `agent-deps-seam.test.ts` (the PR-2 template): the composition
 * root builds the registry with the app's identity resolver, registers the
 * package's Graph tools into THAT instance, registers the transport over THAT
 * instance, and re-exports the instance's methods flat. The property under
 * pin is that all of those are the SAME registry — a composition that built a
 * second registry locally (say, passing a fresh `createAppToolRegistry(...)` to
 * `registerGraphConnectorTools` instead of the one the transport consults)
 * would register the tools into an instance nothing dispatches to, and
 * `graph_me` would silently fall through to the MCP gateway.
 *
 * Verified by mutation (see the PR body): building a dual registry in the
 * composition root reddens these tests while the rest of the suite can stay
 * green — which is exactly why the pin exists.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('@hames/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

vi.mock('../../../lib/harness-client/request-user.server', () => ({
  getRequestUserId: vi.fn(() => 'oid-1'),
  getRequestSessionId: vi.fn(() => 'sess-1'),
  runWithUserId: (_u: string, fn: () => Promise<unknown>) => fn(),
  runWithRequestContext: (_c: unknown, fn: () => Promise<unknown>) => fn(),
}))

vi.mock('../../../lib/auth/graph-token.server', () => ({
  GraphAuthRequiredError: class GraphAuthRequiredError extends Error {
    constructor(
      message: string,
      readonly userId: string,
      readonly status?: number,
    ) {
      super(message)
      this.name = 'GraphAuthRequiredError'
    }
  },
  graphFetch: vi.fn(async () => ({ userPrincipalName: 'oid-1' })),
  GRAPH_BASE: 'https://graph.microsoft.com/v1.0',
  DEFAULT_GRAPH_SCOPES: ['User.Read'],
}))

// Importing the barrel performs the composition: registry + graph tools +
// transport, all in one module side effect.
import {
  registerAppTool,
  hasAppTool,
  appToolDescriptions,
} from '../../../lib/app-tools/index.server'

describe('the connectors seam: one registry, composed once (PR-C2)', () => {
  it('the flat exports and the transport dispatch to the registry that holds the graph tools', async () => {
    // The Graph tools were registered by the PACKAGE factory into the registry
    // the composition root built — reachable through the flat exports…
    expect(hasAppTool('graph_me')).toBe(true)
    expect(appToolDescriptions().map((t) => t.name)).toContain('graph_me')

    // …and through core's dispatch (the transport), which must find them
    // IN-PROCESS rather than falling through to the gateway.
    const { callTool } = await import('@hames/harness-patterns/mcp-client.server')
    const res = await callTool('graph_me', {})
    expect(res.success).toBe(true)
    expect((res.data as { userPrincipalName: string }).userPrincipalName).toBe('oid-1')
  })

  it('a tool registered through the FLAT export is reachable through the TRANSPORT', async () => {
    // The inverse direction: the flat `registerAppTool` and the transport's
    // dispatch must be the same registry too. A composition that re-exported a
    // SECOND registry's methods would pass the test above and fail this one.
    registerAppTool({
      name: 'seam_sentinel',
      namespace: 'test',
      description: 'seam pin sentinel',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => 'sentinel-ok',
    })

    const { callTool } = await import('@hames/harness-patterns/mcp-client.server')
    const res = await callTool('seam_sentinel', {})
    expect(res.success).toBe(true)
    expect(res.data).toBe('sentinel-ok')
  })

  it('the composition composes the PACKAGE factories (not local copies)', async () => {
    // The barrel imports `createAppToolRegistry` / `registerGraphConnector`
    // `Tools` from @hames/connectors — asserted mechanically so a future edit
    // that re-points one of them at a local copy (the quiet way to fork the
    // registry) reddens here rather than passing by accident.
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/lib/app-tools/index.server.ts'),
      'utf8',
    )
    expect(source).toContain("from '@hames/connectors/app-tools/registry'")
    expect(source).toContain("from '@hames/connectors/graph/graph-tools.server'")
    expect(source).toContain("from '@hames/connectors/mcp-catalog'")
    // And the dual-instance shape itself: exactly ONE createAppToolRegistry
    // call and exactly ONE registerGraphConnectorTools call in the composition.
    expect(source.match(/createAppToolRegistry\(/g)).toHaveLength(1)
    expect(source.match(/registerGraphConnectorTools\(/g)).toHaveLength(1)
  })
})
