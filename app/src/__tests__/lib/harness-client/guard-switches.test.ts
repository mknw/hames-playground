// @vitest-environment node
// The composition root's GUARD_* wiring (boundary guards, slice 6): what
// `agentDeps()` builds from the switches, and what `general-next` does with it.
//
// The app-side pin here is the seam one: the design's switch surface is
// `AgentDeps.guards`, built from the env once and handed to every agent
// factory — if a refactor ever made the overlay build a second bag or read the
// env again inside a factory, the switches would stop reaching the guards with
// nothing erroring (the same silent-loss class `agent-deps-seam.test.ts`
// pins for the whole bag).
//
// The agent-side pins live beside `general-next`'s other composition pins
// (`agents/general-next.test.ts`): they drive REAL turns against the REAL
// guard modules with only inference scripted, so a switch value is seen
// reaching a guard call, not only a config object.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const loadConversation = vi.fn(async () => null)
vi.mock('../../../lib/stash/release.server', () => ({ releaseDeletedSessions: vi.fn() }))
vi.mock('../../../lib/db/conversations.server', () => ({
  loadConversation,
  claimConversation: vi.fn(async () => null),
  saveConversation: vi.fn(async () => 'v-saved'),
  deleteConversations: vi.fn(async (ids: string[]) => ids),
  restoreConversationPaused: vi.fn(async () => true),
  updateConversationTitle: vi.fn(async () => true),
  deriveTitle: (s: string) => (s ? s.slice(0, 12) : null),
}))
vi.mock('../../../lib/harness-client/registry.server', () => ({
  getAgent: vi.fn((id: string) => (id === 'known' ? { id, createPatterns: vi.fn() } : undefined)),
  canonicalAgentId: vi.fn((id: string) => id),
}))
// The web-pseudonymiser builds a real directory-backed roster; the switch pin
// must not depend on one. The factory identity is what the OFF test pins.
vi.mock('../../../lib/harness-client/web-pseudonymiser.server', () => ({
  createWebPseudonymiser: vi.fn(() => ({ SYNTHETIC_FILTER: true })),
  createEgressRoster: vi.fn(() => ({ SYNTHETIC_ROSTER: true })),
}))
vi.mock('../../../lib/memory/config.server', () => ({
  createHostMemoryConfig: vi.fn(() => ({ SYNTHETIC_MEMORY: true })),
}))
vi.mock('../org-graph/roster-source.server', () => ({ loadDirectoryRoster: vi.fn() }))
// The gateway's tool list, for the composition chain below: general-next asks
// it once per build. Only the info route's web tools matter here.
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = vi.fn()
    close = vi.fn()
    listTools = vi.fn(async () => ({
      tools: ['search', 'fetch'].map((name) => ({ name, inputSchema: {} })),
    }))
    callTool = vi.fn()
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}))

const { agentDeps } = await import('../../../lib/harness-client/session.server')
const { guardConfig } = await import('../../../lib/inference/guard-config.server')
const { generalNextAgent } = await import('@hames-ai/agents/agents/general-next.server')
const { harnessPseudonymisesInputs } = await import('@hames-ai/harness-patterns')
const { mcpNamespace } = await import('@hames-ai/connectors/mcp-catalog')

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('GUARD_SCREEN', undefined)
  vi.stubEnv('GUARD_SCREEN_ANTHROPIC', undefined)
  vi.stubEnv('GUARD_EGRESS', undefined)
  vi.stubEnv('GUARD_PSEUDONYMISE', undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('agentDeps() composes the GUARD_* switches (boundary guards slice 6)', () => {
  it('unset, the bag carries the design defaults and the real web filter', () => {
    const { guards, egressRoster } = agentDeps()
    expect(guards).toMatchObject({
      screenMode: { default: 'shadow', anthropic: 'always' },
      egressMode: 'filter',
    })
    expect(guards!.classifyIngress).toBeTypeOf('function')
    expect(guards!.pseudonymiseForWeb).toMatchObject({ SYNTHETIC_FILTER: true })
    expect(egressRoster).toMatchObject({ SYNTHETIC_ROSTER: true })
  })

  // MUTATION: drop the `pseudonymise ? …` branch (build the filter whatever
  // the switch says): the off case here goes red — the bag carries a filter
  // nothing reads, and the wrapper below is still composed with it.
  it('GUARD_PSEUDONYMISE=off omits the web filter from the bag; on builds it', () => {
    vi.stubEnv('GUARD_PSEUDONYMISE', 'off')
    expect(agentDeps().guards!.pseudonymiseForWeb).toBeUndefined()
    vi.stubEnv('GUARD_PSEUDONYMISE', 'on')
    expect(agentDeps().guards!.pseudonymiseForWeb).toMatchObject({ SYNTHETIC_FILTER: true })
  })

  it('the switch values in the bag are the ones guardConfig() parses', () => {
    vi.stubEnv('GUARD_SCREEN', 'off')
    vi.stubEnv('GUARD_SCREEN_ANTHROPIC', 'off')
    vi.stubEnv('GUARD_EGRESS', 'roster')
    expect(agentDeps().guards).toMatchObject({
      screenMode: { default: 'off', anthropic: 'off' },
      egressMode: 'roster',
    })
    expect(guardConfig().screenMode).toMatchObject({ default: 'off', anthropic: 'off' })
  })
})

// Boundary guards slice 5, owner ruling (c) of 2026-10-28: K5 stays, switchable
// and ON by default, until a fix for the egress gate's measured gap has itself
// been measured; `off` is the retirement switch. The chain from the env var
// through the REAL bag to the REAL agent's composition, so neither half can
// drift alone. What each composition does in a turn is pinned beside
// general-next's other composition pins (`agents/general-next.test.ts`).
describe('GUARD_PSEUDONYMISE reaches general-next through agentDeps() (boundary guards slice 5)', () => {
  const compose = async () => {
    const { guards, egressRoster } = agentDeps()
    const patterns = await generalNextAgent.createPatterns('synthetic-session', {
      toolNamespaces: mcpNamespace,
      withSandbox: () => (pattern) => pattern,
      createRedisBackend: () => ({ name: 'redis', type: 'vector', search: async () => [] }),
      guards,
      egressRoster,
    })
    return { root: patterns[0].name, pseudonymises: harnessPseudonymisesInputs(patterns) }
  }

  // MUTATION: flip the declared default to off (`PSEUDONYMISE_DEFAULT = false`
  // in guard-config.server.ts): the unset case composes no wrapper, red.
  it.each([undefined, 'on'])(
    'GUARD_PSEUDONYMISE=%j: the info route is wrapped in withPseudonymisedInputs',
    async (value) => {
      vi.stubEnv('GUARD_PSEUDONYMISE', value)
      expect(await compose()).toEqual({
        root: 'withInjectionGuard(withEgressGate(decisionLoop))',
        pseudonymises: true,
      })
    },
  )

  // MUTATION: ignore the switch (build `pseudonymiseForWeb` in agentDeps()
  // whatever guardConfig() says, or parse `off` as on): the wrapper is
  // composed, red. The egress gate is composed either way.
  it('GUARD_PSEUDONYMISE=off: no withPseudonymisedInputs anywhere, and the egress gate still wraps every route', async () => {
    vi.stubEnv('GUARD_PSEUDONYMISE', 'off')
    expect(await compose()).toEqual({
      root: 'withInjectionGuard(withEgressGate(decisionLoop))',
      pseudonymises: false,
    })
  })
})
