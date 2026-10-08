import { describe, expect, expectTypeOf, it } from 'vitest'
import { defineChoice, defineScore, defineNoul, readDecision } from '../index'
import type { PolicyFor, TypedDecisionData } from '../index'
import {
  preCallAbstain,
  scoreDecision,
  scoreScoreDecision,
  scoreNoulDecision,
} from '../patterns/typedDecision.server'
import { createContext } from '../context.server'
import { createEventView } from '../patterns/event-view.server'
import { getEventPreview } from '../observability/projection'

const URGENCY = defineScore({
  key: 'ticket.urgency',
  question: 'How urgently is a reply needed?',
  levels: [
    { id: 'can_wait', description: 'Nothing is blocked.' },
    { id: 'soon', description: 'Someone is waiting, but can continue.' },
    { id: 'now', description: 'Work is blocked until a reply.' },
  ],
})
const CONDITION = defineNoul({ key: 'condition', question: 'The condition holds.' })
const CHOICE = defineChoice({
  key: 'route',
  question: 'Which route?',
  labels: [
    { id: 'chat', description: 'Answer directly.' },
    { id: 'web', description: 'Search.' },
  ],
})
const result = <L extends string>(probs: Record<L, number>) => ({
  probs,
  method: 'logprob' as const,
  calibrated: true,
})

// Mutation: replace ordinalConfidence with the choice p_max formula.
describe('score-math', () => {
  it.each([
    [{ can_wait: 0, soon: 0.5, now: 0.5 }, 1.5, 'soon', 0.25],
    [{ can_wait: 0.5, soon: 0, now: 0.5 }, 1, 'can_wait', 0],
    [{ can_wait: 0, soon: 0.57, now: 0.43 }, 1.43, 'soon', 0.355],
    [{ can_wait: 0, soon: 0, now: 1 }, 2, 'now', 1],
  ] as const)(
    'mean, mode (ties by order) and ordinal confidence: %j',
    (probs, mean, mode, confidence) => {
      const { decision: d } = scoreScoreDecision({
        spec: URGENCY,
        state: 's',
        policy: { fallback: 'now' },
        result: result(probs),
      })
      expect(d.expected).toBeCloseTo(mean, 12)
      expect(d.top).toBe(mode)
      expect(d.level).toBe(mode)
      expect(d.value).toBe(URGENCY.levels.findIndex((l) => l.id === mode))
      expect(d.confidence).toBeCloseTo(confidence, 12)
      expect(d).not.toHaveProperty('margin')
      expect(d).not.toHaveProperty('label')
    },
  )
  it('keeps raw mean/mode while the verdict falls back', () => {
    const { decision: d, event } = scoreScoreDecision({
      spec: URGENCY,
      state: 's',
      policy: { fallback: 'now', minConfidence: 0.5 },
      result: result({ can_wait: 0, soon: 0.5, now: 0.5 }),
    })
    expect(d).toMatchObject({
      level: 'now',
      value: 2,
      expected: 1.5,
      top: 'soon',
      reason: 'low-confidence',
      abstained: true,
    })
    expect(event).toMatchObject({ type: 'score', label: 'now', value: 2, expected: 1.5 })
  })
})

describe('score/noul shared fail-closed policy', () => {
  it.each([
    ['uncalibrated', { requireCalibrated: true }, { calibrated: false }, undefined],
    ['low-coverage', { minCoverage: 0.9 }, { coverage: 0.5 }, undefined],
    ['method-mismatch', { minConfidence: 0.5, thresholdMethod: 'jev' as const }, {}, undefined],
    ['low-confidence', { minConfidence: 0.9 }, {}, undefined],
  ] as const)(
    '%s preserves raw readouts but returns each fallback',
    (reason, policy, extra, calibration) => {
      const score = scoreScoreDecision({
        spec: URGENCY,
        state: 's',
        policy: { fallback: 'now', ...policy },
        calibration,
        result: { ...result({ can_wait: 0, soon: 0.6, now: 0.4 }), ...extra },
      }).decision
      const noul = scoreNoulDecision({
        spec: CONDITION,
        state: 's',
        policy: { fallback: false, ...policy },
        calibration,
        result: { ...result({ true: 0.75, false: 0.25 }), ...extra },
      }).decision
      expect(score).toMatchObject({
        level: 'now',
        value: 2,
        top: 'soon',
        expected: 1.4,
        reason,
        abstained: true,
      })
      expect(noul).toMatchObject({ holds: false, pTrue: 0.75, reason, abstained: true })
    },
  )

  it('uses fitted confidence cuts and ignores fitted margin on the new types', () => {
    const score = scoreScoreDecision({
      spec: URGENCY,
      state: 's',
      policy: { fallback: 'now', minConfidence: 1 },
      calibration: { minConfidence: 0.2, minMargin: 1 },
      result: result({ can_wait: 0, soon: 0.5, now: 0.5 }),
    }).decision
    const noul = scoreNoulDecision({
      spec: CONDITION,
      state: 's',
      policy: { fallback: false, minConfidence: 1 },
      calibration: { minConfidence: 0.2, minMargin: 1 },
      result: result({ true: 0.75, false: 0.25 }),
    }).decision
    expect(score.abstained).toBe(false)
    expect(noul.abstained).toBe(false)
  })

  it('corrupt mass abstains without inventing a raw readout', () => {
    expect(
      scoreScoreDecision({
        spec: URGENCY,
        state: 's',
        policy: { fallback: 'now' },
        result: result({ can_wait: NaN, soon: 1, now: 0 }),
      }).decision,
    ).toMatchObject({ level: 'now', value: 2, expected: null, top: null, reason: 'error' })
    expect(
      scoreNoulDecision({
        spec: CONDITION,
        state: 's',
        policy: { fallback: false },
        result: result({ true: NaN, false: 1 }),
      }).decision,
    ).toMatchObject({ holds: false, pTrue: null, reason: 'error' })
  })
})

// Mutation: ignore the confidence cut (act on p >= .5).
describe('noul-math', () => {
  it.each([0.1, 0.2, 0.3, 0.5, 0.7, 0.8, 0.9])('P(true)=%s uses the symmetric band', (p) => {
    const { decision: d, event } = scoreNoulDecision({
      spec: CONDITION,
      state: 's',
      policy: { fallback: false, minConfidence: 0.6 },
      result: result({ true: p, false: 1 - p }),
    })
    expect(d.pTrue).toBeCloseTo(p, 12)
    expect(d.confidence).toBeCloseTo(Math.abs(2 * p - 1), 12)
    expect(d.abstained).toBe(p > 0.2 && p < 0.8)
    expect(d.holds).toBe(p >= 0.8)
    expect(event.policy.fallback).toBe('false')
    expect(d).not.toHaveProperty('margin')
    expect(d).not.toHaveProperty('label')
  })
  it('preserves false fallback and null raw readout when no distribution exists', () => {
    expect(
      scoreNoulDecision({ spec: CONDITION, state: '', policy: { fallback: false } }).decision,
    ).toMatchObject({ holds: false, pTrue: null, reason: 'no-state' })
    expect(
      scoreNoulDecision({
        spec: CONDITION,
        state: 's',
        policy: { fallback: true },
        error: { error: 'failed' },
      }).decision,
    ).toMatchObject({ holds: true, pTrue: null, reason: 'error' })
  })
})

// Mutation: allow one or eleven score levels.
describe('score-levels-cap', () => {
  it.each([1, 11])('refuses %s levels at declaration', (n) => {
    expect(() =>
      defineScore({
        key: 'k',
        question: 'q',
        levels: Array.from({ length: n }, (_, i) => ({ id: `${i}`, description: 'level' })),
      }),
    ).toThrow(/2\.\.10/)
  })
  it.each([2, 10])('accepts %s levels', (n) => {
    expect(
      defineScore({
        key: 'k',
        question: 'q',
        levels: Array.from({ length: n }, (_, i) => ({ id: `${i}`, description: 'level' })),
      }).levels,
    ).toHaveLength(n)
  })
  it('refuses duplicate ids and invalid choice counts', () => {
    expect(() =>
      defineScore({ key: 'k', question: 'q', levels: [URGENCY.levels[0], URGENCY.levels[0]] }),
    ).toThrow(/unique/)
    expect(() => defineChoice({ key: 'k', question: 'q', labels: [] })).toThrow(/2\.\.20/)
    expect(() =>
      defineChoice({ key: 'k', question: 'q', labels: [CHOICE.labels[0], CHOICE.labels[0]] }),
    ).toThrow(/unique/)
  })
})

// Mutation: write type: 'choice' into the existing event.
describe('choice-byte-identical', () => {
  it('keeps the full golden event JSON, including key order', () => {
    const { decision, event } = scoreDecision({
      spec: CHOICE,
      state: 's',
      policy: { fallback: 'chat' },
      result: result({ chat: 0.875, web: 0.125 }),
    })
    expect(JSON.stringify(event)).toBe(
      '{"key":"route","question":"Which route?","labels":[{"id":"chat","description":"Answer directly."},{"id":"web","description":"Search."}],"probs":{"chat":0.875,"web":0.125},"label":"chat","top":"chat","margin":0.75,"confidence":0.75,"abstained":false,"policy":{"fallback":"chat"},"method":"logprob","calibrated":true,"stateChars":1}',
    )
    expect(decision).not.toHaveProperty('type')
    expect(CHOICE).not.toHaveProperty('type')
  })
})

// Mutation: copy state into the event. Covers both serialized view branches.
describe('decision-state-sentinel score/noul', () => {
  it('writes only metadata for each type and renders the statistic', () => {
    const state = 'SYNTHETIC-STATE-SENTINEL'
    const ctx = createContext('hello')
    const scored = [
      scoreScoreDecision({
        spec: URGENCY,
        state,
        policy: { fallback: 'now' },
        result: result({ can_wait: 0, soon: 0.57, now: 0.43 }),
      }),
      scoreNoulDecision({
        spec: CONDITION,
        state,
        policy: { fallback: false },
        result: result({ true: 0.91, false: 0.09 }),
      }),
    ]
    for (const { event, decision } of scored) {
      expect(event.stateChars).toBe(state.length)
      expect(JSON.stringify({ event, decision })).not.toContain(state)
      ctx.events.push({
        id: event.key,
        type: 'decision_made',
        ts: 1,
        patternId: 'p',
        data: event,
        llmCall: { functionName: 'Decide', variables: { state } },
      })
    }
    ctx.events.push({ type: 'user_message', ts: 2, patternId: 'p', data: { content: 'next' } })
    const view = createEventView(ctx).fromAll().unfiltered()
    for (const s of [
      view.serialize(),
      view.serializeCompact({ recentTurns: 1 }),
      view.serializeCompact({ recentTurns: 10 }),
    ]) {
      expect(s).not.toContain(state)
      expect(s).toContain('ticket.urgency: soon (E=1.43)')
      expect(s).toContain('condition: true (p=0.91)')
    }
    expect(getEventPreview('decision_made', scored[0].event)).toBe('ticket.urgency: soon (E=1.43)')
    expect(getEventPreview('decision_made', scored[1].event)).toBe('condition: true (p=0.91)')
  })
})

// Mutation: widen readDecision's score return to ScoreDecision<string>.
describe('readDecision type inference', () => {
  it('infers ids once, narrows by type, and reads legacy choices', () => {
    const d = scoreScoreDecision({
      spec: URGENCY,
      state: 's',
      policy: { fallback: 'now' },
      result: result({ can_wait: 0, soon: 1, now: 0 }),
    }).decision
    const data: TypedDecisionData = { decisions: { [URGENCY.key]: d } }
    const read = readDecision(data, URGENCY)
    expectTypeOf(read!.level).toEqualTypeOf<'can_wait' | 'soon' | 'now'>()
    expectTypeOf<PolicyFor<typeof URGENCY>>().not.toHaveProperty('minMargin')
    expectTypeOf<PolicyFor<typeof CONDITION>>().not.toHaveProperty('minMargin')
    expect(read?.level).toBe('soon')
    expect(readDecision(data, defineNoul({ key: URGENCY.key, question: 'q' }))).toBeUndefined()
    expect(readDecision({}, URGENCY)).toBeUndefined()
    const choice = scoreDecision({
      spec: CHOICE,
      state: 's',
      policy: { fallback: 'chat' },
      result: result({ chat: 1, web: 0 }),
    }).decision
    expect(readDecision({ decisions: { route: choice } }, CHOICE)?.label).toBe('chat')
  })
})

// S1 pins the pre-call seam; S2 repeats this through evaluateDecision.
// Mutation: bypass the unsupported-type gate and call anyway.
describe('unsupported-type-fails-closed', () => {
  it.each([undefined, ['choice'] as const])(
    'a legacy/choice-only seam refuses both types (%j)',
    async (supportedTypes) => {
      let calls = 0
      const transport = async () => {
        calls++
        return result({ can_wait: 1, soon: 0, now: 0 })
      }
      const refusal = preCallAbstain({
        spec: URGENCY,
        state: 's',
        policy: { fallback: 'now' },
        supportedTypes,
      })
      const score = scoreScoreDecision({
        spec: URGENCY,
        state: 's',
        policy: { fallback: 'now' },
        unsupportedType: refusal === 'unsupported-type' ? true : undefined,
        result: refusal ? undefined : await transport(),
      }).decision
      const noulRefusal = preCallAbstain({
        spec: CONDITION,
        state: 's',
        policy: { fallback: false },
        supportedTypes,
      })
      if (!noulRefusal) await transport()
      const noul = scoreNoulDecision({
        spec: CONDITION,
        state: 's',
        policy: { fallback: false },
        unsupportedType: noulRefusal === 'unsupported-type' ? true : undefined,
      }).decision
      expect(calls).toBe(0)
      expect(score).toMatchObject({
        level: 'now',
        value: 2,
        expected: null,
        reason: 'unsupported-type',
      })
      expect(noul).toMatchObject({ holds: false, pTrue: null, reason: 'unsupported-type' })
    },
  )
  it('checks no-state first, then type before calibration, and honors declared support', () => {
    const input = {
      spec: URGENCY,
      state: 's',
      policy: { fallback: 'now', requireCalibrated: true },
      method: 'verbalized' as const,
    }
    expect(preCallAbstain({ ...input, state: '' })).toBe('no-state')
    expect(preCallAbstain(input)).toBe('unsupported-type')
    expect(preCallAbstain({ ...input, supportedTypes: ['score'] })).toBe('uncalibrated')
    expect(preCallAbstain({ ...input, method: 'logprob', supportedTypes: ['score'] })).toBeNull()
    expect(preCallAbstain({ spec: CHOICE, state: 's', policy: { fallback: 'chat' } })).toBeNull()
  })
})
