/**
 * THE CONTAINMENT PIN.
 *
 * > Any tool name owned by a transport supplied through `withTransport` is
 * > dispatched there, in innermost-first order, before any process-registered
 * > transport and before the gateway. No value a registrant can pass — and no
 * > registration order — can invert that.
 *
 * Until this file existed the invariant was prose at the top of `dispatchTool`
 * and nothing failed when it was violated: the three sandbox-dispatch cases in
 * `mcp-client.test.ts` covered sandbox-vs-gateway and outside-a-scope, and NO
 * test used a colliding tool name against an app-side tool. Swapping the two
 * dispatch phases was green.
 *
 * Every case below therefore uses ONE name owned by two transports at once, and
 * asserts WHICH one ran. `read_file` is real on both sides of the collision it
 * models (the gateway's filesystem server and the in-VM native map,
 * `sandbox/types.ts`); `sandbox_bash` is owned by every sandbox, which is why
 * nesting has to shadow rather than union.
 *
 * Mutations that turn these red are recorded in the PR body; the guard is only
 * a guard if it has been watched to fail.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@hames/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const mockConnect = vi.fn()
const mockClose = vi.fn()
const mockCallTool = vi.fn()
const mockListTools = vi.fn()

class MockClient {
  connect = mockConnect
  close = mockClose
  callTool = mockCallTool
  listTools = mockListTools
}

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: MockClient }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}))

type Seam = typeof import('@hames/harness-patterns/tool-transport.server')
type Transport = Seam['activeTransports'] extends () => readonly (infer T)[] ? T : never

/**
 * The SCOPED half of the seam is the run frame's `transports` slot since #374 —
 * supplied when the frame is opened, prepended below it by `amendRunFrame`
 * (which is what `withSandbox` now does). Bound here so every precedence
 * assertion below stays exactly as it was: what moved is where the transport is
 * put, not the order dispatch consults.
 */
async function withTransport<T>(transport: Transport, fn: () => Promise<T>): Promise<T> {
  const { withRunFrame, amendRunFrame, currentRunFrame } =
    await import('@hames/harness-patterns/run-frame.server')
  return currentRunFrame()
    ? amendRunFrame({ transports: [transport] }, fn)
    : withRunFrame({ transports: [transport] }, fn)
}

/** A transport that records every call it is handed. */
function spyTransport(id: string, owns: string[]) {
  const calls: string[] = []
  const transport: Transport = {
    id,
    ownsTool: (name: string) => owns.includes(name),
    callTool: async (name: string) => {
      calls.push(name)
      return { success: true, data: `from:${id}` }
    },
    listTools: async () => [],
  }
  return { transport, calls }
}

describe('tool dispatch precedence', () => {
  let callTool: typeof import('@hames/harness-patterns/mcp-client.server').callTool
  let seam: Seam
  const cleanups: (() => void)[] = []

  beforeEach(async () => {
    vi.clearAllMocks()
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockResolvedValue(undefined)
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: '"from:gateway"' }] })
    mockListTools.mockResolvedValue({ tools: [] })
    ;({ callTool } = await import('@hames/harness-patterns/mcp-client.server'))
    seam = await import('@hames/harness-patterns/tool-transport.server')
  })

  afterEach(async () => {
    for (const off of cleanups.splice(0)) off()
    vi.resetModules()
  })

  /** Register a process transport and schedule its removal. */
  function register(t: Transport) {
    cleanups.push(seam.registerTransport(t))
  }

  it('dispatches a colliding name to the SCOPED transport, not the process one', async () => {
    const scoped = spyTransport('scoped', ['read_file'])
    const process = spyTransport('process', ['read_file'])
    register(process.transport)

    const result = await withTransport(scoped.transport, () => callTool('read_file', { p: 1 }))

    expect(result).toEqual({ success: true, data: 'from:scoped' })
    expect(scoped.calls).toEqual(['read_file'])
    expect(process.calls).toEqual([])
    expect(mockCallTool).not.toHaveBeenCalled()
  })

  it('cannot be inverted by registering the process transport LAST', async () => {
    // Registration order is the only lever a registrant has — there is no rank
    // argument — so this is the whole of "no registration order can invert it".
    const scoped = spyTransport('scoped', ['read_file'])
    const early = spyTransport('process-early', ['read_file'])
    const late = spyTransport('process-late', ['read_file'])

    register(early.transport)
    const result = await withTransport(scoped.transport, async () => {
      // Registered from INSIDE the scope, and last: still after every scoped one.
      register(late.transport)
      return callTool('read_file', {})
    })

    expect(result).toEqual({ success: true, data: 'from:scoped' })
    expect(early.calls).toEqual([])
    expect(late.calls).toEqual([])
  })

  it('resolves two process transports owning one name in registration order', async () => {
    // Stated so the behaviour is characterised rather than discovered: among
    // PROCESS transports, first registered wins. That is a tie-break inside one
    // phase and never crosses the scoped/process boundary above.
    const first = spyTransport('p-first', ['read_file'])
    const second = spyTransport('p-second', ['read_file'])
    register(first.transport)
    register(second.transport)

    await callTool('read_file', {})

    expect(first.calls).toEqual(['read_file'])
    expect(second.calls).toEqual([])
  })

  it('dispatches to the scoped transport rather than the gateway', async () => {
    const scoped = spyTransport('scoped', ['sandbox_bash'])

    const result = await withTransport(scoped.transport, () =>
      callTool('sandbox_bash', { cmd: 'echo hi' }),
    )

    expect(result).toEqual({ success: true, data: 'from:scoped' })
    expect(mockCallTool).not.toHaveBeenCalled()
  })

  it('dispatches to a process transport rather than the gateway, outside any scope', async () => {
    const process = spyTransport('process', ['graph_me'])
    register(process.transport)

    const result = await callTool('graph_me', {})

    expect(result).toEqual({ success: true, data: 'from:process' })
    expect(mockCallTool).not.toHaveBeenCalled()
  })

  it('falls through to the gateway for a name no transport owns', async () => {
    const scoped = spyTransport('scoped', ['sandbox_bash'])
    const process = spyTransport('process', ['graph_me'])
    register(process.transport)

    const result = await withTransport(scoped.transport, () => callTool('read_neo4j_cypher', {}))

    expect(result).toEqual({ success: true, data: 'from:gateway' })
    expect(scoped.calls).toEqual([])
    expect(process.calls).toEqual([])
    expect(mockCallTool).toHaveBeenCalledOnce()
  })

  describe('nesting shadows — and that is deliberately not the injection guard rule', () => {
    it('gives a name both scopes own to the INNERMOST one', async () => {
      // Two nested sandboxes both own `sandbox_bash` and a union has no answer
      // to "which machine", so the seam shadows where `withInjectionGuard`
      // unions (SD-5). Do not reconcile the two.
      const outer = spyTransport('outer', ['sandbox_bash'])
      const inner = spyTransport('inner', ['sandbox_bash'])

      const result = await withTransport(outer.transport, () =>
        withTransport(inner.transport, () => callTool('sandbox_bash', {})),
      )

      expect(result).toEqual({ success: true, data: 'from:inner' })
      expect(inner.calls).toEqual(['sandbox_bash'])
      expect(outer.calls).toEqual([])
    })

    it('restores the outer scope once the inner one exits', async () => {
      const outer = spyTransport('outer', ['sandbox_bash'])
      const inner = spyTransport('inner', ['sandbox_bash'])

      await withTransport(outer.transport, async () => {
        await withTransport(inner.transport, () => callTool('sandbox_bash', {}))
        await callTool('sandbox_bash', {})
      })

      expect(inner.calls).toEqual(['sandbox_bash'])
      expect(outer.calls).toEqual(['sandbox_bash'])
    })

    it('reaches an OUTER scope for a name the inner one does not own', async () => {
      // The one behaviour change this seam made against `sandbox/scope.server.ts`,
      // pinned so it is a decision rather than a side effect. The old single-slot
      // scope hid the outer transport entirely, so this call went to the GATEWAY
      // — a name owned by a sandbox escaping to the host. Innermost-FIRST (not
      // innermost-only) contains it.
      const outer = spyTransport('outer', ['sandbox_bash', 'sandbox_read'])
      const inner = spyTransport('inner', ['sandbox_bash'])

      const result = await withTransport(outer.transport, () =>
        withTransport(inner.transport, () => callTool('sandbox_read', {})),
      )

      expect(result).toEqual({ success: true, data: 'from:outer' })
      expect(outer.calls).toEqual(['sandbox_read'])
      expect(mockCallTool).not.toHaveBeenCalled()
    })
  })

  describe('the tool catalog follows the same split', () => {
    it('advertises process transports alongside the gateway', async () => {
      const { listTools } = await import('@hames/harness-patterns/mcp-client.server')
      mockListTools.mockResolvedValue({
        tools: [{ name: 'gateway_tool', description: 'g', inputSchema: {} }],
      })
      const process = spyTransport('process', ['graph_me'])
      process.transport.listTools = async () => [
        { name: 'graph_me', description: 'who am i', inputSchema: {} },
      ]
      register(process.transport)

      const names = (await listTools()).map((t) => t.name)

      expect(names).toContain('gateway_tool')
      expect(names).toContain('graph_me')
    })

    it('keeps the catalog when one process transport cannot list its tools', async () => {
      // Fail-open per transport, on purpose: an empty catalog makes the caller
      // answer as if it had no tools. The failure is logged, not swallowed.
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      const broken = spyTransport('broken', [])
      broken.transport.listTools = async () => {
        throw new Error('nope')
      }
      const healthy = spyTransport('healthy', [])
      healthy.transport.listTools = async () => [
        { name: 'still_here', description: '', inputSchema: {} },
      ]
      register(broken.transport)
      register(healthy.transport)

      const { listTools } = await import('@hames/harness-patterns/mcp-client.server')
      const names = (await listTools()).map((t) => t.name)

      expect(names).toContain('still_here')
      expect(err).toHaveBeenCalledWith(
        expect.stringContaining('broken'),
        expect.stringContaining('nope'),
      )
      err.mockRestore()
    })

    it('does NOT advertise scoped transports — they are per-run, the catalog is per-session', async () => {
      const { listTools } = await import('@hames/harness-patterns/mcp-client.server')
      mockListTools.mockResolvedValue({ tools: [] })
      const scoped = spyTransport('scoped', ['sandbox_bash'])
      scoped.transport.listTools = async () => [
        { name: 'sandbox_bash', description: '', inputSchema: {} },
      ]

      const names = await withTransport(scoped.transport, async () =>
        (await listTools()).map((t) => t.name),
      )

      // `Tools()` caches once per session, so a per-run transport could never be
      // in it consistently. The model is shown these through the adapters'
      // per-call tool list instead (`baml-adapters.server.ts`).
      expect(names).not.toContain('sandbox_bash')
    })
  })
})
