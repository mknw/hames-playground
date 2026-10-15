import { describe, expect, it } from 'vitest'
import {
  decideFields,
  defineChoice,
  defineScore,
  defineNoul,
  evaluateDecision,
  typedDecision,
  type TypedDecisionData,
} from '../patterns/typedDecision.server'
import { withRunFrame } from '../run-frame.server'
import { runChain } from '../patterns/chain.server'
import { createScope, createContext } from '../context.server'
import type { DecideFn, DecideAllFn, DecideResult, DecisionMadeEventData } from '../types'

const choice = defineChoice({
  key: 'pick',
  question: 'Which action?',
  labels: [
    { id: 'take', description: 'Take it' },
    { id: 'skip', description: 'Skip it' },
  ],
})
const score = defineScore({
  key: 'urgency',
  question: 'How urgent?',
  levels: [
    { id: 'low', description: 'Can wait' },
    { id: 'high', description: 'Act now' },
  ],
})
const noul = defineNoul({ key: 'holds', question: 'The number is even.' })
const fn = (result: DecideResult<string>): DecideFn => (async () => result) as DecideFn

describe('systemone decision recording', () => {
  it('passes endpoint probabilities and confidence through without thresholds or normalization', async () => {
    const probabilities = { take: 0.501, skip: 0.494 }
    const result = await evaluateDecision({
      decide: fn({ probs: probabilities, confidence: 0.001, method: 'jev', calibrated: false }),
      spec: choice,
      state: 'Synthetic state.',
    })
    expect(result.decision).toMatchObject({
      label: 'take',
      probs: probabilities,
      confidence: 0.001,
      abstained: false,
      calibrated: false,
    })
    expect(result.event.probs).toEqual(probabilities)
    expect(result.error).toBeUndefined()
  })

  it('records choice, score and noul from one set with one shared call record', async () => {
    const call = {
      variables: {},
      functionName: 'Decide',
      clientName: 'PrivateSystemOne',
      durationMs: 2000,
    }
    const all = (async () => ({
      fields: {
        choice: {
          probs: { take: 0.51, skip: 0.49 },
          method: 'jev',
          calibrated: false,
          llmCall: call,
        },
        score: { probs: { low: 0.6, high: 0.4 }, method: 'jev', calibrated: false, llmCall: call },
        noul: {
          probs: { true: 0.49, false: 0.51 },
          method: 'jev',
          calibrated: true,
          llmCall: call,
        },
      },
    })) as unknown as DecideAllFn
    const scope = createScope<Record<string, unknown>>('decisions', {})
    const result = await decideFields(scope, {
      decide: fn({ probs: {}, method: 'jev', calibrated: false }),
      decideAll: all,
      set: { key: 'mixed', fields: { choice, score, noul } },
      state: 'Synthetic state.',
    })
    expect(result.choice.label).toBe('take')
    expect(result.score).toMatchObject({ level: 'low', value: 0, expected: 0.4 })
    expect(result.noul).toMatchObject({ holds: false, pTrue: 0.49 })
    expect(scope.events.filter((e) => e.type === 'decision_made')).toHaveLength(3)
    expect(scope.events.filter((e) => e.llmCall)).toHaveLength(1)
    expect(scope.events.map((e) => (e.data as DecisionMadeEventData).probs)).toEqual([
      { take: 0.51, skip: 0.49 },
      { low: 0.6, high: 0.4 },
      { true: 0.49, false: 0.51 },
    ])
  })

  it.each([{}, { take: 2, skip: -1 }, { take: 0.4, skip: 0.4 }])(
    'returns no verdict for malformed probabilities %j',
    async (probs) => {
      const result = await evaluateDecision({
        decide: fn({ probs: probs as Record<string, number>, method: 'jev', calibrated: false }),
        spec: choice,
        state: 'Synthetic.',
      })
      expect(result.decision).toMatchObject({ label: null, probs: {}, reason: 'error' })
      expect(result.error).toBeDefined()
    },
  )

  it('returns no verdict on transport failure and keeps the state out of error events', async () => {
    const state = 'SYNTHETIC-SENTINEL'
    const result = await evaluateDecision({
      decide: (async () => {
        throw new Error(`Failed ${state}`)
      }) as DecideFn,
      spec: choice,
      state,
    })
    expect(result.decision.label).toBeNull()
    expect(result.error?.error).toBe('Failed [state]')
    expect(JSON.stringify(result.event)).not.toContain(state)
  })
})

// State construction failures predate the removed confidence policy.
it('a state-builder failure records no verdict and makes no provider call', async () => {
  let calls = 0
  type Data = TypedDecisionData & Record<string, unknown>
  const context = createContext<Data>('Synthetic.', {})
  await withRunFrame({}, () =>
    runChain(context, [
      typedDecision<Data, typeof choice>({
        decide: (async () => {
          calls++
          return { probs: { take: 1, skip: 0 }, method: 'jev', calibrated: true }
        }) as DecideFn,
        spec: choice,
        state: () => {
          throw new Error('synthetic builder failure')
        },
      }),
    ]),
  )
  expect(calls).toBe(0)
  expect(context.data.decisions?.pick).toMatchObject({ label: null })
  expect(context.events.filter((e) => e.type === 'decision_made')).toHaveLength(1)
  expect(context.events.filter((e) => e.type === 'error')).toHaveLength(1)
})
