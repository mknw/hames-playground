// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { harness } from '@hames-ai/harness-patterns/harness.server'
import { decisionLoop } from '@hames-ai/harness-patterns/patterns/decisionLoop.server'
import { simpleLoop } from '@hames-ai/harness-patterns/patterns/simpleLoop.server'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import { formatOrganisationBlock } from '@hames-ai/harness-patterns/organisation'
import type { DecideFn } from '@hames-ai/harness-patterns/types'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
const identity = {
  displayName: 'Lumen Orchard Works',
  abbreviations: ['LOW'],
  domains: ['lumen-orchard.example.org'],
}

it('reads per run, preserves the identity across iterations and exposes it to state overrides', async () => {
  const states: string[] = []
  const decide = Object.assign(
    (async ({ spec, state }) => {
      if (!('labels' in spec)) throw new Error('Expected choice')
      states.push(state)
      const chosen = states.length % 2 ? 'lookup' : 'answer'
      return {
        probs: Object.fromEntries(spec.labels.map((l) => [l.id, l.id === chosen ? 1 : 0])),
        method: 'jev',
      }
    }) as DecideFn,
    { supportedTypes: ['choice'], limits: () => ({ contextWindow: 131072 }) },
  )
  const lookup = simpleLoop<Record<string, unknown>>(
    async () => ({
      action: { reasoning: 'done', tool_name: 'Return', tool_args: 'No match', is_final: true },
    }),
    [],
    { patternId: 'lookup' },
  )
  const make = (override = false) =>
    harness(
      decisionLoop(
        { lookup: { pattern: lookup, description: 'Lookup' } },
        {
          decide,
          answer: 'Answer',
          patternId: 'orchestrator',
          ...(override
            ? { state: (input: { organisation?: string }) => input.organisation ?? 'unknown' }
            : {}),
        },
      ),
    )
  // Build outside the frame: cached patterns must not capture the first user.
  const run = make()
  await withRunFrame({ organisation: identity }, () => run('LOW VAT?'))
  expect(states).toHaveLength(2)
  for (const state of states) expect(state).toContain(formatOrganisationBlock(identity))
  await withRunFrame({}, () => run('Another question'))
  expect(states[2]).not.toContain('YOUR ORGANISATION')
  const unknown = await withRunFrame({ organisation: null }, () => run('Our company?'))
  expect(unknown.context.events).toContainEqual(
    expect.objectContaining({
      type: 'warning',
      data: expect.objectContaining({
        task: 'organisation',
        message: expect.stringContaining('Organisation unknown'),
      }),
    }),
  )
  await withRunFrame({ organisation: identity }, () => make(true)('LOW VAT?'))
  expect(states.at(-1)).toBe(formatOrganisationBlock(identity))
})
