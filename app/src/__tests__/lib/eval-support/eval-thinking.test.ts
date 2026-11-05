/** @vitest-environment node */
/** `EVAL_THINKING` (thinking-mode.ts): the option moves only the eval's clients.
 *
 * Proved against the REAL routing seam (`resolveClientForRole` under a real run
 * frame), never a stub: the claim is "the production resolver answers differently
 * for exactly the three twin roles, and only while the eval's mode is entered". */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContextEvent } from '@hames-ai/harness-patterns'
import {
  EVAL_REASONING_PATTERNS,
  REASONING_ROLES_ENV,
  THINKING_ENV,
  THINKING_TWINS,
  enterThinking,
  parseThinking,
  reasoningSummary,
  thinkingComparison,
  thinkingModes,
} from '../../../lib/eval-support/thinking-mode'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

const PRIVATE = {
  LARGE_LLM_BASE_URL: 'https://example.invalid/large/v1',
  LARGE_LLM_API_KEY: 'synthetic-key',
  SMALL_LLM_BASE_URL: 'https://example.invalid/small/v1',
  SMALL_LLM_DECISIONS_URL: 'https://example.invalid/v1/systemone',
  SMALL_LLM_API_KEY: 'synthetic-key',
}

beforeEach(() => {
  for (const [k, v] of Object.entries(PRIVATE)) vi.stubEnv(k, v)
  delete process.env[REASONING_ROLES_ENV]
})
afterEach(() => {
  vi.unstubAllEnvs()
  delete process.env[REASONING_ROLES_ENV]
})

describe('parseThinking', () => {
  it('defaults to off and accepts the three values', () => {
    expect(parseThinking({})).toBe('off')
    expect(parseThinking({ [THINKING_ENV]: '' })).toBe('off')
    expect(parseThinking({ [THINKING_ENV]: 'off' })).toBe('off')
    expect(parseThinking({ [THINKING_ENV]: 'on' })).toBe('on')
    expect(parseThinking({ [THINKING_ENV]: 'compare' })).toBe('compare')
    expect(thinkingModes('off')).toEqual(['off'])
    expect(thinkingModes('on')).toEqual(['on'])
    expect(thinkingModes('compare')).toEqual(['off', 'on'])
  })
  it('refuses an unknown value rather than running some mode', () => {
    expect(() => parseThinking({ [THINKING_ENV]: '1' })).toThrow(/off, on or compare/)
    expect(() => parseThinking({ [THINKING_ENV]: 'ON' })).toThrow(/off, on or compare/)
  })
  // MUTATION: drop the inherited-setting refusal → an `off` row silently runs the
  // operator's twins and this goes red.
  it.each(['off', 'on', 'compare', undefined])(
    'refuses an inherited reasoning setting in every mode (%s)',
    (mode) => {
      expect(() =>
        parseThinking({ [THINKING_ENV]: mode, [REASONING_ROLES_ENV]: 'controller' }),
      ).toThrow(/eval owns that setting/)
      // An empty inherited value is the unset posture, not a conflict.
      expect(() => parseThinking({ [THINKING_ENV]: mode, [REASONING_ROLES_ENV]: '' })).not.toThrow()
    },
  )
})

describe('enterThinking', () => {
  it('restores an absent setting to absent and a present one to its value', () => {
    const env: Record<string, string | undefined> = {}
    const leave = enterThinking('on', env)
    expect(env[REASONING_ROLES_ENV]).toBe('controller,critic,planner')
    leave()
    expect(Object.prototype.hasOwnProperty.call(env, REASONING_ROLES_ENV)).toBe(false)
    const kept: Record<string, string | undefined> = { [REASONING_ROLES_ENV]: '' }
    enterThinking('on', kept)()
    expect(kept).toEqual({ [REASONING_ROLES_ENV]: '' })
    const off: Record<string, string | undefined> = {}
    enterThinking('off', off)
    expect(off[REASONING_ROLES_ENV]).toBe('')
  })
})

describe('the option moves only the eval’s clients', () => {
  async function resolveAll(tier: 'self_deployed' | 'anthropic') {
    const clients = await import('@hames-ai/harness-baml/clients.server')
    const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
    await import('../../../lib/inference/config.server')
    const roles = Object.keys(clients.SELF_DEPLOYED_CLIENT_BY_ROLE) as Array<
      keyof typeof clients.SELF_DEPLOYED_CLIENT_BY_ROLE
    >
    if (tier === 'self_deployed') clients.assertInferenceTier('self_deployed')
    return withRunFrame({ inference: { tier } }, async () =>
      Object.fromEntries(roles.map((r) => [r, clients.resolveClientForRole(r)])),
    )
  }

  // MUTATION: make `reasoningRolesFor('on')` return '' (or drop a pattern) → the
  // `on` map equals the baseline and the first expectation goes red; make
  // `reasoningRolesFor('off')` return the patterns → the `off` map moves.
  it('switches exactly controller, critic and planner on the private tier, then restores', async () => {
    const baseline = await resolveAll('self_deployed')
    const leaveOff = enterThinking('off', process.env)
    const off = await resolveAll('self_deployed')
    leaveOff()
    const leaveOn = enterThinking('on', process.env)
    const on = await resolveAll('self_deployed')
    leaveOn()
    const after = await resolveAll('self_deployed')

    expect(off).toEqual(baseline)
    expect(after).toEqual(baseline)
    const moved = Object.keys(on).filter((r) => on[r] !== baseline[r])
    expect(moved.sort()).toEqual([...EVAL_REASONING_PATTERNS].sort())
    for (const r of moved) {
      expect(baseline[r]).toBe('LargeQwen')
      expect(on[r]).toBe('LargeQwenThink')
    }
    // Every other role — describe, screen, router, synthesizer, decide, orgDraft —
    // answers exactly what production answers.
    for (const r of Object.keys(on).filter((r) => !moved.includes(r)))
      expect(on[r]).toBe(baseline[r])
  })

  it('moves nothing on the Anthropic tier (the twins are private-tier only, G19 Q4)', async () => {
    const baseline = await resolveAll('anthropic')
    const leave = enterThinking('on', process.env)
    const on = await resolveAll('anthropic')
    leave()
    expect(on).toEqual(baseline)
  })

  it('names the package’s own switch, patterns and twins', async () => {
    const roles = await import('@hames-ai/harness-baml/reasoning-roles.server')
    const clients = await import('@hames-ai/harness-baml/clients.server')
    expect(REASONING_ROLES_ENV).toBe(roles.PRIVATE_REASONING_ROLES_ENV)
    const leave = enterThinking('on', process.env)
    try {
      // Every pattern the eval enables has a twin (an unknown or twinless one throws).
      expect([...roles.configuredReasoningPatterns()].sort()).toEqual(
        [...EVAL_REASONING_PATTERNS].sort(),
      )
    } finally {
      leave()
    }
    for (const leaf of clients.THINKING_CLIENTS)
      expect([...clients.THINKING_FUNCTIONS_BY_CLIENT[leaf]].sort()).toEqual(
        [...THINKING_TWINS].sort(),
      )
  })

  // A whole-tree scan of production code: nothing but the eval-support module
  // reads the eval's switch. MUTATION: add `process.env.EVAL_THINKING` to any
  // file under packages/ or app/src/lib → red.
  it('is read by no production module', () => {
    const repo = resolve(__dirname, '../../../../..')
    const roots = [join(repo, 'packages'), join(repo, 'app/src')]
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '__tests__' || name === 'baml_client') continue
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(ts|tsx|js|mjs)$/.test(name)) files.push(path)
      }
    }
    roots.forEach(walk)
    expect(files.length).toBeGreaterThan(200)
    const readers = files
      .filter((f) => readFileSync(f, 'utf8').includes(THINKING_ENV))
      .map((f) => relative(repo, f))
    expect(readers).toEqual(['app/src/lib/eval-support/thinking-mode.ts'])
  })
})

describe('reasoningSummary and the comparison', () => {
  const call = (functionName: string, reasoning?: string) => ({
    functionName,
    variables: {},
    rawOutput: '',
    parsedOutput: reasoning === undefined ? {} : { reasoning },
  })
  it('counts twins, originals and trace length once per call record', () => {
    const shared = call('ControllerThinking', 'x'.repeat(30))
    const events = [
      { type: 'controller_action', llmCall: shared },
      { type: 'tool_call', llmCall: shared },
      { type: 'controller_action', llmCall: call('ActorController', 'abcd') },
      { type: 'critic_result', llmCall: call('CriticThinking', 'y'.repeat(10)) },
      { type: 'synthesize', llmCall: call('Synthesize', 'not counted') },
      { type: 'error', llmCall: call('LoopController') },
    ] as unknown as ContextEvent[]
    const s = reasoningSummary(events)
    expect(s).toMatchObject({ calls: 4, thinkingCalls: 2, chars: 44, maxChars: 30 })
    expect(s.functions.ControllerThinking).toEqual({
      calls: 1,
      thinkingCalls: 1,
      chars: 30,
      maxChars: 30,
    })
    expect(s.functions.Synthesize).toBeUndefined()
  })
  // #981 review MUST: the failed twin of a fallback rides a `warning` event.
  // MUTATION: drop the `event.type === 'warning'` count → fallbacks 0, red; drop the
  // hitOutputCap count → capHits 0, red.
  it('counts a fallback twin attempt carried by a warning, and its cap hit', () => {
    const failed = { ...call('ControllerThinking', 'z'.repeat(50)), hitOutputCap: true }
    const events = [
      { type: 'warning', data: { task: 'controller' }, llmCall: failed },
      { type: 'controller_action', llmCall: call('LoopController', 'abc') },
      { type: 'warning', data: { task: 'title' }, llmCall: call('GenerateConversationTitle') },
    ] as unknown as ContextEvent[]
    expect(reasoningSummary(events)).toMatchObject({
      calls: 2,
      thinkingCalls: 1,
      fallbacks: 1,
      capHits: 1,
      maxChars: 50,
    })
  })
  it('lays out one cell per mode with status, latency, cost and reasoning', () => {
    const reasoning = {
      calls: 2,
      thinkingCalls: 1,
      chars: 7,
      maxChars: 5,
      fallbacks: 1,
      capHits: 1,
      functions: {},
    }
    const table = thinkingComparison(
      ['a', 'b'],
      ['off', 'on'],
      [
        { scenario: 'a', thinking: 'off', status: 'pass', attempt: 1, durationMs: 10, reasoning },
        { scenario: 'a', thinking: 'on', status: 'fail', attempt: 1, durationMs: 40, reasoning },
        { scenario: 'a', thinking: 'on', status: 'pass', attempt: 2, durationMs: 50, reasoning },
        { scenario: 'b', thinking: 'off', status: 'gated' },
      ],
      (_id, statuses) => (statuses.includes('pass') ? 'pass' : 'fail'),
      (id, mode) => (id === 'a' && mode === 'on' ? 0.5 : 0.1),
    )
    expect(table[0]).toEqual({
      scenario: 'a',
      off: {
        status: 'pass',
        attempts: 1,
        durationMs: 10,
        usd: 0.1,
        reasoningChars: 7,
        maxReasoningChars: 5,
        thinkingCalls: 1,
        reasoningCalls: 2,
        fallbacks: 1,
        capHits: 1,
      },
      on: {
        status: 'pass',
        attempts: 2,
        durationMs: 90,
        usd: 0.5,
        reasoningChars: 14,
        maxReasoningChars: 5,
        thinkingCalls: 2,
        reasoningCalls: 4,
        fallbacks: 2,
        capHits: 2,
      },
    })
    expect(table[1]).toMatchObject({ scenario: 'b', off: { status: 'gated', attempts: 0 } })
    expect(table[1].on).toBeUndefined()
  })
})
