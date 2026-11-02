/** Independent slice-13 review evidence; synthetic seams, no external requests. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createContext, createScope, serializeContext, deserializeContext } from '../context.server'
import { configurePattern } from '../patterns/chain.server'
import { createEventView } from '../patterns/event-view.server'
import { withEgressGate, type EgressGateConfig } from '../patterns/withEgressGate.server'
import { EGRESS_TEXTS } from '../egress-gate.server'
import { callTool } from '../mcp-client.server'
import { markDegradedToolSurface } from '../gateway-health.server'
import { registerEffectiveTier, withRunFrame, type RunFrame } from '../run-frame.server'
import type { ContextEvent, DecideFn, DecisionMadeEventData, WarningEventData } from '../types'

const sent = vi.fn(async () => ({ success: true, data: 'synthetic result' }))
const transport = { id: 'review', ownsTool: () => true, callTool: sent, listTools: async () => [] }
const publicAnswer = {
  probs: { personal: 0, company: 0, nothing_private: 1 },
  method: 'jev' as const,
  calibrated: false,
}
function decideSeam(body: () => Promise<typeof publicAnswer> = async () => publicAnswer) {
  return Object.assign(vi.fn(body), { supportedTypes: ['choice'] as const }) as DecideFn &
    ReturnType<typeof vi.fn>
}
async function run(
  config: Partial<EgressGateConfig>,
  body: () => Promise<void>,
  prior: ContextEvent[] = [],
  frame: RunFrame = {},
) {
  const ctx = createContext('Find public news')
  ctx.events.push(...prior)
  const scope = createScope('review', {})
  const probe = configurePattern(
    'review',
    async (s) => {
      await body()
      return s
    },
    { patternId: 'review' },
  )
  const gated = withEgressGate({ local: [], catalog: ['web_search'], ...config })(probe)
  await withRunFrame({ transports: [transport], ...frame }, () =>
    gated.fn(scope, createEventView(ctx)),
  )
  return scope.events
}
const decisions = (events: ContextEvent[]) =>
  events.filter((e) => e.type === 'decision_made').map((e) => e.data as DecisionMadeEventData)
beforeEach(() => {
  sent.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  registerEffectiveTier(undefined)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// MUTATION: replace effectiveTier() with the raw inference slot.
it.each([undefined, ''])(
  'S1 defaulted Anthropic veto sends no shadow request (slot=%s)',
  async (tier) => {
    registerEffectiveTier(() => 'anthropic')
    const decide = decideSeam()
    const events = await run(
      {
        detectors: { default: { nameMatch: 'refuse', decide: 'shadow' } },
        decide,
        roster: async () => ({
          directory: 'loaded',
          roster: { match: () => ['Synthetic Person'], observe: () => {} },
        }),
      },
      async () => {
        expect((await callTool('web_search', { query: 'Synthetic Person' })).error).toBe(
          EGRESS_TEXTS.roster,
        )
      },
      [],
      { inference: { tier } },
    )
    expect(sent).not.toHaveBeenCalled()
    expect(decide).not.toHaveBeenCalled()
    expect(decisions(events)).toEqual([
      expect.objectContaining({ shadow: true, abstained: true, skipReason: 'anthropic-veto' }),
    ])
  },
)

// MUTATION: replace serial budgeted drain with a single shift (per-turn cap).
it('S2 two fast shadow questions produce serial verdicts while budget remains', async () => {
  vi.useFakeTimers()
  let inFlight = 0
  let maximum = 0
  const transportCounts: number[] = []
  const decide = decideSeam(async () => {
    transportCounts.push(sent.mock.calls.length)
    maximum = Math.max(maximum, ++inFlight)
    await new Promise((r) => setTimeout(r, 1))
    inFlight--
    return publicAnswer
  })
  const running = run(
    { timeoutMs: 100, detectors: { default: { nameMatch: 'off', decide: 'shadow' } }, decide },
    async () => {
      for (let n = 0; n < 2; n++)
        expect((await callTool('web_search', { query: `public ${n}` })).success).toBe(true)
    },
  )
  await vi.runAllTimersAsync()
  const events = await running
  expect(maximum).toBe(1)
  expect(transportCounts).toEqual([2, 2])
  expect(decisions(events).filter((d) => !d.abstained)).toHaveLength(2)
  expect(decisions(events).some((d) => d.skipReason === 'queued')).toBe(false)
})

it('S2 slow first shadow exhausts wait budget and leaves the second skipped', async () => {
  vi.useFakeTimers()
  const decide = decideSeam(async () => new Promise(() => {}))
  const running = run(
    { timeoutMs: 100, detectors: { default: { nameMatch: 'off', decide: 'shadow' } }, decide },
    async () => {
      for (let n = 0; n < 2; n++)
        expect((await callTool('web_search', { query: `public ${n}` })).success).toBe(true)
    },
  )
  await vi.runAllTimersAsync()
  const events = await running
  expect(decide).toHaveBeenCalledTimes(1)
  expect(decisions(events)).toEqual([
    expect.objectContaining({ shadow: true, abstained: true }),
    expect.objectContaining({ shadow: true, abstained: true, skipReason: 'queued' }),
  ])
})

// MUTATION: reset warning bookkeeping instead of reading persisted turn events.
it('S3 degraded catalog warns once across a resumed invocation of the same turn', async () => {
  const catalog = ['web_search']
  markDegradedToolSurface(catalog)
  const config: Partial<EgressGateConfig> = {
    catalog,
    detectors: { default: { nameMatch: 'off', decide: 'off' } },
  }
  const body = async () => {
    expect((await callTool('unverified_outgoing', { query: 'public' })).success).toBe(false)
  }
  const first = await run(config, body)
  const resumed = await run(config, body, first)
  expect(sent).not.toHaveBeenCalled()
  const warnings = [...first, ...resumed].filter(
    (e) => e.type === 'warning' && (e.data as WarningEventData).task === 'egress_check',
  )
  expect(warnings).toHaveLength(1)
})

// Both timeout and failure use a fixed, metadata-only error abstention.
it.each(['timeout', 'failed'] as const)('S4 shadow %s carries its fixed reason', async (reason) => {
  vi.useFakeTimers()
  const decide = decideSeam(async () => {
    if (reason === 'failed') throw new Error('synthetic failure')
    return new Promise(() => {})
  })
  const running = run(
    { timeoutMs: 100, detectors: { default: { nameMatch: 'off', decide: 'shadow' } }, decide },
    async () => {
      expect((await callTool('web_search', { query: 'public' })).success).toBe(true)
    },
  )
  await vi.runAllTimersAsync()
  expect(decisions(await running)).toEqual([
    expect.objectContaining({ shadow: true, abstained: true, reason: 'error' }),
  ])
})

// MUTATIONS: store state/args, omit shadow flag, run measurement before active work.
it('S5 shadow stores only verdict metadata and waits behind active questions', async () => {
  const order: string[] = []
  const decide = Object.assign(
    vi.fn(async (input: Parameters<DecideFn>[0]) => {
      order.push(input.state.includes('review-shadow-sentinel') ? 'shadow' : 'active')
      return publicAnswer
    }),
    { supportedTypes: ['choice'] as const },
  ) as DecideFn
  const events = await run(
    {
      catalog: ['web_search', 'active_search'],
      decide,
      detectors: {
        default: { nameMatch: 'off', decide: 'on' },
        tools: { web_search: { nameMatch: 'off', decide: 'shadow' } },
      },
    },
    async () => {
      expect((await callTool('web_search', { query: 'review-shadow-sentinel' })).success).toBe(true)
      expect((await callTool('active_search', { query: 'public' })).success).toBe(true)
      expect(order).toEqual(['active'])
    },
  )
  expect(order).toEqual(['active', 'shadow'])
  const shadow = events.filter(
    (e) => e.type === 'decision_made' && (e.data as DecisionMadeEventData).shadow,
  )
  expect(shadow).toHaveLength(1)
  expect(shadow[0].data).toMatchObject({
    shadow: true,
    wouldRefuse: false,
    tool: 'web_search',
    callId: expect.any(String),
  })
  expect(JSON.stringify(shadow)).not.toContain('review-shadow-sentinel')
  const stored = createContext('review persistence')
  stored.events.push(...shadow)
  expect(
    deserializeContext(serializeContext(stored)).events.filter((e) => e.type === 'decision_made'),
  ).toEqual(shadow)
  expect(
    events.filter((e) => ['egress_refused', 'error', 'hitl_request'].includes(e.type)),
  ).toEqual([])
})

it('S6 rejects absent toolTags keys and local tag selectors, and deduplicates equal tag overlaps', () => {
  const off = { nameMatch: 'off', decide: 'off' } as const
  const refused = { nameMatch: 'refuse', decide: 'off' } as const
  expect(() =>
    withEgressGate({
      local: [],
      catalog: ['web_search'],
      toolTags: { absent: ['search'] },
      detectors: { default: off },
    }),
  ).toThrow()
  expect(() =>
    withEgressGate({
      local: [],
      localTools: ['web_search'],
      catalog: ['web_search'],
      toolTags: { web_search: ['search'] },
      detectors: { default: off, tags: { search: refused } },
    }),
  ).toThrow()
  expect(() =>
    withEgressGate({
      local: [],
      catalog: ['web_search'],
      toolTags: { web_search: ['search', 'lookup'] },
      detectors: { default: off, tags: { search: refused, lookup: refused } },
    }),
  ).not.toThrow()
})

// A damaged optional matcher must not become a detector on a both-off tool.
it('S7 roster damage on one selected tool does not block a later nameMatch off tool', async () => {
  const roster = vi.fn(async () => {
    throw new Error('synthetic damaged roster')
  })
  await run(
    {
      catalog: ['web_search', 'off_tool'],
      roster,
      detectors: {
        default: { nameMatch: 'off', decide: 'off' },
        tools: { web_search: { nameMatch: 'refuse', decide: 'off' } },
      },
    },
    async () => {
      expect((await callTool('web_search', { query: 'public' })).success).toBe(false)
      expect((await callTool('off_tool', { query: 'public' })).success).toBe(true)
    },
  )
  expect(roster).toHaveBeenCalledTimes(1)
  expect(sent).toHaveBeenCalledTimes(1)
})

it('S3 real harness pause/resume preserves the once-per-turn degraded warning', async () => {
  const { harness, resumeHarness } = await import('../harness.server')
  const { askHuman, held, readHitl } = await import('../hitl.server')
  const { simpleLoop } = await import('../patterns/simpleLoop.server')
  const catalog = ['web_search']
  markDegradedToolSurface(catalog)
  const script = ['unverified_outgoing', 'local_pause', 'unverified_outgoing', 'Return']
  const controller: import('../types').ControllerFn = async (input) => ({
    action: {
      reasoning: 'review script',
      tool_name: script[input.turn] ?? 'Return',
      tool_args: script[input.turn] === 'Return' ? 'done' : '{"query":"public"}',
      status: 'review',
      is_final: script[input.turn] === 'Return',
    },
  })
  const pattern = withEgressGate({
    local: [],
    localTools: ['local_pause'],
    catalog,
    detectors: { default: { nameMatch: 'off', decide: 'off' } },
  })(
    simpleLoop<Record<string, unknown> & { response?: string }>(
      controller,
      [...script.filter((n) => n !== 'Return')],
      {
        patternId: 'review-resume',
        maxTurns: 6,
      },
    ),
  )
  const frame: RunFrame = {
    transports: [
      {
        ...transport,
        callTool: async (name) => {
          expect(name).toBe('local_pause')
          const outcome = await askHuman({
            kind: 'review-pause',
            question: 'Continue?',
            options: [
              { id: 'yes', label: 'Continue' },
              { id: 'no', label: 'Stop', unattended: true },
            ],
            defaultOption: 'no',
          })
          return { success: true, data: outcome.status === 'pending' ? held(outcome) : 'continued' }
        },
      },
    ],
  }
  const paused = await harness(pattern)(
    'review turn',
    'review-session',
    undefined,
    undefined,
    frame,
  )
  expect(
    paused.status,
    JSON.stringify(paused.context.events.filter((e) => e.type === 'error')),
  ).toBe('paused')
  const pending = readHitl(paused.context).pending
  expect(pending).toHaveLength(1)
  const resumed = await resumeHarness(
    paused.serialized,
    [pattern],
    { [pending[0].requestId]: 'yes' },
    { frame },
  )
  // This probe has no synthesis/final-answer pattern.
  expect(resumed.status).toBe('running')
  expect(readHitl(resumed.context).pending).toHaveLength(0)
  expect(resumed.context.events.filter((e) => e.type === 'error')).toEqual([])
  const warnings = resumed.context.events.filter(
    (e) => e.type === 'warning' && (e.data as WarningEventData).task === 'egress_check',
  )
  expect(warnings).toHaveLength(1)
})

// MUTATIONS: restore a roster fallback; skip Decide for a nonmatch; allow malformed answers.
it.each(
  (['off', 'evidence', 'refuse'] as const).flatMap((nameMatch) =>
    (['loaded', 'empty', 'none', 'unreadable'] as const).flatMap((directory) =>
      (['throw', 'timeout', 'malformed'] as const).map((fault) => ({
        nameMatch,
        directory,
        fault,
      })),
    ),
  ),
)(
  'S8 active outage refuses $nameMatch / $directory / $fault',
  async ({ nameMatch, directory, fault }) => {
    vi.useFakeTimers()
    const decide = decideSeam(async () => {
      if (fault === 'throw') throw new Error('review-exception-sentinel')
      if (fault === 'timeout') return new Promise(() => {})
      return { ...publicAnswer, probs: { personal: NaN, company: 0, nothing_private: 0 } }
    })
    const running = run(
      {
        decide,
        timeoutMs: 100,
        askPerson: true,
        detectors: { default: { nameMatch, decide: 'on' } },
        roster: async () => ({ directory, roster: { match: () => [], observe: () => {} } }),
      },
      async () => {
        expect(await callTool('web_search', { query: 'public' })).toMatchObject({
          success: false,
          error: EGRESS_TEXTS.uncheckedClosing,
        })
      },
    )
    await vi.runAllTimersAsync()
    const events = await running
    expect(sent).not.toHaveBeenCalled()
    expect(events.filter((e) => e.type === 'egress_refused')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'error').map((e) => e.data)).toEqual([
      {
        kind: 'egress_decide_unavailable',
        severity: 'irrecoverable',
        error: 'An outside request was refused because its safety check was unavailable.',
        hint: 'Try again later.',
      },
    ])
    expect(events.some((e) => e.type === 'hitl_request')).toBe(false)
    expect(JSON.stringify(events)).not.toContain('review-exception-sentinel')
  },
)
