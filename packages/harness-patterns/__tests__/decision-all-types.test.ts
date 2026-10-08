import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  decide,
  decideFields,
  defineChoice,
  defineDecisionSet,
  defineNoul,
  defineScore,
  evaluateDecision,
  typedDecision,
  readDecision,
  type DecisionCall,
  type EvaluatedDecision,
  type TypedDecisionConfig,
  type DecideFieldsCall,
  type TypedDecisionData,
  type AnyDecisionSpec,
  type DecideFn,
  type DecideAllFn,
  type DecisionSetSpec,
  type MixedDecisionSet,
  type DecisionSpec,
  type ScoreDecision,
  type NoulDecision,
  type DecisionMadeEventData,
  type DecideResult,
} from '../index'
import { createContext, createScope } from '../context.server'
import { createEventView } from '../patterns/event-view.server'
import { runChain } from '../patterns/chain.server'
import { withRunFrame } from '../run-frame.server'

const SCORE = defineScore({
  key: 'severity',
  question: 'How severe?',
  levels: [
    { id: 'low', description: 'No work blocked.' },
    { id: 'medium', description: 'A workaround exists.' },
    { id: 'high', description: 'Work cannot continue.' },
  ],
})
const NOUL = defineNoul({ key: 'blocked', question: 'Work is blocked.' })
const CHOICE = defineChoice({
  key: 'route',
  question: 'Which route?',
  labels: [
    { id: 'chat', description: 'Answer.' },
    { id: 'search', description: 'Search.' },
  ],
})
const SET = defineDecisionSet({
  key: 'triage',
  fields: { severity: SCORE, blocked: NOUL, route: CHOICE },
})
const POLICY = {
  severity: { fallback: 'high' },
  blocked: { fallback: false },
  route: { fallback: 'chat' },
} as const
const raw = (probs: Record<string, number>, extra?: Partial<DecideResult>) => ({
  probs,
  method: 'logprob' as const,
  calibrated: true,
  ...extra,
})
const ANSWERS = {
  severity: raw({ low: 0, medium: 0.6, high: 0.4 }),
  blocked: raw({ true: 0.9, false: 0.1 }),
  route: raw({ chat: 0.8, search: 0.2 }),
}
function fake(
  supportedTypes: DecideFn['supportedTypes'] = ['choice', 'score', 'noul'],
  answer: (spec: AnyDecisionSpec) => unknown = (s) => ANSWERS[s.key as keyof typeof ANSWERS],
) {
  const calls: AnyDecisionSpec[] = []
  const fn = Object.assign(
    async ({ spec }: { spec: AnyDecisionSpec }) => {
      calls.push(spec)
      return answer(spec)
    },
    supportedTypes ? { supportedTypes } : {},
  ) as DecideFn
  return { fn, calls }
}
const fields = (scope: ReturnType<typeof createScope>, decide: DecideFn, decideAll?: DecideAllFn) =>
  decideFields(scope, { decide, decideAll, set: SET, policy: POLICY, state: 'synthetic state' })

describe('decide-fields-mixed', () => {
  it.each(['per-field', 'one-call'] as const)(
    'keeps types, field events and state metadata on %s',
    async (mode) => {
      const { fn, calls } = fake()
      let allCalls = 0
      const shared = { functionName: 'SyntheticSet', variables: { state: 'synthetic state' } }
      const all = Object.assign(
        async () => {
          allCalls++
          return {
            fields: Object.fromEntries(
              Object.entries(ANSWERS).map(([k, r]) => [k, { ...r, llmCall: shared }]),
            ),
          }
        },
        { supportedTypes: ['choice', 'score', 'noul'] as const },
      ) as DecideAllFn
      const scope = createScope('p', {})
      const out = await fields(scope, fn, mode === 'one-call' ? all : undefined)
      expectTypeOf(out.severity.level).toEqualTypeOf<'low' | 'medium' | 'high'>()
      expectTypeOf(out.blocked.holds).toEqualTypeOf<boolean>()
      expectTypeOf(out.route.label).toEqualTypeOf<'chat' | 'search'>()
      expect(out.severity).toMatchObject({
        type: 'score',
        level: 'medium',
        value: 1,
        expected: 1.4,
      })
      expect(out.blocked).toMatchObject({ type: 'noul', holds: true, pTrue: 0.9 })
      expect(out.route.label).toBe('chat')
      expect(scope.events.map((e) => (e.data as DecisionMadeEventData).type)).toEqual([
        'score',
        'noul',
        undefined,
      ])
      expect(scope.events.map((e) => (e.data as DecisionMadeEventData).key)).toEqual([
        'severity',
        'blocked',
        'route',
      ])
      expect(scope.events.map((e) => (e.data as DecisionMadeEventData).stateChars)).toEqual([
        15, 15, 15,
      ])
      expect(Object.values(out).map((d) => d.eventId)).toEqual(scope.events.map((e) => e.id))
      expect(calls.length).toBe(mode === 'one-call' ? 0 : 3)
      expect(allCalls).toBe(mode === 'one-call' ? 1 : 0)
      expect(scope.events.filter((e) => e.llmCall).length).toBe(mode === 'one-call' ? 1 : 0)
    },
  )
  it('a mixed set-wide error records each typed fallback and one error', async () => {
    const { fn } = fake()
    const all = Object.assign(
      async () => {
        throw new Error('synthetic failure')
      },
      { supportedTypes: ['choice', 'score', 'noul'] as const },
    ) as DecideAllFn
    const scope = createScope('p', {})
    const out = await fields(scope, fn, all)
    expect(out.severity).toMatchObject({ level: 'high', value: 2, expected: null, reason: 'error' })
    expect(out.blocked).toMatchObject({ holds: false, pTrue: null, reason: 'error' })
    expect(out.route).toMatchObject({ label: 'chat', reason: 'error' })
    expect(scope.events.filter((e) => e.type === 'error')).toHaveLength(1)
    expect(scope.events.filter((e) => e.type === 'decision_made')).toHaveLength(3)
  })
})

describe('decision-joint-product', () => {
  it('counts 3 score levels × 2 noul values × 2 choices, then marginalises before policy', async () => {
    const { fn, calls } = fake(undefined, () =>
      raw({ 'medium | true | search': 0.6, 'high | false | chat': 0.4 }),
    )
    // Explicit all-type support; the joint product itself is a choice.
    Object.assign(fn, { supportedTypes: ['choice', 'score', 'noul'] })
    const scope = createScope('p', {})
    const out = await decideFields(scope, {
      decide: fn,
      set: { ...SET, mode: 'joint' },
      policy: POLICY,
      state: 's',
    })
    expect(calls).toHaveLength(1)
    const spec = calls[0] as DecisionSpec
    expect(spec.labels).toHaveLength(12)
    expect(spec.labels.map((l) => l.id)).toEqual(
      SCORE.levels.flatMap((l) =>
        ['true', 'false'].flatMap((b) => CHOICE.labels.map((c) => `${l.id} | ${b} | ${c.id}`)),
      ),
    )
    expect(out.severity).toMatchObject({
      level: 'medium',
      expected: 1.4,
      probs: { low: 0, medium: 0.6, high: 0.4 },
    })
    expect(out.blocked).toMatchObject({ holds: true, pTrue: 0.6 })
    expect(out.route.label).toBe('search')
    expect(scope.events.map((e) => (e.data as DecisionMadeEventData).type)).toEqual([
      'score',
      'noul',
      undefined,
    ])
  })
  it('refuses 6 score levels × 2 × 2 above 20 at declaration and before calls', async () => {
    const severity = defineScore({
      key: 'wide',
      question: 'q',
      levels: Array.from({ length: 6 }, (_, i) => ({
        id: String(i),
        description: 'Synthetic level.',
      })),
    })
    const set = { ...SET, mode: 'joint' as const, fields: { ...SET.fields, severity } }
    expect(() => defineDecisionSet(set)).toThrow(/24-label product/)
    const { fn, calls } = fake()
    await expect(
      decideFields(createScope('p', {}), {
        decide: fn,
        set,
        state: 's',
        policy: { ...POLICY, severity: { fallback: '0' } },
      }),
    ).rejects.toThrow(/24-label product/)
    expect(calls).toHaveLength(0)
  })
  it('allows exactly 20 outcomes from ten score levels and a noul', async () => {
    const score = defineScore({
      key: 'ten',
      question: 'q',
      levels: Array.from({ length: 10 }, (_, i) => ({
        id: `level${i}`,
        description: 'Synthetic level.',
      })),
    })
    const set = defineDecisionSet({
      key: 'twenty',
      mode: 'joint',
      fields: { score, condition: NOUL },
    })
    const { fn, calls } = fake(['choice', 'score', 'noul'], () => raw({ 'level9 | true': 1 }))
    const out = await decideFields(createScope('p', {}), {
      decide: fn,
      set,
      state: 's',
      policy: { score: { fallback: 'level0' }, condition: { fallback: false } },
    })
    expect((calls[0] as DecisionSpec).labels).toHaveLength(20)
    expect(out.score).toMatchObject({ level: 'level9', value: 9, expected: 9 })
    expect(out.condition.holds).toBe(true)
  })
  it('Jev still serves mixed fields rather than a product', async () => {
    const { fn, calls } = fake()
    fn.serving = () => ({ method: 'jev' })
    let seen: unknown
    const all = Object.assign(
      async (i: unknown) => {
        seen = i
        return { fields: ANSWERS }
      },
      { supportedTypes: ['choice', 'score', 'noul'] as const },
    ) as DecideAllFn
    const set = Object.freeze({ ...SET, mode: 'joint' as const })
    await decideFields(createScope('p', {}), {
      decide: fn,
      decideAll: all,
      set,
      policy: POLICY,
      state: 's',
    })
    expect(seen).toMatchObject({ spec: { fields: SET.fields } })
    expect(calls).toHaveLength(0)
    expect(set.mode).toBe('joint')
  })
})

describe('unsupported-type-fails-closed evaluateDecision', () => {
  it.each(['fields', 'joint'] as const)(
    'a choice-only decide with no decideAll is never sent a score or noul (%s)',
    async (mode) => {
      const calls: AnyDecisionSpec[] = []
      const legacy = (async ({ spec }: { spec: AnyDecisionSpec }) => {
        calls.push(spec)
        return raw({ chat: 1 })
      }) as DecideFn
      const out = await decideFields(createScope('p', {}), {
        decide: legacy,
        set: { ...SET, mode },
        policy: POLICY,
        state: 's',
      })
      expect([out.severity.reason, out.blocked.reason]).toEqual([
        'unsupported-type',
        'unsupported-type',
      ])
      expect(calls).toHaveLength(1)
      expect(calls[0].type).toBeUndefined()
      expect((calls[0] as DecisionSpec).labels.map((l) => l.id)).toEqual(['chat', 'search'])
    },
  )
  it.each([undefined, ['choice'] as const])(
    'refuses score/noul before calling a legacy seam (%j)',
    async (support) => {
      const { fn, calls } = fake(support)
      // fake's default supports everything; remove the member to emulate a legacy seam.
      if (support === undefined) delete (fn as { supportedTypes?: unknown }).supportedTypes
      const s = await evaluateDecision({
        decide: fn,
        spec: SCORE,
        state: 's',
        policy: POLICY.severity,
      })
      const n = await evaluateDecision({
        decide: fn,
        spec: NOUL,
        state: 's',
        policy: POLICY.blocked,
      })
      expectTypeOf(s.decision).toEqualTypeOf<ScoreDecision<'low' | 'medium' | 'high'>>()
      expectTypeOf(n.decision).toEqualTypeOf<NoulDecision>()
      expect(calls).toHaveLength(0)
      expect(s.decision).toMatchObject({
        level: 'high',
        value: 2,
        expected: null,
        top: null,
        reason: 'unsupported-type',
      })
      expect(n.decision).toMatchObject({ holds: false, pTrue: null, reason: 'unsupported-type' })
      expect(s.error).toBeUndefined()
      expect(n.error).toBeUndefined()
      expect(
        (await evaluateDecision({ decide: fn, spec: SCORE, state: '', policy: POLICY.severity }))
          .decision.reason,
      ).toBe('no-state')
    },
  )
  it('uses decideAll support independently and excludes unsupported fields', async () => {
    const { fn, calls } = fake()
    let seen: unknown
    const all = (async (input: unknown) => {
      seen = input
      return { fields: { route: ANSWERS.route } }
    }) as DecideAllFn
    const scope = createScope('p', {})
    const out = await fields(scope, fn, all)
    expect(seen).toEqual({
      spec: { key: SET.key, fields: { route: CHOICE } },
      state: 'synthetic state',
    })
    expect(out.severity.reason).toBe('unsupported-type')
    expect(out.blocked.reason).toBe('unsupported-type')
    expect(out.route.abstained).toBe(false)
    expect(calls).toHaveLength(0)
  })
  it('makes zero set requests when every field is unsupported', async () => {
    const { fn } = fake()
    let calls = 0
    const all = (async () => {
      calls++
      return { fields: {} }
    }) as DecideAllFn
    const out = await decideFields(createScope('p', {}), {
      decide: fn,
      decideAll: all,
      set: { key: 'new', fields: { s: SCORE, n: NOUL } },
      state: 's',
      policy: { s: POLICY.severity, n: POLICY.blocked },
    })
    expect(calls).toBe(0)
    expect([out.s.reason, out.n.reason]).toEqual(['unsupported-type', 'unsupported-type'])
  })
  it('requires choice support for the actual joint product too', async () => {
    const { fn, calls } = fake(['score', 'noul'])
    const out = await decideFields(createScope('p', {}), {
      decide: fn,
      set: { key: 'joint', mode: 'joint', fields: { s: SCORE, n: NOUL } },
      state: 's',
      policy: { s: POLICY.severity, n: POLICY.blocked },
    })
    expect(calls).toHaveLength(0)
    expect([out.s.reason, out.n.reason]).toEqual(['unsupported-type', 'unsupported-type'])
  })
})

describe('typed-decision-construction', () => {
  it.each([SCORE, NOUL])('refuses unsupported $type at construction', (spec) => {
    const { fn, calls } = fake(['choice'])
    expect(() =>
      typedDecision({
        decide: fn,
        spec,
        policy: { fallback: spec.type === 'score' ? 'high' : false },
      }),
    ).toThrow(/unsupported decision type/)
    expect(calls).toHaveLength(0)
  })
  it('runs supported patterns, overwrites stale verdicts on failure and leaves other keys', async () => {
    const { fn } = fake()
    const scorePattern = typedDecision<Record<string, unknown> & TypedDecisionData, typeof SCORE>({
      decide: fn,
      spec: SCORE,
      policy: POLICY.severity,
    })
    const noulPattern = typedDecision<Record<string, unknown> & TypedDecisionData, typeof NOUL>({
      decide: fn,
      spec: NOUL,
      policy: POLICY.blocked,
    })
    const ctx = createContext<Record<string, unknown> & TypedDecisionData>('synthetic state')
    await withRunFrame({}, () => runChain(ctx, [scorePattern, noulPattern]))
    expect(readDecision(ctx.data, SCORE)?.level).toBe('medium')
    expect(readDecision(ctx.data, NOUL)?.holds).toBe(true)
    const failed = fake(['choice', 'score', 'noul'], () => {
      throw new Error('synthetic failure')
    }).fn
    await withRunFrame({}, () =>
      runChain(ctx, [
        typedDecision<Record<string, unknown> & TypedDecisionData, typeof SCORE>({
          decide: failed,
          spec: SCORE,
          policy: POLICY.severity,
        }),
      ]),
    )
    expect(readDecision(ctx.data, SCORE)).toMatchObject({
      level: 'high',
      expected: null,
      reason: 'error',
    })
    expect(readDecision(ctx.data, NOUL)?.holds).toBe(true)
  })
})

describe('decision-fallback-validation', () => {
  it.each([
    ['score', SCORE, 'absent'],
    ['noul', NOUL, 'false'],
    ['choice', CHOICE, 'absent'],
  ] as const)(
    'rejects invalid %s fallback at every policy entry before calls',
    async (_type, spec, fallback) => {
      const { fn, calls } = fake()
      const call = { decide: fn, spec, policy: { fallback }, state: 's' } as never
      expect(() => typedDecision(call)).toThrow(/fallback/)
      await expect(evaluateDecision(call)).rejects.toThrow(/fallback/)
      await expect(decide(createScope('p', {}), call)).rejects.toThrow(/fallback/)
      await expect(
        decideFields(createScope('p', {}), {
          decide: fn,
          set: { key: 'k', fields: { route: CHOICE, invalid: spec } },
          state: 's',
          policy: { route: POLICY.route, invalid: { fallback } },
        } as never),
      ).rejects.toThrow(/fallback/)
      expect(calls).toHaveLength(0)
    },
  )
  it('accepts false and true booleans unchanged on pre-call abstains', async () => {
    const { fn, calls } = fake()
    for (const fallback of [false, true]) {
      const out = await evaluateDecision({
        decide: fn,
        spec: NOUL,
        state: '',
        policy: { fallback },
      })
      expect(out.decision.holds).toBe(fallback)
      expect(out.event.policy.fallback).toBe(String(fallback))
    }
    expect(calls).toHaveLength(0)
  })
})

describe('decision-generic-source-compatibility', () => {
  it('retains explicit choice label generics, aliases, and the label-map set', async () => {
    expectTypeOf(SET).toMatchTypeOf<MixedDecisionSet<typeof SET.fields>>()
    type L = 'chat' | 'search'
    const { fn } = fake()
    const call: DecisionCall<L> = { decide: fn, spec: CHOICE, policy: POLICY.route, state: 's' }
    const evaluated: EvaluatedDecision<L> = await evaluateDecision<L>(call)
    const config: TypedDecisionConfig<L> = { decide: fn, spec: CHOICE, policy: POLICY.route }
    typedDecision<TypedDecisionData, L>(config)
    const set: DecisionSetSpec<{ route: L }> = { key: 'old', fields: { route: CHOICE } }
    const fieldCall: DecideFieldsCall<{ route: L }> = {
      decide: fn,
      set,
      state: 's',
      policy: { route: POLICY.route },
    }
    const out = await decideFields<{ route: L }>(createScope('p', {}), fieldCall)
    expectTypeOf(out.route.label).toEqualTypeOf<L>()
    expectTypeOf(evaluated.decision.label).toEqualTypeOf<L>()
    const mixed: DecisionCall<typeof SCORE> = {
      decide: fn,
      spec: SCORE,
      state: 's',
      policy: POLICY.severity,
    }
    expectTypeOf((await evaluateDecision(mixed)).decision.level).toEqualTypeOf<
      'low' | 'medium' | 'high'
    >()
    const bad: DecisionCall<typeof NOUL> = {
      decide: fn,
      spec: NOUL,
      state: 's',
      // @ts-expect-error A noul policy cannot carry a string fallback.
      policy: { fallback: 'false' },
    }
    void bad
  })
})

describe('decision-state-sentinel mixed entry points', () => {
  it('a scorer-level throw that echoes state never reaches the error', async () => {
    const state = 'SYNTHETIC-LASTRESORT-SENTINEL'
    const fn = (async () => ({
      get probs(): never {
        throw new Error(`echo ${state}`)
      },
    })) as unknown as DecideFn
    const out = await evaluateDecision({ decide: fn, spec: CHOICE, state, policy: POLICY.route })
    expect(out.decision.reason).toBe('error')
    expect(JSON.stringify(out)).not.toContain(state)
  })
  it('redacts state even from echoed failure messages and all serialized views', async () => {
    const state = 'SYNTHETIC-S2-STATE-SENTINEL'
    for (const fail of [false, true]) {
      const { fn } = fake(['choice', 'score', 'noul'], (spec) => {
        if (fail) throw new Error(`echo ${state}`)
        return ANSWERS[spec.key as keyof typeof ANSWERS]
      })
      const scope = createScope('p', {})
      await decide(scope, { decide: fn, spec: SCORE, state, policy: POLICY.severity })
      await decide(scope, { decide: fn, spec: NOUL, state, policy: POLICY.blocked })
      await decideFields(scope, { decide: fn, set: SET, state, policy: POLICY })
      expect(JSON.stringify(scope.events)).not.toContain(state)
      const ctx = createContext('hello')
      ctx.events.push(...scope.events)
      ctx.events.push({ type: 'user_message', ts: 2, patternId: 'p', data: { content: 'next' } })
      const view = createEventView(ctx).fromAll().unfiltered()
      for (const rendered of [
        view.serialize(),
        view.serializeCompact({ recentTurns: 1 }),
        view.serializeCompact({ recentTurns: 10 }),
      ])
        expect(rendered).not.toContain(state)
    }
  })
})
