/**
 * Cross-user isolation of the REGISTRY (#110 / #107) — the package half of the
 * split (#225 PR-C2).
 *
 * The host's `user-isolation.test.ts` pins the composition end-to-end — the
 * host's real AsyncLocalStorage request scope feeding the resolvers it
 * injected, through its own composition root. What only THIS package owns, and
 * what this file pins, is the registry's half of the property: identity is
 * resolved PER CALL through the injected resolvers (never cached at
 * registration, never taken from args), so concurrent calls through one
 * registry instance cannot observe each other's scope. The scope mechanism
 * below is a test-local AsyncLocalStorage standing in for the host's — the
 * property under test is the registry's read discipline, not the host's scope.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createAppToolRegistry } from '../../app-tools/registry'
import { registerGraphConnectorTools } from '../../graph/graph-tools.server'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The request-scope stand-in: what the host's runWithUserId/runWithRequestContext do. */
const als = new AsyncLocalStorage<{ userId: string | null; sessionId: string | null }>()

const registry = createAppToolRegistry({
  resolveContext: {
    // The scope is ENTIRELY the AsyncLocalStorage: no ambient fallback, so a
    // call outside any scope resolves null and the registry refuses it — the
    // property under test.
    userId: () => als.getStore()?.userId ?? null,
    sessionId: () => als.getStore()?.sessionId ?? null,
  },
})

// Graph stubbed to echo back whichever userId reached it, after a delay, so
// any bleed between concurrent calls shows up as a mismatch — the same shape
// the host-side suite uses.
registerGraphConnectorTools({
  registerAppTool: registry.registerAppTool,
  graphFetch: async (userId: string) => {
    await sleep(userId === 'user-A' ? 30 : 5) // A is slow, B/C overtake it
    return { userPrincipalName: userId }
  },
  content: {
    conversionEnabled: () => false,
    isConvertible: () => false,
    guessMimeType: () => 'text/plain',
    isTextMime: () => true,
  },
  stash: {
    loadStore: async () => ({
      storeDocument: async () => ({ id: 'doc-1', size: 0 }),
      maxContentBytes: 5 * 1024 * 1024,
    }),
    ingest: async () => null,
  },
})

const runWith = <T>(ctx: { userId: string | null; sessionId: string | null }, fn: () => Promise<T>) =>
  als.run(ctx, fn)

describe('request-scoped identity under concurrency', () => {
  it("keeps each user's identity separate across interleaved calls", async () => {
    const call = (u: string) =>
      runWith({ userId: u, sessionId: 'sess-1' }, async () => {
        // Yield before and after, so the scopes are genuinely interleaved.
        await sleep(1)
        const res = await registry.runAppTool('graph_me', {})
        await sleep(1)
        return res
      })

    const [a, b, c] = await Promise.all([call('user-A'), call('user-B'), call('user-C')])

    // Each call must see ONLY its own user — the slow one included.
    expect((a.data as { userPrincipalName: string }).userPrincipalName).toBe('user-A')
    expect((b.data as { userPrincipalName: string }).userPrincipalName).toBe('user-B')
    expect((c.data as { userPrincipalName: string }).userPrincipalName).toBe('user-C')
  })

  it('nested scopes do not leak outward', async () => {
    const result = await runWith({ userId: 'outer-user', sessionId: null }, async () => {
      const inner = await runWith({ userId: 'inner-user', sessionId: null }, () =>
        registry.runAppTool('graph_me', {}),
      )
      const outer = await registry.runAppTool('graph_me', {})
      return { inner, outer }
    })

    expect((result.inner.data as { userPrincipalName: string }).userPrincipalName).toBe(
      'inner-user',
    )
    // After the nested scope closes, the outer identity is intact.
    expect((result.outer.data as { userPrincipalName: string }).userPrincipalName).toBe(
      'outer-user',
    )
  })

  it('refuses outside any scope, even while other users are mid-call', async () => {
    const [scoped, unscoped] = await Promise.all([
      runWith({ userId: 'user-A', sessionId: 'sess-A' }, () => registry.runAppTool('graph_me', {})),
      // Not wrapped in any scope: the resolvers read null.
      registry.runAppTool('graph_me', {}),
    ])

    expect(scoped.success).toBe(true)
    expect(unscoped.success).toBe(false)
    expect(unscoped.error).toMatch(/authenticated user/i)
  })
})

describe('request-scoped conversation', () => {
  // Echoes whatever context runAppTool resolved, after a yield — so a bleed
  // between concurrent conversations shows up as a mismatched sessionId.
  registry.registerAppTool({
    name: 'test_echo_ctx',
    namespace: 'test',
    description: 'echo the resolved app-tool context',
    inputSchema: { type: 'object', properties: {} },
    execute: async (_args, ctx) => {
      await sleep(ctx.sessionId === 'sess-A' ? 20 : 2)
      return { ...ctx }
    },
  })

  it("keeps each conversation's sessionId separate across interleaved calls", async () => {
    const call = (userId: string, sessionId: string) =>
      runWith({ userId, sessionId }, async () => {
        await sleep(1)
        return registry.runAppTool('test_echo_ctx', {})
      })

    const [a, b] = await Promise.all([
      call('user-A', 'sess-A'), // slow — B overtakes it
      call('user-B', 'sess-B'),
    ])

    expect(a.data).toEqual({ userId: 'user-A', sessionId: 'sess-A' })
    expect(b.data).toEqual({ userId: 'user-B', sessionId: 'sess-B' })
  })

  it('a user scope with no session hands the executor sessionId: null', async () => {
    const res = await runWith({ userId: 'user-legacy', sessionId: null }, () =>
      registry.runAppTool('test_echo_ctx', {}),
    )
    expect(res.data).toEqual({ userId: 'user-legacy', sessionId: null })
  })
})

describe('identity is resolved per call, never from args', () => {
  registry.registerAppTool({
    name: 'test_identity_from_resolver',
    namespace: 'test',
    description: 'echo the resolved userId, ignoring any argument',
    inputSchema: { type: 'object', properties: {} },
    execute: async (_args, ctx) => ({ userId: ctx.userId }),
  })

  it('ignores a userId argument entirely — only the resolver counts', async () => {
    const res = await runWith({ userId: 'resolver-user', sessionId: 'sess-1' }, () =>
      registry.runAppTool('test_identity_from_resolver', { userId: 'attacker-oid' }),
    )
    expect(res.data).toEqual({ userId: 'resolver-user' })
  })

  it('a later scope change is visible to the very next call (no caching at registration)', async () => {
    const first = await runWith({ userId: 'first', sessionId: 'sess-1' }, () =>
      registry.runAppTool('test_identity_from_resolver', {}),
    )
    const second = await runWith({ userId: 'second', sessionId: 'sess-1' }, () =>
      registry.runAppTool('test_identity_from_resolver', {}),
    )
    expect(first.data).toEqual({ userId: 'first' })
    expect(second.data).toEqual({ userId: 'second' })
  })
})
