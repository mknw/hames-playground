/**
 * #418 slice T1 — the pure scoring half of the decision policy layer
 * (`patterns/typedDecision.server.ts`), the `decision_made` event type and
 * its serialization, and the decision capability field.
 *
 * Every test names the source mutation that reddens it; every one was run —
 * see the PR's pin/mutation table. The pins:
 *
 *   decision-math            — renormalisation, letter-variant summing,
 *                              coverage, margin, confidence, temperature/bias
 *                              in log space
 *   decision-policy          — every abstain reason returns the fallback;
 *                              probs sum to 1; an unseen label is 0
 *   decision-threshold-method— (F2) a logprob-fitted threshold is never
 *                              applied to a Jev/verbalized read; the applied
 *                              calibration entry's own cuts win
 *   decision-precall-abstain — (F3) a `requireCalibrated` decision on a
 *                              knowingly non-calibratable client abstains
 *                              BEFORE the call (the zero-LLM-calls half is
 *                              completed by T2's `evaluateDecision`, which is
 *                              the only thing that can make the call)
 *   decision-always-commit   — `decision_made` survives `on-success` (with a
 *                              ctx in error) and `never`
 *   decision-state-sentinel  — a sentinel in the state appears in NO
 *                              serialized view and never in the event data;
 *                              it survives only in `llmCall.variables`
 */

import { describe, expect, it } from 'vitest'
import {
  calibrateLabelMass,
  normalizeLabelMass,
  preCallAbstain,
  resolveDecisionCuts,
  scoreDecision,
  sumLabelMass,
  type DecisionScoring,
  type TopLogprob,
} from '@hames-ai/harness-patterns/patterns/typedDecision.server'
import { commitEvents, createScope } from '@hames-ai/harness-patterns/context.server'
import { createEventView } from '@hames-ai/harness-patterns/patterns/event-view.server'
import {
  harnessCalibratedDecisionKeys,
  harnessDecisionKeys,
} from '@hames-ai/harness-patterns/pattern-capabilities'
import { MAX_DECISION_LABELS } from '@hames-ai/harness-patterns/types'
import type {
  ConfiguredPattern,
  ContextEvent,
  DecisionPolicy,
  DecisionSpec,
  DecideResult,
  EventType,
  UnifiedContext,
} from '@hames-ai/harness-patterns/types'

const SENTINEL = '⟦SENTINEL-mail-body⟧'

const KIND_SPEC: DecisionSpec<'keep' | 'drop'> = {
  key: 'memory.kind',
  question: 'What kind of memory is this?',
  labels: [
    { id: 'keep', description: 'worth storing' },
    { id: 'drop', description: 'not worth storing' },
  ],
}

const PASS_POLICY: DecisionPolicy<'keep' | 'drop'> = { fallback: 'drop' }

const THREE_SPEC: DecisionSpec<'keep' | 'drop' | 'park'> = {
  key: 'memory.kind',
  question: 'What kind of memory is this?',
  labels: [
    { id: 'keep', description: '' },
    { id: 'drop', description: '' },
    { id: 'park', description: '' },
  ],
}

function resultOf<L extends string>(
  probs: Record<L, number>,
  opts?: { calibrated?: boolean; method?: 'logprob' | 'jev' | 'verbalized'; coverage?: number },
): DecideResult<L> {
  return {
    probs,
    method: opts?.method ?? ('logprob' as const),
    calibrated: opts?.calibrated ?? true,
    ...(opts?.coverage !== undefined && { coverage: opts.coverage }),
  }
}

function scoring(
  overrides: Partial<DecisionScoring<'keep' | 'drop'>>,
): DecisionScoring<'keep' | 'drop'> {
  return {
    spec: KIND_SPEC,
    policy: PASS_POLICY,
    state: 'some state',
    ...overrides,
  }
}

// ============================================================================
// decision-math
// ============================================================================

describe('decision-math', () => {
  it('sums letter VARIANTS into one label and keys by exact text', () => {
    const top: TopLogprob[] = [
      { token: 'B', logprob: Math.log(0.5) },
      { token: ' B', logprob: Math.log(0.2) },
      { token: '(B', logprob: Math.log(0.1) },
      { token: 'A', logprob: Math.log(0.15) },
      { token: 'Hello', logprob: Math.log(0.05) }, // names no label → leftover
    ]
    const { mass, coverage } = sumLabelMass(top, ['A', 'B'])
    expect(mass.B).toBeCloseTo(0.8, 10)
    expect(mass.A).toBeCloseTo(0.15, 10)
    // A token that merely STARTS with a letter is not that letter — the
    // prefix must end at a word boundary ('B.' counts; 'Btool' does not).
    const bounded = sumLabelMass(
      [
        { token: 'B.', logprob: Math.log(0.4) },
        { token: 'Btool', logprob: Math.log(0.3) },
      ],
      ['A', 'B'],
    )
    expect(bounded.mass.B).toBeCloseTo(0.4, 10) // 'B.' counts for 'B'
    expect(bounded.mass).not.toHaveProperty('Btool')
    // A token that shares a prefix with NO label is not attributed at all.
    expect(mass).not.toHaveProperty('Hello')
    // coverage = matched mass; the leftover is 1 − coverage.
    expect(coverage).toBeCloseTo(0.95, 10)
  })

  it('renormalises to a distribution that sums to 1, unseen labels at 0', () => {
    const { probs, total } = normalizeLabelMass(
      { keep: 0.3, drop: 0.45 },
      THREE_SPEC.labels.map((l) => l.id),
    )
    expect(total).toBeCloseTo(0.75, 12)
    expect(probs.keep).toBeCloseTo(0.4, 12)
    expect(probs.drop).toBeCloseTo(0.6, 12)
    expect(probs.park).toBe(0)
    expect(Object.values(probs).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12)
  })

  it('computes margin and the K-recentred confidence', () => {
    const { decision } = scoreDecision(scoring({ result: resultOf({ keep: 0.9, drop: 0.1 }) }))
    expect(decision.top).toBe('keep')
    expect(decision.margin).toBeCloseTo(0.8, 12)
    // K = 2: confidence = (2·0.9 − 1)/(2 − 1) = 0.8.
    expect(decision.confidence).toBeCloseTo(0.8, 12)

    const three = scoreDecision<'keep' | 'drop' | 'park'>({
      spec: THREE_SPEC,
      policy: { fallback: 'drop' },
      state: 'some state',
      result: { probs: { keep: 0.5, drop: 0.25, park: 0.25 }, method: 'logprob', calibrated: true },
    }).decision
    // K = 3: (3·0.5 − 1)/(3 − 1) = 0.25 — same p_max, more labels, less certainty.
    expect(three.confidence).toBeCloseTo(0.25, 12)
    expect(three.margin).toBeCloseTo(0.25, 12)
  })

  it('applies temperature and bias in log space', () => {
    const mass = { keep: 0.8, drop: 0.2 }
    // Temperature > 1 flattens: the calibrated spread shrinks.
    const flat = calibrateLabelMass(mass, { temperature: 4 })
    expect(flat.keep! / flat.drop!).toBeLessThan(mass.keep / mass.drop)
    // Temperature < 1 sharpens.
    const sharp = calibrateLabelMass(mass, { temperature: 0.5 })
    expect(sharp.keep! / sharp.drop!).toBeGreaterThan(mass.keep / mass.drop)
    // Bias lifts one label in log space.
    const biased = calibrateLabelMass(mass, { bias: { drop: Math.log(3) } })
    expect(biased.drop! / biased.keep!).toBeCloseTo((0.2 * 3) / 0.8, 10)
    // Still a distribution.
    const flatSum = Object.values(flat).reduce((a, b) => a + b, 0)
    expect(flatSum).toBeCloseTo(1, 12)
    // A malformed entry degrades to the identity, never throws.
    const malformed = calibrateLabelMass(mass, { temperature: -2, bias: { keep: Number.NaN } })
    expect(malformed.keep).toBeCloseTo(0.8, 12)
    expect(malformed.drop).toBeCloseTo(0.2, 12)
  })

  it('breaks argmax ties by the spec array order', () => {
    const { decision } = scoreDecision(scoring({ result: resultOf({ drop: 0.5, keep: 0.5 }) }))
    expect(decision.top).toBe('keep') // 'keep' is first in KIND_SPEC.labels
  })

  it('a read exactly AT the cut passes; just below it abstains (the < boundary)', () => {
    // 0.875 and 0.125 are exact in binary floating point, so "exactly at" is
    // not a rounding question: K = 2 gives confidence = 0.75 and margin = 0.75
    // EXACTLY, and the cuts are set to exactly that.
    const at = scoreDecision(
      scoring({
        policy: { fallback: 'drop', minConfidence: 0.75, minMargin: 0.75 },
        result: resultOf({ keep: 0.875, drop: 0.125 }),
      }),
    ).decision
    expect(at.abstained).toBe(false)
    expect(at.label).toBe('keep')

    // Just below the cut abstains — and each cut is checked at its own
    // boundary (here confidence fails first by the abstain order).
    const below = scoreDecision(
      scoring({
        policy: { fallback: 'drop', minConfidence: 0.751, minMargin: 0.751 },
        result: resultOf({ keep: 0.875, drop: 0.125 }),
      }),
    ).decision
    expect(below.abstained).toBe(true)
    expect(below.reason).toBe('low-confidence')
  })
})

// ============================================================================
// decision-policy
// ============================================================================

describe('decision-policy', () => {
  it('returns the fallback for EVERY abstain reason, top kept as argmax', () => {
    const cases: Array<[DecisionScoring<'keep' | 'drop'>, string]> = [
      // no-state
      [scoring({ state: '', method: 'logprob' }), 'no-state'],
      // error
      [scoring({ error: { error: 'LLMCallError: parse failed' } }), 'error'],
      // uncalibrated (post-call)
      [
        scoring({
          policy: { fallback: 'drop', requireCalibrated: true },
          result: resultOf({ keep: 0.9, drop: 0.1 }, { calibrated: false }),
        }),
        'uncalibrated',
      ],
      // low-coverage
      [
        scoring({
          policy: { fallback: 'drop', minCoverage: 0.99 },
          result: resultOf({ keep: 0.9, drop: 0.1 }, { coverage: 0.5 }),
        }),
        'low-coverage',
      ],
      // low-confidence
      [
        scoring({
          policy: { fallback: 'drop', minConfidence: 0.9 },
          result: resultOf({ keep: 0.9, drop: 0.1 }),
        }),
        'low-confidence',
      ],
      // low-margin
      [
        scoring({
          policy: { fallback: 'drop', minMargin: 0.9 },
          result: resultOf({ keep: 0.6, drop: 0.4 }),
        }),
        'low-margin',
      ],
      // method-mismatch is decision-threshold-method's row below.
    ]
    for (const [input, reason] of cases) {
      const { decision } = scoreDecision(input)
      expect(decision.abstained, reason).toBe(true)
      expect(decision.reason, reason).toBe(reason)
      expect(decision.label, reason).toBe('drop')
      expect(decision.key).toBe('memory.kind')
    }
  })

  it('abstains in the documented order (no-state → error → uncalibrated → …)', () => {
    // no-state beats error.
    expect(scoreDecision(scoring({ state: '', error: { error: 'boom' } })).decision.reason).toBe(
      'no-state',
    )
    // error beats uncalibrated: a thrown call has no result to judge.
    expect(
      scoreDecision(
        scoring({
          policy: { fallback: 'drop', requireCalibrated: true },
          error: { error: 'boom' },
        }),
      ).decision.reason,
    ).toBe('error')
    // uncalibrated beats low-coverage.
    expect(
      scoreDecision(
        scoring({
          policy: { fallback: 'drop', requireCalibrated: true, minCoverage: 0.99 },
          result: resultOf({ keep: 0.9, drop: 0.1 }, { calibrated: false, coverage: 0.1 }),
        }),
      ).decision.reason,
    ).toBe('uncalibrated')
    // low-coverage beats method-mismatch (and both beat low-confidence).
    expect(
      scoreDecision(
        scoring({
          policy: {
            fallback: 'drop',
            minCoverage: 0.99,
            minConfidence: 0.9,
            thresholdMethod: 'jev',
          },
          method: 'logprob',
          result: resultOf({ keep: 0.9, drop: 0.1 }, { method: 'logprob', coverage: 0.1 }),
        }),
      ).decision.reason,
    ).toBe('low-coverage')
    // method-mismatch beats low-confidence.
    expect(
      scoreDecision(
        scoring({
          policy: { fallback: 'drop', minConfidence: 0.9, thresholdMethod: 'jev' },
          method: 'logprob',
          result: resultOf({ keep: 0.9, drop: 0.1 }, { method: 'logprob' }),
        }),
      ).decision.reason,
    ).toBe('method-mismatch')
  })

  it('carries the distribution on a threshold abstain, sums to 1, unseen labels 0', () => {
    const THREE_SPEC: DecisionSpec<'keep' | 'drop' | 'park'> = {
      key: 'memory.kind',
      question: 'What kind of memory is this?',
      labels: [
        { id: 'keep', description: '' },
        { id: 'drop', description: '' },
        { id: 'park', description: '' },
      ],
    }
    const { decision } = scoreDecision<'keep' | 'drop' | 'park'>({
      spec: THREE_SPEC,
      policy: { fallback: 'drop', minConfidence: 0.99 },
      state: 'some state',
      result: { probs: { keep: 0.6, drop: 0.3, park: 0 }, method: 'logprob', calibrated: true }, // 'park' unseen at the mass level (0 mass ≡ absent)
    })
    expect(decision.abstained).toBe(true)
    expect(decision.top).toBe('keep')
    expect(Object.values(decision.probs).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12)
    expect(decision.probs.park).toBe(0)
    expect(decision.label).toBe('drop')
  })

  it('treats an unusable distribution as an error: no top, fallback label', () => {
    const { decision, event } = scoreDecision(scoring({ result: resultOf({ keep: 0, drop: 0 }) }))
    expect(decision.abstained).toBe(true)
    expect(decision.reason).toBe('error')
    expect(decision.top).toBeNull()
    expect(decision.label).toBe('drop')
    expect(event.top).toBeNull()
  })

  it('labels the top when the policy passes', () => {
    const { decision } = scoreDecision(
      scoring({
        policy: { fallback: 'drop', minConfidence: 0.5 },
        result: resultOf({ keep: 0.95, drop: 0.05 }),
      }),
    )
    expect(decision.abstained).toBe(false)
    expect(decision.label).toBe('keep')
    expect(decision.reason).toBeUndefined()
  })
})

// ============================================================================
// decision-threshold-method (F2)
// ============================================================================

describe('decision-threshold-method', () => {
  it('never applies a logprob-fitted threshold to a Jev read (abstains method-mismatch)', () => {
    // p_max 0.9 with K=2 → confidence 0.8, margin 0.8: the cuts PASS on their
    // numbers, and the decision still abstains because they were fitted for
    // another method.
    const { decision } = scoreDecision(
      scoring({
        policy: { fallback: 'drop', minConfidence: 0.5, minMargin: 0.5 },
        method: 'jev',
        result: resultOf({ keep: 0.9, drop: 0.1 }, { method: 'jev' }),
      }),
    )
    expect(decision.abstained).toBe(true)
    expect(decision.reason).toBe('method-mismatch')
    expect(decision.label).toBe('drop')
  })

  it('same for a verbalized read; default thresholdMethod is logprob', () => {
    const { decision } = scoreDecision(
      scoring({
        policy: { fallback: 'drop', minConfidence: 0.5 },
        method: 'verbalized',
        result: resultOf({ keep: 0.9, drop: 0.1 }, { method: 'verbalized', calibrated: false }),
      }),
    )
    expect(decision.reason).toBe('method-mismatch')
  })

  it('applies the policy cuts when the serving method matches thresholdMethod', () => {
    const pass = scoreDecision(
      scoring({
        policy: { fallback: 'drop', minConfidence: 0.5, thresholdMethod: 'jev' },
        method: 'jev',
        result: resultOf({ keep: 0.9, drop: 0.1 }, { method: 'jev' }),
      }),
    ).decision
    expect(pass.abstained).toBe(false)
    const fail = scoreDecision(
      scoring({
        policy: { fallback: 'drop', minConfidence: 0.9, thresholdMethod: 'jev' },
        method: 'jev',
        result: resultOf({ keep: 0.9, drop: 0.1 }, { method: 'jev' }),
      }),
    ).decision
    expect(fail.abstained).toBe(true)
    expect(fail.reason).toBe('low-confidence')
  })

  it("the applied calibration entry's own cuts win, whatever thresholdMethod says", () => {
    const { decision } = scoreDecision(
      scoring({
        policy: { fallback: 'drop', minConfidence: 0.9, thresholdMethod: 'logprob' },
        method: 'jev',
        calibration: { minConfidence: 0.3 },
        result: resultOf({ keep: 0.9, drop: 0.1 }, { method: 'jev' }),
      }),
    )
    // The static cut (fitted on logprob) would pass on numbers but is a
    // mismatch; the entry's own cut (0.3) wins and the read passes it.
    expect(decision.abstained).toBe(false)
    expect(decision.label).toBe('keep')
  })

  it("the entry's cut overrides only the cut it carries; the policy's other cut still needs a method match", () => {
    const { decision } = scoreDecision(
      scoring({
        policy: {
          fallback: 'drop',
          minConfidence: 0.1,
          minMargin: 0.9,
          thresholdMethod: 'logprob',
        },
        method: 'jev',
        calibration: { minConfidence: 0.05 },
        result: resultOf({ keep: 0.9, drop: 0.1 }, { method: 'jev' }),
      }),
    )
    // minConfidence came from the entry; minMargin has no entry value, the
    // method mismatches, and the policy's margin cannot be applied.
    expect(decision.abstained).toBe(true)
    expect(decision.reason).toBe('method-mismatch')
  })

  it('resolveDecisionCuts: a cut neither policy nor entry defines is no mismatch', () => {
    const cuts = resolveDecisionCuts(
      { fallback: 'drop', thresholdMethod: 'jev' },
      undefined,
      'logprob',
    )
    expect(cuts.minConfidence).toEqual({ value: undefined })
    expect(cuts.minMargin).toEqual({ value: undefined })
    const mismatched = resolveDecisionCuts(
      { fallback: 'drop', minMargin: 0.5, thresholdMethod: 'jev' },
      undefined,
      'logprob',
    )
    expect(mismatched.minMargin).toEqual({ mismatch: true })
  })
})

// ============================================================================
// decision-precall-abstain (F3)
// ============================================================================

describe('decision-precall-abstain', () => {
  it("a requireCalibrated policy on a verbalized client abstains 'uncalibrated' BEFORE the call", () => {
    const reason = preCallAbstain({
      policy: { fallback: 'drop', requireCalibrated: true },
      state: 'some state',
      method: 'verbalized',
    })
    expect(reason).toBe('uncalibrated')
    // The scorer, given the same inputs and NO result, records it: no
    // distribution is invented, the fallback answers.
    const { decision, event } = scoreDecision(
      scoring({
        policy: { fallback: 'drop', requireCalibrated: true },
        method: 'verbalized',
      }),
    )
    expect(decision.abstained).toBe(true)
    expect(decision.reason).toBe('uncalibrated')
    expect(decision.label).toBe('drop')
    expect(decision.top).toBeNull()
    expect(decision.calibrated).toBe(false)
    // The method on the record is the resolved client's — the fact the F3
    // gate refused, not a method that served anything.
    expect(event.method).toBe('verbalized')
    expect(event.stateChars).toBe('some state'.length)
  })

  it('calibratable methods (logprob, Jev) are called; an unknown method is not refused', () => {
    expect(
      preCallAbstain({
        policy: { fallback: 'drop', requireCalibrated: true },
        state: 's',
        method: 'logprob',
      }),
    ).toBeNull()
    expect(
      preCallAbstain({
        policy: { fallback: 'drop', requireCalibrated: true },
        state: 's',
        method: 'jev',
      }),
    ).toBeNull()
    // Unknown: no pre-call refusal — the post-call `calibrated` check decides.
    expect(
      preCallAbstain({ policy: { fallback: 'drop', requireCalibrated: true }, state: 's' }),
    ).toBeNull()
  })

  it("a policy without requireCalibrated never refuses the call; empty state abstains 'no-state'", () => {
    expect(
      preCallAbstain({ policy: { fallback: 'drop' }, state: 's', method: 'verbalized' }),
    ).toBeNull()
    expect(
      preCallAbstain({ policy: { fallback: 'drop', requireCalibrated: true }, state: '' }),
    ).toBe('no-state')
  })
})

// ============================================================================
// decision-always-commit
// ============================================================================

describe('decision-always-commit', () => {
  const { event } = scoreDecision(scoring({ result: resultOf({ keep: 0.9, drop: 0.1 }) }))
  const scope = createScope('typed-decision', {})
  scope.events.push({
    id: 'ev-d1',
    type: 'decision_made' as EventType,
    ts: 1,
    patternId: 'typed-decision',
    data: event,
  })
  const ctxWith = (status: UnifiedContext['status']): UnifiedContext => ({
    sessionId: 's',
    createdAt: 0,
    events: [],
    status,
    data: {},
    input: '',
  })

  it("survives 'on-success' on a ctx in error", () => {
    const ctx = ctxWith('error')
    commitEvents(ctx, scope, 'on-success')
    expect(ctx.events.filter((e) => e.type === 'decision_made')).toHaveLength(1)
  })

  it("survives 'never'", () => {
    const ctx = ctxWith('running')
    commitEvents(ctx, scope, 'never')
    expect(ctx.events.filter((e) => e.type === 'decision_made')).toHaveLength(1)
  })
})

// ============================================================================
// decision-state-sentinel
// ============================================================================

describe('decision-state-sentinel', () => {
  const llmCall = {
    functionName: 'Decide',
    variables: { state: SENTINEL }, // the ONE place the text survives
  }
  const { event } = scoreDecision(
    scoring({ state: SENTINEL, result: resultOf({ keep: 0.9, drop: 0.1 }) }),
  )
  // The event data carries the SIZE, never the text.
  expect(event.stateChars).toBe(SENTINEL.length)
  expect(JSON.stringify(event)).not.toContain(SENTINEL)

  const decisionEvent: ContextEvent = {
    id: 'ev-s1',
    type: 'decision_made' as EventType,
    ts: 2,
    patternId: 'typed-decision',
    data: event,
    llmCall,
  }
  const ctx: UnifiedContext = {
    sessionId: 's',
    createdAt: 0,
    events: [
      { id: 'u1', type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'hi' } },
      decisionEvent,
      { id: 'u2', type: 'user_message', ts: 3, patternId: 'harness', data: { content: 'again' } },
    ],
    status: 'running',
    data: {},
    input: 'again',
  }

  it('is absent from serialize() and both serializeCompact() branches', () => {
    const view = createEventView(ctx).fromAll().unfiltered()
    expect(view.serialize()).not.toContain(SENTINEL)
    expect(view.serialize()).toContain('memory.kind')
    // recentTurns 10 → every event is recent (full formatEvent branch);
    // recentTurns 1 → the decision is older than the last user_message (the
    // non-recent branch). decision_made has no compact form of its own — it
    // renders metadata-only in BOTH branches.
    expect(view.serializeCompact({ recentTurns: 10 })).not.toContain(SENTINEL)
    expect(view.serializeCompact({ recentTurns: 1 })).not.toContain(SENTINEL)
  })

  it('is absent from judge’s projection (judge reads tool_result events only)', () => {
    // judge maps its candidates through JSON.stringify(event.data); a
    // decision_made event is not a tool_result, so it never becomes a
    // candidate. Pin the projection boundary the sentinel would have to cross.
    const candidates = createEventView(ctx).fromAll().ofType('tool_result').get()
    expect(candidates).toHaveLength(0)
  })

  it('survives ONLY in llmCall.variables', () => {
    expect(ctx.events[1].llmCall?.variables.state).toBe(SENTINEL)
    expect(JSON.stringify(ctx.events[1].data)).not.toContain(SENTINEL)
  })

  it('renders the metadata-only line formatEventData owns', () => {
    const rendered = createEventView(ctx).fromAll().unfiltered().serialize()
    expect(rendered).toContain(
      '<decision_made>memory.kind: keep (p=0.900, margin=0.800)</decision_made>',
    )
  })
})

// ============================================================================
// capability field (#418 D12) — the walker; the per-tier probe is T6
// ============================================================================

describe('harnessDecisionKeys', () => {
  const leaf = (
    decisionKeys?: string[],
    name = 'p',
  ): ConfiguredPattern<Record<string, unknown>> => ({
    name,
    fn: async (scope) => scope,
    config: {},
    ...(decisionKeys && { capabilities: { decisionKeys } }),
  })

  it('collects declared keys through the graph, deduplicated, first-seen order', () => {
    const nested: ConfiguredPattern<Record<string, unknown>> = {
      name: 'inner',
      fn: async (s) => s,
      config: {},
      children: [leaf(['memory.kind'], 'inner')],
    }
    const patterns = [leaf(['memory.kind']), nested, leaf(['route'], 'other')]
    expect(harnessDecisionKeys(patterns)).toEqual(['memory.kind', 'route'])
  })

  it('is empty for an undeclared graph', () => {
    expect(harnessDecisionKeys([leaf()])).toEqual([])
    expect(harnessDecisionKeys(undefined)).toEqual([])
  })
})

describe('harnessCalibratedDecisionKeys', () => {
  const leaf = (
    calibratedDecisionKeys?: string[],
    children?: ConfiguredPattern<Record<string, unknown>>[],
  ): ConfiguredPattern<Record<string, unknown>> => ({
    name: 'p',
    fn: async (scope) => scope,
    config: {},
    ...(children && { children }),
    ...(calibratedDecisionKeys && {
      capabilities: { decisionKeys: calibratedDecisionKeys, calibratedDecisionKeys },
    }),
  })

  it('collects the calibration-requiring keys through the graph, deduplicated', () => {
    const plain: ConfiguredPattern<Record<string, unknown>> = {
      name: 'plain',
      fn: async (s) => s,
      config: {},
      capabilities: { decisionKeys: ['route'] },
    }
    const patterns = [leaf(['memory.store.kind']), leaf(undefined, [leaf(['document.injection'])])]
    expect(
      harnessCalibratedDecisionKeys([...patterns, plain, leaf(['memory.store.kind'])]),
    ).toEqual(['memory.store.kind', 'document.injection'])
    // A key that is merely declared is not a calibration-requiring one.
    expect(harnessDecisionKeys([plain])).toEqual(['route'])
    expect(harnessCalibratedDecisionKeys([plain])).toEqual([])
  })

  it('is empty for an undeclared or absent graph', () => {
    expect(harnessCalibratedDecisionKeys([leaf()])).toEqual([])
    expect(harnessCalibratedDecisionKeys(undefined)).toEqual([])
  })
})

// ============================================================================
// constants
// ============================================================================

describe('MAX_DECISION_LABELS', () => {
  it('is 20 — vLLM’s default --max-logprobs (D13)', () => {
    expect(MAX_DECISION_LABELS).toBe(20)
  })
})
