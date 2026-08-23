/**
 * config.server — getCodeModeAllowedTools usesCodeMode gate source.
 *
 * The Tools panel greys out for agents that don't run a code-mode pattern. To
 * make that track the LIVE agent selection (not lag a turn behind the persisted
 * session), getCodeModeAllowedTools takes an optional selectedAgentId and gates
 * on it, preferring it over the persisted agent. Mocks the registry's
 * agentUsesCodeMode (no real pattern build / gateway call).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const agentUsesCodeMode = vi.fn(async () => false)
vi.mock('../../../lib/harness-client/registry.server', () => ({ agentUsesCodeMode }))

const loadSession = vi.fn()
const saveSession = vi.fn()
vi.mock('../../../lib/harness-client/session.server', () => ({
  loadSession,
  saveSession,
}))

const listTools = vi.fn(async () => [{ name: 'read_neo4j_cypher' }])
vi.mock('../../../lib/harness-patterns/mcp-client.server', () => ({ listTools }))

const deserializeContext = vi.fn(() => ({ data: {} }) as { data?: Record<string, unknown> })
const serializeContext = vi.fn(() => '{}')
vi.mock('../../../lib/harness-patterns', () => ({ deserializeContext, serializeContext }))

const getAuthenticatedUser = vi.fn(async () => ({ id: 'u1' }))
vi.mock('../../../lib/auth/server', () => ({ getAuthenticatedUser }))

const getPresetTools = vi.fn(async () => ['read_neo4j_cypher'])
vi.mock('../../../lib/tool-config/server-catalog.server', () => ({ getPresetTools }))

describe('getCodeModeAllowedTools — usesCodeMode gate source', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    agentUsesCodeMode.mockResolvedValue(false)
  })

  it('prefers the client-selected agent over the persisted one', async () => {
    // Persisted as code-mode, but the user has switched the live selection to default.
    loadSession.mockResolvedValue({ serializedContext: '{}', agentId: 'code-mode' })
    const { getCodeModeAllowedTools } = await import('../../../lib/tool-config/config.server')

    const res = await getCodeModeAllowedTools('s1', 'default')

    expect(agentUsesCodeMode).toHaveBeenCalledWith('default', 's1')
    expect(res.usesCodeMode).toBe(false)
  })

  it('falls back to the persisted agent when no selection is passed', async () => {
    loadSession.mockResolvedValue({ serializedContext: '{}', agentId: 'code-mode' })
    agentUsesCodeMode.mockResolvedValue(true)
    const { getCodeModeAllowedTools } = await import('../../../lib/tool-config/config.server')

    const res = await getCodeModeAllowedTools('s1')

    expect(agentUsesCodeMode).toHaveBeenCalledWith('code-mode', 's1')
    expect(res.usesCodeMode).toBe(true)
  })

  it('stays optimistic (true) when neither selection nor session is known', async () => {
    loadSession.mockResolvedValue(null)
    const { getCodeModeAllowedTools } = await import('../../../lib/tool-config/config.server')

    const res = await getCodeModeAllowedTools('s1')

    expect(agentUsesCodeMode).not.toHaveBeenCalled()
    expect(res.usesCodeMode).toBe(true)
  })
})

describe('getCodeModeAllowedTools — the allowed set', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    agentUsesCodeMode.mockResolvedValue(true)
    deserializeContext.mockReturnValue({ data: {} })
    getPresetTools.mockResolvedValue(['read_neo4j_cypher'])
    listTools.mockResolvedValue([{ name: 'read_neo4j_cypher' }])
  })

  it('returns the persisted selection verbatim when the conversation has one', async () => {
    loadSession.mockResolvedValue({ serializedContext: '{}', agentId: 'code-mode' })
    deserializeContext.mockReturnValue({ data: { codeModeAllowedTools: ['search'] } })
    const { getCodeModeAllowedTools } = await import('../../../lib/tool-config/config.server')

    const res = await getCodeModeAllowedTools('s1')

    // Persisted wins outright — no union with the preset or the meta-tools.
    expect(res.allowed).toEqual(['search'])
  })

  it('falls back to meta-tools ∪ preset tools for a fresh conversation', async () => {
    loadSession.mockResolvedValue(null)
    getPresetTools.mockResolvedValue(['read_neo4j_cypher', 'mcp-find'])
    const { getCodeModeAllowedTools } = await import('../../../lib/tool-config/config.server')

    const res = await getCodeModeAllowedTools('s1')

    expect(res.allowed).toContain('read_neo4j_cypher')
    expect(res.defaults).toEqual(['mcp-find', 'mcp-add', 'code-mode', 'mcp-exec'])
    for (const meta of res.defaults) expect(res.allowed).toContain(meta)
    // Deduped — mcp-find appears in both the defaults and the preset.
    expect(res.allowed.filter((t) => t === 'mcp-find')).toHaveLength(1)
  })

  // sf-L2: the panel then renders the DEFAULT selection as if it were the
  // user's, and saving from that state silently replaces what they had picked.
  // Nothing is recoverable here, but the substitution is no longer invisible.
  it('falls back to defaults when the persisted blob is corrupt, and logs it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    loadSession.mockResolvedValue({ serializedContext: 'not-json', agentId: 'code-mode' })
    deserializeContext.mockImplementation(() => {
      throw new Error('corrupt blob')
    })
    const { getCodeModeAllowedTools } = await import('../../../lib/tool-config/config.server')

    const res = await getCodeModeAllowedTools('s1')

    expect(res.allowed).toContain('mcp-exec')
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('unreadable context blob'),
      'corrupt blob',
    )
    // The session is named, so the affected conversation is identifiable.
    expect(err.mock.calls[0][0]).toContain('s1')
    deserializeContext.mockImplementation(() => ({ data: {} }))
    err.mockRestore()
  })

  it('still answers when the preset lookup fails (gateway/catalog down), and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    loadSession.mockResolvedValue(null)
    getPresetTools.mockRejectedValue(new Error('gateway down'))
    const { getCodeModeAllowedTools } = await import('../../../lib/tool-config/config.server')

    const res = await getCodeModeAllowedTools('s1')

    expect(res.allowed).toEqual(['mcp-find', 'mcp-add', 'code-mode', 'mcp-exec'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('meta-tools only'), 'gateway down')
    warn.mockRestore()
  })

  it('reports the live gateway tools, sorted', async () => {
    loadSession.mockResolvedValue(null)
    listTools.mockResolvedValue([{ name: 'search' }, { name: 'fetch' }, { name: 'code-mode' }])
    const { getCodeModeAllowedTools } = await import('../../../lib/tool-config/config.server')

    const res = await getCodeModeAllowedTools('s1')

    expect(res.available).toEqual(['code-mode', 'fetch', 'search'])
  })

  it('skips the auth round-trip under the dev bypass', async () => {
    vi.stubEnv('VITE_DEV_BYPASS_AUTH', 'true')
    loadSession.mockResolvedValue(null)
    const { getCodeModeAllowedTools } = await import('../../../lib/tool-config/config.server')

    await getCodeModeAllowedTools('s1')

    expect(getAuthenticatedUser).not.toHaveBeenCalled()
    expect(loadSession).toHaveBeenCalledWith('s1', 'dev-bypass-user')
    vi.unstubAllEnvs()
  })

  // #226 C1: this module's bypass used to check VITE_DEV_BYPASS_AUTH inline,
  // without the import.meta.env.DEV conjunct that lib/auth/dev-bypass.ts
  // enforces — so a production build with the var still set silently returned
  // the bypass user. Pin the gated behavior.
  it('does NOT bypass in a production build even with VITE_DEV_BYPASS_AUTH=true', async () => {
    const env = import.meta.env as Record<string, unknown>
    const originalDev = env.DEV
    env.DEV = false
    vi.stubEnv('VITE_DEV_BYPASS_AUTH', 'true')
    loadSession.mockResolvedValue(null)
    const { getCodeModeAllowedTools } = await import('../../../lib/tool-config/config.server')

    await getCodeModeAllowedTools('s1')

    expect(getAuthenticatedUser).toHaveBeenCalled()
    expect(loadSession).toHaveBeenCalledWith('s1', 'u1')
    env.DEV = originalDev
    vi.unstubAllEnvs()
  })
})

describe('setCodeModeAllowedTools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deserializeContext.mockReturnValue({ data: {} })
  })

  it('persists a copy of the selection onto the session context', async () => {
    loadSession.mockResolvedValue({ serializedContext: '{}', agentId: 'code-mode' })
    const ctx: { data?: Record<string, unknown> } = { data: { existing: 1 } }
    deserializeContext.mockReturnValue(ctx)
    const { setCodeModeAllowedTools } = await import('../../../lib/tool-config/config.server')

    const selection = ['search', 'fetch']
    await setCodeModeAllowedTools('s1', selection)

    // Other context data survives; the array is copied, not aliased.
    expect(ctx.data).toEqual({ existing: 1, codeModeAllowedTools: ['search', 'fetch'] })
    expect(ctx.data!.codeModeAllowedTools).not.toBe(selection)
    expect(serializeContext).toHaveBeenCalledWith(ctx)
    expect(saveSession).toHaveBeenCalledWith('s1', 'u1', 'code-mode', '{}')
  })

  it('rejects for a conversation that has no row yet', async () => {
    loadSession.mockResolvedValue(null)
    const { setCodeModeAllowedTools } = await import('../../../lib/tool-config/config.server')

    await expect(setCodeModeAllowedTools('ghost', ['search'])).rejects.toThrow(
      /unknown session ghost/,
    )
    expect(saveSession).not.toHaveBeenCalled()
  })
})

describe('getAvailableTools', () => {
  it('returns the gateway tool names sorted', async () => {
    vi.clearAllMocks()
    listTools.mockResolvedValue([{ name: 'search' }, { name: 'add_observations' }])
    const { getAvailableTools } = await import('../../../lib/tool-config/config.server')

    await expect(getAvailableTools()).resolves.toEqual(['add_observations', 'search'])
  })
})
