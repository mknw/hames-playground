// @vitest-environment node
/** Layer 1: actual adapter arguments rendered by the generated BAML client.
 * Removing any adapter's turn context or moving the tail before a cache marker
 * reddens its case. No new positional parameter or generated-client drift. */
import { afterEach, expect, it, vi } from 'vitest'
import { b } from '@hames-ai/harness-baml/baml_client'
import {
  createActorControllerAdapter,
  createCriticAdapter,
  createLoopControllerAdapter,
  createPlannerAdapter,
} from '@hames-ai/harness-baml/baml-adapters.server'
import { defaultSynthesize } from '@hames-ai/harness-baml/defaults.server'
import { currentTurnContext } from '@hames-ai/harness-baml/turn-context.server'
import { formatTimeBlock } from '@hames-ai/harness-patterns/clock'
import { formatOrganisationBlock } from '@hames-ai/harness-patterns/organisation'
import { amendRunFrame, withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
const identity = {
  displayName: 'Lumen Orchard Works',
  abbreviations: ['LOW'],
  domains: ['lumen-orchard.example.org'],
}
const block = formatOrganisationBlock(identity)!
const action = { reasoning: 'r', tool_name: 'Return', tool_args: 'done', is_final: true }
const env = {
  LARGE_LLM_BASE_URL: 'https://example.invalid/v1',
  LARGE_LLM_API_KEY: 'offline',
  ANTHROPIC_API_KEY: 'offline',
}
afterEach(() => vi.restoreAllMocks())

it('renders the same identity in controllers, planner, critic and writer after cached prefixes', async () => {
  const loop = vi.spyOn(b, 'LoopController').mockResolvedValue(action)
  const actor = vi.spyOn(b, 'ActorController').mockResolvedValue(action)
  const planner = vi
    .spyOn(b, 'Planner')
    .mockResolvedValue({ reasoning: 'r', plan: 'p', n_steps: 1 })
  const critic = vi
    .spyOn(b, 'Critic')
    .mockResolvedValue({ is_sufficient: true, explanation: 'done' })
  const synth = vi.spyOn(b, 'Synthesize').mockResolvedValue('done')
  await withRunFrame({ organisation: identity, inference: { tier: 'anthropic' } }, async () => {
    // Wrappers must preserve the host's slot.
    await amendRunFrame({ route: 'info-retrieval' }, async () => {
      await createLoopControllerAdapter()({
        userMessage: 'LOW VAT?',
        intent: 'LOW VAT?',
        tools: [],
        turns: [],
        turn: 0,
      })
      await createActorControllerAdapter([])('LOW VAT?', 'LOW VAT?', [], [])
      await createPlannerAdapter([])('LOW VAT?', 'LOW VAT?')
      await createCriticAdapter()('LOW VAT?', [])
      await defaultSynthesize({
        mode: 'response',
        userMessage: 'LOW VAT?',
        intent: 'LOW VAT?',
        response: 'done',
      })
    })
  })
  const replay = <A extends unknown[]>(args: A, client: string, tail = block): A => {
    const copy = [...args] as A
    copy[copy.length - 2] = tail
    copy[copy.length - 1] = { client, env }
    return copy
  }
  const renders = [
    (c: string, t?: string) => b.request.LoopController(...replay(loop.mock.calls[0], c, t)),
    (c: string, t?: string) => b.request.ActorController(...replay(actor.mock.calls[0], c, t)),
    (c: string, t?: string) => b.request.Planner(...replay(planner.mock.calls[0], c, t)),
    (c: string, t?: string) => b.request.Critic(...replay(critic.mock.calls[0], c, t)),
    (c: string, t?: string) => b.request.Synthesize(...replay(synth.mock.calls[0], c, t)),
  ]
  for (const spy of [loop, actor, planner, critic, synth])
    expect(spy.mock.calls[0].at(-2)).toBe(block)
  for (const render of renders) {
    for (const client of ['AnthropicSonnet5', 'LargeQwen']) {
      const body = (await render(client)).body.json() as {
        messages: { role: string; content: string | { text: string; cache_control?: object }[] }[]
      }
      const parts = body.messages.flatMap((m) =>
        (typeof m.content === 'string' ? [{ text: m.content }] : m.content).map((p) => ({
          ...p,
          role: m.role,
        })),
      )
      const at = parts.findIndex((p) => p.text.includes(block))
      expect(at).toBeGreaterThanOrEqual(0)
      expect(parts.filter((p) => p.text.includes(block))).toHaveLength(1)
      expect(parts[at].role).toBe('user')
      expect(at).toBeGreaterThan(parts.findLastIndex((p) => 'cache_control' in p))
      const without = JSON.stringify((await render(client, '')).body.json())
      expect(without).not.toContain('YOUR ORGANISATION')
      for (const p of parts.filter((p) => 'cache_control' in p))
        expect(without).toContain(JSON.stringify(p.text).slice(1, -1))
    }
  }
})

it('keeps existing clock-only and empty tails byte-identical, and isolates frames', async () => {
  expect(currentTurnContext()).toBeNull()
  const clock = { instant: 0, timeZone: 'UTC' }
  await withRunFrame({ clock }, async () =>
    expect(currentTurnContext()).toBe(formatTimeBlock(clock)),
  )
  await withRunFrame({ organisation: identity, clock }, async () => {
    expect(currentTurnContext()).toBe(`${formatTimeBlock(clock)}\n\n${block}`)
    await amendRunFrame({ organisation: null }, async () =>
      expect(currentTurnContext()).toBe(formatTimeBlock(clock)),
    )
    expect(currentTurnContext()).toContain(block)
  })
  expect(currentTurnContext()).toBeNull()
})
