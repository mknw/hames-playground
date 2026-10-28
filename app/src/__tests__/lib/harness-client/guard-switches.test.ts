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
// must not depend on one. The factory identities are what the pins read.
vi.mock('../../../lib/harness-client/web-pseudonymiser.server', () => ({
  createWebPseudonymiser: vi.fn(() => ({ SYNTHETIC_FILTER: true })),
  createEgressRoster: vi.fn(() => ({ SYNTHETIC_ROSTER: true })),
}))
vi.mock('../../../lib/memory/config.server', () => ({
  createHostMemoryConfig: vi.fn(() => ({ SYNTHETIC_MEMORY: true })),
}))
vi.mock('../org-graph/roster-source.server', () => ({ loadDirectoryRoster: vi.fn() }))

const { agentDeps } = await import('../../../lib/harness-client/session.server')
const { guardConfig } = await import('../../../lib/inference/guard-config.server')

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
  it('unset, the bag carries the design defaults', () => {
    const { guards, egressRoster } = agentDeps()
    expect(guards).toMatchObject({
      screenMode: { default: 'shadow', anthropic: 'always' },
      egressMode: 'filter',
    })
    expect(guards!.classifyIngress).toBeTypeOf('function')
    expect(egressRoster).toMatchObject({ SYNTHETIC_ROSTER: true })
  })

  // Boundary guards slice 5: the input pseudonymiser left with K5, so the bag
  // never builds one, whatever the retired switch says. MUTATION: restore the
  // `pseudonymiseForWeb: createWebPseudonymiser(…)` entry in agentDeps(): the
  // bag carries a key and the factory is called, red.
  it.each([undefined, 'on', 'off'])(
    'the bag carries no input pseudonymiser, with GUARD_PSEUDONYMISE=%j',
    async (value) => {
      vi.stubEnv('GUARD_PSEUDONYMISE', value)
      const { createWebPseudonymiser } =
        await import('../../../lib/harness-client/web-pseudonymiser.server')
      expect(Object.keys(agentDeps().guards!).sort()).toEqual([
        'classifyIngress',
        'egressMode',
        'screenMode',
      ])
      expect(createWebPseudonymiser).not.toHaveBeenCalled()
    },
  )

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
