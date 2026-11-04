// @vitest-environment node
/**
 * The host half of the org-knowledge hook (slice 4): the deployment switch,
 * the turn's opt-in, and that a turn with the switch off calls nothing.
 *
 * Pin "with the switch off nothing is called" — mutation: ignore the switch
 * (`turnUsesOrgKnowledge` returns the opt-in alone, and the config's
 * `enabled` returns true) → the decision seam is called.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const decide = vi.hoisted(() => vi.fn())
vi.mock('@hames-ai/harness-baml/baml-adapters.server', () => ({
  createDecideAdapter: () => decide,
  createLoopControllerAdapter: () => vi.fn(),
}))
vi.mock('../../../lib/org-graph/member-mentions.server', () => ({
  loadMemberMentions: async () => () => false,
}))
vi.mock('../../../lib/harness-client/request-user.server', () => ({
  getRequestUserId: () => 'user-a',
}))

import { createContext, createEvent } from '@hames-ai/harness-patterns/context.server'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import { withOrgKnowledge } from '@hames-ai/harness-patterns/org-knowledge-hook.server'
import { createMemoryOrgGraphStore } from '@hames-ai/harness-patterns/org-knowledge-store'
import type { ConfiguredPattern } from '@hames-ai/harness-patterns'
import {
  configureOrgGraphStore,
  orgKnowledgeHookEnabled,
  settleTurnOrgKnowledge,
  turnUsesOrgKnowledge,
} from '../../../lib/org-graph/hook.server'
import { ORG_ONTOLOGY } from '../../../lib/org-graph/ontology'

const pattern = {
  name: 'p',
  fn: async (s: unknown) => s,
  config: { patternId: 'p' },
} as unknown as ConfiguredPattern<Record<string, unknown>>

beforeEach(() => {
  decide.mockReset()
  configureOrgGraphStore(createMemoryOrgGraphStore(ORG_ONTOLOGY))
})
afterEach(() => {
  vi.unstubAllEnvs()
  configureOrgGraphStore(undefined)
})

describe('ORG_KNOWLEDGE_HOOK', () => {
  it('is off unless it says on, and refuses anything else', () => {
    expect(orgKnowledgeHookEnabled({})).toBe(false)
    expect(orgKnowledgeHookEnabled({ ORG_KNOWLEDGE_HOOK: '' })).toBe(false)
    expect(orgKnowledgeHookEnabled({ ORG_KNOWLEDGE_HOOK: 'off' })).toBe(false)
    expect(orgKnowledgeHookEnabled({ ORG_KNOWLEDGE_HOOK: 'on' })).toBe(true)
    expect(() => orgKnowledgeHookEnabled({ ORG_KNOWLEDGE_HOOK: 'yes' })).toThrow(
      /must be "on" or "off"/,
    )
  })
})

describe('the turn settles the hook only when opted in and switched on', () => {
  it('needs both the opt-in and the switch', () => {
    vi.stubEnv('ORG_KNOWLEDGE_HOOK', 'on')
    expect(turnUsesOrgKnowledge([pattern])).toBe(false)
    expect(turnUsesOrgKnowledge(withOrgKnowledge()([pattern]))).toBe(true)
    vi.stubEnv('ORG_KNOWLEDGE_HOOK', 'off')
    expect(turnUsesOrgKnowledge(withOrgKnowledge()([pattern]))).toBe(false)
    vi.stubEnv('ORG_KNOWLEDGE_HOOK', 'sometimes')
    expect(turnUsesOrgKnowledge(withOrgKnowledge()([pattern]))).toBe(false)
  })

  // Design pin: with the switch off nothing is called.
  it('with the switch off, a settle calls no model and proposes nothing', async () => {
    vi.stubEnv('ORG_KNOWLEDGE_HOOK', 'off')
    const ctx = createContext("We've started calling the new logistics workstream Project Heron.")
    ctx.events.push(createEvent('assistant_message', 'c', { content: 'Noted.', final: true }))
    const report = await withRunFrame({ inference: { tier: 'self_deployed' } }, () =>
      settleTurnOrgKnowledge(ctx, 'conv-1'),
    )
    expect(report?.skipped).toBe('disabled')
    expect(decide).not.toHaveBeenCalled()
    expect(ctx.events.some((e) => e.type === 'hitl_request')).toBe(false)
  })
})
