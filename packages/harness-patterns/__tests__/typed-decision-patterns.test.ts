/**
 * #418 slice T2 — the awaited wrapper (`evaluateDecision` / `decide` /
 * `decideFields`), the `typedDecision` chain step and `decisionRouter`.
 *
 * Every test names the source mutation that reddens it; every one was run —
 * see the PR's pin/mutation table. The pins:
 *
 *   decide-never-throws          — a seam that throws, returns junk, or whose
 *                                  `serving` throws is an abstained decision on
 *                                  the fallback, never a throw; one
 *                                  `decision_made`, one `error` when failed
 *   decision-precall-abstain     — (F3, zero-calls half) `requireCalibrated` on
 *                                  a knowingly verbalized client makes NO call
 *   decision-serving             — `DecideFn.serving`: ABSENT removes only the
 *                                  pre-call shortcut (the post-call
 *                                  `method-mismatch` still fires); PRESENT, its
 *                                  calibration entry's cuts win
 *   decision-no-stale            — `typedDecision` overwrites
 *                                  `data.decisions[key]` on EVERY exit
 *   decide-fields-shared-prefix  — `mode: 'fields'` sends byte-identical state
 *                                  per field; joint marginalises to per-field
 *                                  probs summing to 1
 *   decision-joint-refused       — a `mode: 'joint'` product > 20 throws
 *   decision-decidefields-events — one `decision_made` per field; one `error`
 *                                  per failed set
 *   decisionRouter               — `routes()` never sees an undefined route;
 *                                  never sets `DIRECT_RESPONSE_ROUTE`;
 *                                  `preserveIntent: false` clears; shadow sets
 *                                  nothing
 *   decision-state-sentinel      — (SD-3, T2 paths) no entry point copies the
 *                                  state into an event, on any outcome
 *   decision-seam-structural     — `classifierFromDecide(raw seam)` typechecks;
 *                                  a policy-applying wrapper does not
 */

import { describe, expect, it } from 'vitest'
import {
  assertDecisionSetSpec,
  decide,
  decideFields,
  decisionRouter,
  evaluateDecision,
  typedDecision,
  type TypedDecisionData,
} from '@hames-ai/harness-patterns/patterns/typedDecision.server'
import { configurePattern, runChain } from '@hames-ai/harness-patterns/patterns/chain.server'
import { routes, type RouterData } from '@hames-ai/harness-patterns/patterns/router.server'
import { createContext, createScope } from '@hames-ai/harness-patterns/context.server'
import {
  harnessCalibratedDecisionKeys,
  harnessDecisionKeys,
} from '@hames-ai/harness-patterns/pattern-capabilities'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import {
  classifierFromDecide,
  DOCUMENT_INJECTION_DECISION,
} from '@hames-ai/harness-patterns/stash/document-sanitizer.server'
import {
  DIRECT_RESPONSE_ROUTE,
  LLMCallError,
  type ContextEvent,
  type DecideAllFn,
  type DecideFn,
  type DecideResult,
  type DecisionMadeEventData,
  type DecisionPolicy,
  type DecisionSetSpec,
  type DecisionSpec,
  type ErrorEventData,
  type LLMCallRecord,
} from '@hames-ai/harness-patterns/types'

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

type YesNo = 'yes' | 'no'
const SPEC: DecisionSpec<YesNo> = {
  key: 'memory.recall',
  question: 'Does this need memory?',
  labels: [
    { id: 'yes', description: 'needs memory' },
    { id: 'no', description: 'does not' },
  ],
}
const POLICY: DecisionPolicy<YesNo> = { fallback: 'no' }

const record = (name = 'Decide'): LLMCallRecord => ({
  functionName: name,
  variables: { state: 'S' },
  rawOutput: 'B',
})

/** A fake raw seam: counts calls, records every argument, answers `answer`. */
function fakeDecide(
  answer: (input: { spec: DecisionSpec; state: string }) => unknown,
  extras?: Pick<DecideFn, 'serving' | 'limits'>,
) {
  const calls: Array<{ spec: DecisionSpec; state: string }> = []
  const fn = (async (input: { spec: DecisionSpec; state: string }) => {
    calls.push(input)
    return answer(input)
  }) as unknown as DecideFn
  Object.assign(fn, extras)
  return { fn, calls }
}

const logprobResult = (probs: Record<string, number>, extra?: Partial<DecideResult>) =>
  ({ probs, method: 'logprob', calibrated: true, ...extra }) as DecideResult

const typesOf = (events: ContextEvent[]) => events.map((e) => e.type)
const ofType = (events: ContextEvent[], type: string) => events.filter((e) => e.type === type)
const runInFrame = <T>(fn: () => Promise<T>): Promise<T> => withRunFrame({}, fn)

// ============================================================================
// decide-never-throws
// ============================================================================

describe('decide-never-throws', () => {
  it('a seam that throws an Error is an abstained decision on the fallback, one decision_made + one error', async () => {
    const { fn } = fakeDecide(() => {
      throw new Error('upstream 503')
    })
    const scope = createScope('p', {})
    const d = await decide(scope, { decide: fn, spec: SPEC, state: 'hello', policy: POLICY })

    expect(d).toMatchObject({ label: 'no', abstained: true, reason: 'error', top: null })
    expect(typesOf(scope.events)).toEqual(['decision_made', 'error'])
    const err = scope.events[1].data as ErrorEventData
    expect(err.error).toBe('upstream 503')
    expect(err.severity).toBe('recoverable')
  })

  it('stamps the caller-chosen severity on the error event', async () => {
    const { fn } = fakeDecide(() => {
      throw new Error('x')
    })
    const scope = createScope('p', {})
    await decide(
      scope,
      { decide: fn, spec: SPEC, state: 's', policy: POLICY },
      { errorSeverity: 'irrecoverable' },
    )
    expect((ofType(scope.events, 'error')[0].data as ErrorEventData).severity).toBe('irrecoverable')
  })

  it('an LLMCallError carries its record on the ERROR event (kind llm_call), not on decision_made', async () => {
    const call = record()
    const { fn } = fakeDecide(() => {
      throw new LLMCallError('parse failed', call)
    })
    const scope = createScope('p', {})
    await decide(scope, { decide: fn, spec: SPEC, state: 's', policy: POLICY })

    const [made, err] = scope.events
    expect(made.llmCall).toBeUndefined()
    expect(err.llmCall).toBe(call)
    expect((err.data as ErrorEventData).kind).toBe('llm_call')
  })

  it('a non-Error throw is still an abstained error', async () => {
    const { fn } = fakeDecide(() => {
      throw 'plain string'
    })
    const d = await decide(createScope('p', {}), {
      decide: fn,
      spec: SPEC,
      state: 's',
      policy: POLICY,
    })
    expect(d).toMatchObject({ abstained: true, reason: 'error', label: 'no' })
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'B'],
    ['probs null', { probs: null, method: 'logprob', calibrated: true }],
    ['probs NaN', { probs: { yes: NaN, no: NaN }, method: 'logprob', calibrated: true }],
    ['probs all zero', { probs: { yes: 0, no: 0 }, method: 'logprob', calibrated: true }],
    ['probs for no known label', { probs: { maybe: 1 }, method: 'logprob', calibrated: true }],
  ])(
    'a seam returning junk (%s) abstains with an error event and never throws',
    async (_n, junk) => {
      const { fn } = fakeDecide(() => junk)
      const scope = createScope('p', {})
      const d = await decide(scope, { decide: fn, spec: SPEC, state: 's', policy: POLICY })

      expect(d).toMatchObject({ abstained: true, reason: 'error', label: 'no' })
      expect(typesOf(scope.events)).toEqual(['decision_made', 'error'])
    },
  )

  it('an unusable readout keeps its call record on decision_made (the cost is counted once)', async () => {
    const call = record()
    const { fn } = fakeDecide(() => logprobResult({ yes: 0, no: 0 }, { llmCall: call }))
    const scope = createScope('p', {})
    await decide(scope, { decide: fn, spec: SPEC, state: 's', policy: POLICY })

    const withCall = scope.events.filter((e) => e.llmCall)
    expect(withCall).toHaveLength(1)
    expect(withCall[0].type).toBe('decision_made')
  })

  it('a throwing `serving` loses only the pre-call shortcut: the call is still made', async () => {
    const { fn, calls } = fakeDecide(() => logprobResult({ yes: 0.9, no: 0.1 }), {
      serving: () => {
        throw new Error('registry down')
      },
    })
    const d = await decide(createScope('p', {}), {
      decide: fn,
      spec: SPEC,
      state: 's',
      policy: POLICY,
    })
    expect(calls).toHaveLength(1)
    expect(d.label).toBe('yes')
  })

  it('evaluateDecision is scope-free and never rejects', async () => {
    const { fn } = fakeDecide(() => {
      throw new Error('boom')
    })
    const out = await evaluateDecision({ decide: fn, spec: SPEC, state: 's', policy: POLICY })
    expect(out.decision).toMatchObject({ abstained: true, reason: 'error', label: 'no' })
    expect(out.error?.error).toBe('boom')
    expect(out.event.stateChars).toBe(1)
  })

  it('a pass records exactly one decision_made, stamps eventId and carries the call record', async () => {
    const call = record()
    const { fn } = fakeDecide(() => logprobResult({ yes: 0.9, no: 0.1 }, { llmCall: call }))
    const scope = createScope('p', {})
    const d = await decide(scope, {
      decide: fn,
      spec: SPEC,
      state: 'state text',
      policy: POLICY,
      shadow: true,
    })

    expect(typesOf(scope.events)).toEqual(['decision_made'])
    expect(d.label).toBe('yes')
    expect(d.eventId).toBe(scope.events[0].id)
    expect(scope.events[0].llmCall).toBe(call)
    const data = scope.events[0].data as DecisionMadeEventData
    expect(data.shadow).toBe(true)
    expect(data.stateChars).toBe('state text'.length)
    expect(JSON.stringify(scope.events[0].data)).not.toContain('state text')
  })

  it('trackHistory filters decision_made (no eventId) but never the error', async () => {
    const { fn } = fakeDecide(() => {
      throw new Error('x')
    })
    const scope = createScope('p', {})
    const d = await decide(
      scope,
      { decide: fn, spec: SPEC, state: 's', policy: POLICY },
      { trackHistory: false },
    )
    expect(typesOf(scope.events)).toEqual(['error'])
    expect(d.eventId).toBeUndefined()
  })
})

// ============================================================================
// decision-precall-abstain — the zero-calls half
// ============================================================================

describe('decision-precall-abstain (zero LLM calls)', () => {
  const calibratedOnly: DecisionPolicy<YesNo> = { fallback: 'no', requireCalibrated: true }

  it('requireCalibrated on a knowingly verbalized client abstains WITHOUT calling', async () => {
    const { fn, calls } = fakeDecide(() => logprobResult({ yes: 1, no: 0 }), {
      serving: () => ({ method: 'verbalized' }),
    })
    const scope = createScope('p', {})
    const d = await decide(scope, { decide: fn, spec: SPEC, state: 's', policy: calibratedOnly })

    expect(calls).toHaveLength(0)
    expect(d).toMatchObject({ abstained: true, reason: 'uncalibrated', label: 'no' })
    expect(typesOf(scope.events)).toEqual(['decision_made'])
  })

  it('an empty state abstains no-state WITHOUT calling', async () => {
    const { fn, calls } = fakeDecide(() => logprobResult({ yes: 1, no: 0 }))
    const d = await decide(createScope('p', {}), {
      decide: fn,
      spec: SPEC,
      state: '',
      policy: POLICY,
    })
    expect(calls).toHaveLength(0)
    expect(d).toMatchObject({ abstained: true, reason: 'no-state' })
  })

  it('a calibratable client (jev) IS called under requireCalibrated', async () => {
    const { fn, calls } = fakeDecide(
      () => logprobResult({ yes: 0.95, no: 0.05 }, { method: 'jev' }),
      { serving: () => ({ method: 'jev', calibration: { minConfidence: 0.5 } }) },
    )
    const d = await decide(createScope('p', {}), {
      decide: fn,
      spec: SPEC,
      state: 's',
      policy: calibratedOnly,
    })
    expect(calls).toHaveLength(1)
    expect(d.label).toBe('yes')
  })
})

// ============================================================================
// decision-serving — absent and present
// ============================================================================

describe('decision-serving', () => {
  const fitted: DecisionPolicy<YesNo> = { fallback: 'no', minConfidence: 0.5 } // logprob-fitted

  it('ABSENT: a logprob read still applies the logprob-fitted cut (no false mismatch)', async () => {
    const { fn } = fakeDecide(() => logprobResult({ yes: 0.9, no: 0.1 }))
    const d = await decide(createScope('p', {}), {
      decide: fn,
      spec: SPEC,
      state: 's',
      policy: fitted,
    })
    expect(d).toMatchObject({ abstained: false, label: 'yes', method: 'logprob' })
  })

  it('ABSENT: a jev read still abstains method-mismatch POST-call — only the pre-call shortcut is lost', async () => {
    const { fn, calls } = fakeDecide(() =>
      logprobResult({ yes: 0.99, no: 0.01 }, { method: 'jev' }),
    )
    const d = await decide(createScope('p', {}), {
      decide: fn,
      spec: SPEC,
      state: 's',
      policy: fitted,
    })
    expect(calls).toHaveLength(1) // it was called…
    expect(d).toMatchObject({ abstained: true, reason: 'method-mismatch', label: 'no' }) // …and checked
  })

  it('ABSENT: a verbalized, uncalibrated read still abstains uncalibrated post-call', async () => {
    const { fn, calls } = fakeDecide(() =>
      logprobResult({ yes: 0.99, no: 0.01 }, { method: 'verbalized', calibrated: false }),
    )
    const d = await decide(createScope('p', {}), {
      decide: fn,
      spec: SPEC,
      state: 's',
      policy: { fallback: 'no', requireCalibrated: true },
    })
    expect(calls).toHaveLength(1)
    expect(d).toMatchObject({ abstained: true, reason: 'uncalibrated' })
  })

  it("PRESENT: the calibration entry's own cuts WIN over the policy's (a jev read passes on the entry's cut)", async () => {
    const { fn } = fakeDecide(() => logprobResult({ yes: 0.9, no: 0.1 }, { method: 'jev' }), {
      serving: (key) => {
        expect(key).toBe(SPEC.key)
        return { method: 'jev', calibration: { minConfidence: 0.3, minMargin: 0.2 } }
      },
    })
    const d = await decide(createScope('p', {}), {
      decide: fn,
      spec: SPEC,
      state: 's',
      policy: fitted,
    })
    expect(d).toMatchObject({ abstained: false, label: 'yes', method: 'jev' })
  })

  it("PRESENT: and a stricter entry cut abstains where the policy's would have passed", async () => {
    const { fn } = fakeDecide(() => logprobResult({ yes: 0.9, no: 0.1 }, { method: 'jev' }), {
      serving: () => ({ method: 'jev', calibration: { minConfidence: 0.95 } }),
    })
    const d = await decide(createScope('p', {}), {
      decide: fn,
      spec: SPEC,
      state: 's',
      policy: fitted,
    })
    expect(d).toMatchObject({ abstained: true, reason: 'low-confidence' })
  })
})

// ============================================================================
// typedDecision + decision-no-stale
// ============================================================================

type Data = Record<string, unknown> & TypedDecisionData & RouterData

const STALE = {
  key: SPEC.key,
  label: 'yes',
  top: 'yes',
  probs: { yes: 1, no: 0 },
  margin: 1,
  confidence: 1,
  abstained: false,
  calibrated: true,
} as const

async function runPattern(
  pattern: ReturnType<typeof typedDecision<Data, YesNo>>,
  seed: Data = {},
  after: Array<ReturnType<typeof configurePattern<Data>>> = [],
) {
  const ctx = createContext<Data>('what did we decide last week?', seed)
  await runInFrame(() => runChain(ctx, [pattern, ...after]))
  return ctx
}

describe('decision-no-stale', () => {
  it('a pass replaces last turn’s verdict', async () => {
    const { fn } = fakeDecide(() => logprobResult({ yes: 0.1, no: 0.9 }))
    const ctx = await runPattern(
      typedDecision<Data, YesNo>({ decide: fn, spec: SPEC, policy: POLICY }),
      {
        decisions: { [SPEC.key]: { ...STALE } },
      },
    )
    expect(ctx.data.decisions?.[SPEC.key]).toMatchObject({ label: 'no', abstained: false })
  })

  it('a FAILED call replaces it with the abstained fallback — never last turn’s yes', async () => {
    const { fn } = fakeDecide(() => {
      throw new Error('upstream down')
    })
    const ctx = await runPattern(
      typedDecision<Data, YesNo>({ decide: fn, spec: SPEC, policy: POLICY }),
      {
        decisions: { [SPEC.key]: { ...STALE } },
      },
    )
    expect(ctx.data.decisions?.[SPEC.key]).toMatchObject({
      label: 'no',
      abstained: true,
      reason: 'error',
    })
  })

  it('a state builder that throws still replaces it (no-state) and records the failure', async () => {
    const { fn, calls } = fakeDecide(() => logprobResult({ yes: 1, no: 0 }))
    const ctx = await runPattern(
      typedDecision<Data, YesNo>({
        decide: fn,
        spec: SPEC,
        policy: POLICY,
        state: () => {
          throw new Error('builder broke')
        },
      }),
      { decisions: { [SPEC.key]: { ...STALE } } },
    )
    expect(calls).toHaveLength(0)
    expect(ctx.data.decisions?.[SPEC.key]).toMatchObject({ abstained: true, reason: 'no-state' })
    const errors = ofType(ctx.events, 'error').map((e) => (e.data as ErrorEventData).error)
    expect(errors.some((m) => m.includes('builder broke'))).toBe(true)
  })

  it('leaves other keys’ verdicts alone', async () => {
    const { fn } = fakeDecide(() => logprobResult({ yes: 0.9, no: 0.1 }))
    const other = { ...STALE, key: 'other.key' }
    const ctx = await runPattern(
      typedDecision<Data, YesNo>({ decide: fn, spec: SPEC, policy: POLICY }),
      {
        decisions: { 'other.key': other },
      },
    )
    expect(ctx.data.decisions?.['other.key']).toEqual(other)
    expect(ctx.data.decisions?.[SPEC.key]?.label).toBe('yes')
  })

  it('a failed decision is recoverable by default: the chain keeps going', async () => {
    const { fn } = fakeDecide(() => {
      throw new Error('x')
    })
    const ran: string[] = []
    const marker = configurePattern<Data>('after', async (s) => (ran.push('after'), s))
    await runPattern(typedDecision<Data, YesNo>({ decide: fn, spec: SPEC, policy: POLICY }), {}, [
      marker,
    ])
    expect(ran).toEqual(['after'])
  })

  it('the default state is the window’s user messages + FINAL assistant messages, oldest trimmed', async () => {
    const { fn, calls } = fakeDecide(() => logprobResult({ yes: 0.9, no: 0.1 }))
    const ctx = createContext<Data>('and today?')
    ctx.events.unshift(
      { type: 'user_message', ts: 1, patternId: 'x', data: { content: 'earlier question' } },
      {
        type: 'assistant_message',
        ts: 2,
        patternId: 'x',
        data: { content: 'Looking into that…' }, // router status: NOT final
      },
      {
        type: 'assistant_message',
        ts: 3,
        patternId: 'x',
        data: { content: '<think>hidden</think>earlier answer', final: true },
      },
    )
    await runInFrame(() =>
      runChain(ctx, [typedDecision<Data, YesNo>({ decide: fn, spec: SPEC, policy: POLICY })]),
    )
    const state = calls[0].state
    expect(state).toContain('User: earlier question')
    expect(state).toContain('Assistant: earlier answer')
    expect(state).toContain('User: and today?')
    expect(state).not.toContain('Looking into that')
    expect(state).not.toContain('hidden')
  })

  it('declares its decision key, and carries the four pattern defaults', () => {
    const { fn } = fakeDecide(() => logprobResult({ yes: 1, no: 0 }))
    const p = typedDecision<Data, YesNo>({ decide: fn, spec: SPEC, policy: POLICY })
    expect(harnessDecisionKeys([p])).toEqual([SPEC.key])
    expect(p.config).toMatchObject({
      commitStrategy: 'always',
      trackHistory: 'decision_made',
      errorSeverity: 'recoverable',
    })
    expect(p.estimateTurns?.({ maxToolTurns: 9, maxRetries: 2 })).toBe(1)
    const r = decisionRouter<Data>({ a: 'A' }, { decide: fn, policy: { fallback: 'a' } })
    expect(r.config).toMatchObject({
      commitStrategy: 'always',
      trackHistory: 'decision_made',
      errorSeverity: 'irrecoverable',
    })
    expect(harnessDecisionKeys([r])).toEqual(['route'])
  })

  // G4 (#418 T6): the probe warns only about keys that abstain forever without
  // an entry, so the pattern says which of its keys those are.
  it('declares calibratedDecisionKeys only when its policy requires calibration', () => {
    const { fn } = fakeDecide(() => logprobResult({ yes: 1, no: 0 }))
    const plain = typedDecision<Data, YesNo>({ decide: fn, spec: SPEC, policy: POLICY })
    const strict = typedDecision<Data, YesNo>({
      decide: fn,
      spec: SPEC,
      policy: { ...POLICY, requireCalibrated: true },
    })
    expect(harnessCalibratedDecisionKeys([plain])).toEqual([])
    expect(harnessCalibratedDecisionKeys([strict])).toEqual([SPEC.key])
    // `decisionKeys` is untouched by the new field: both still declare the key.
    expect(harnessDecisionKeys([plain, strict])).toEqual([SPEC.key])

    const router = decisionRouter<Data>(
      { a: 'A' },
      { decide: fn, policy: { fallback: 'a', requireCalibrated: true } },
    )
    expect(harnessCalibratedDecisionKeys([router])).toEqual(['route'])
    expect(
      harnessCalibratedDecisionKeys([
        decisionRouter<Data>({ a: 'A' }, { decide: fn, policy: { fallback: 'a' } }),
      ]),
    ).toEqual([])
  })

  it('refuses a fallback that is not one of its labels, at construction', () => {
    const { fn } = fakeDecide(() => logprobResult({ yes: 1, no: 0 }))
    expect(() =>
      typedDecision<Data, string>({ decide: fn, spec: SPEC, policy: { fallback: 'maybe' } }),
    ).toThrow(/fallback 'maybe'/)
  })
})

// ============================================================================
// decideFields
// ============================================================================

type Mem = { target: 'user' | 'none'; kind: 'episodic' | 'semantic' | 'trait' }
const SET: DecisionSetSpec<Mem> = {
  key: 'memory.store',
  fields: {
    target: {
      key: 'memory.store.target',
      question: 'Who is it about?',
      labels: [
        { id: 'user', description: 'the user' },
        { id: 'none', description: 'nothing' },
      ],
    },
    kind: {
      key: 'memory.store.kind',
      question: 'What kind?',
      labels: [
        { id: 'episodic', description: 'an event' },
        { id: 'semantic', description: 'a fact' },
        { id: 'trait', description: 'a trait' },
      ],
    },
  },
}
const SET_POLICY = {
  target: { fallback: 'none' },
  kind: { fallback: 'episodic' },
} as const

const bySpec = (probs: Record<string, Record<string, number>>) => (i: { spec: DecisionSpec }) =>
  logprobResult(probs[i.spec.key])

describe('decide-fields-shared-prefix', () => {
  it("mode 'fields' sends BYTE-IDENTICAL state to every pass, one pass per field, in order", async () => {
    const { fn, calls } = fakeDecide(
      bySpec({
        'memory.store.target': { user: 0.9, none: 0.1 },
        'memory.store.kind': { episodic: 0.1, semantic: 0.8, trait: 0.1 },
      }),
    )
    const state = 'user: I moved to Ghent\nassistant: noted'
    const out = await decideFields(createScope('p', {}), {
      decide: fn,
      set: SET,
      state,
      policy: SET_POLICY,
    })

    expect(calls.map((c) => c.state)).toEqual([state, state])
    expect(calls.map((c) => c.spec.key)).toEqual(['memory.store.target', 'memory.store.kind'])
    expect(out.target.label).toBe('user')
    expect(out.kind.label).toBe('semantic')
  })

  it("mode 'joint' scores the product in ONE pass and marginalises to per-field probs summing to 1", async () => {
    const jointSet: DecisionSetSpec<Mem> = { ...SET, mode: 'joint' }
    const { fn, calls } = fakeDecide((i) => {
      // 2×3 = 6 combos; mass on (user,semantic) 0.6, (user,episodic) 0.2,
      // (none,trait) 0.1, (none,episodic) 0.1.
      expect(i.spec.labels).toHaveLength(6)
      return logprobResult({
        'user | semantic': 0.6,
        'user | episodic': 0.2,
        'none | trait': 0.1,
        'none | episodic': 0.1,
      })
    })
    const out = await decideFields(createScope('p', {}), {
      decide: fn,
      set: jointSet,
      state: 's',
      policy: SET_POLICY,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].spec.key).toBe('memory.store')
    expect(out.target.probs.user).toBeCloseTo(0.8, 10)
    expect(out.target.probs.none).toBeCloseTo(0.2, 10)
    expect(out.kind.probs.semantic).toBeCloseTo(0.6, 10)
    expect(out.kind.probs.episodic).toBeCloseTo(0.3, 10)
    expect(out.kind.probs.trait).toBeCloseTo(0.1, 10)
    for (const d of [out.target, out.kind]) {
      expect(Object.values(d.probs).reduce((a, b) => a + (b as number), 0)).toBeCloseTo(1, 10)
    }
    expect([out.target.label, out.kind.label]).toEqual(['user', 'semantic'])
  })

  it('a one-call provider (decideAll) answers the whole set in ONE request, `decide` untouched', async () => {
    const { fn, calls } = fakeDecide(() => logprobResult({ user: 1, none: 0 }))
    const allCalls: unknown[] = []
    const decideAll = (async (input: { spec: DecisionSetSpec<Mem>; state: string }) => {
      allCalls.push(input)
      return {
        fields: {
          target: logprobResult({ user: 0.9, none: 0.1 }, { method: 'jev' }),
          kind: logprobResult({ episodic: 0.05, semantic: 0.9, trait: 0.05 }, { method: 'jev' }),
        },
      }
    }) as unknown as DecideAllFn
    const out = await decideFields(createScope('p', {}), {
      decide: fn,
      decideAll,
      set: SET,
      state: 's',
      policy: { target: { fallback: 'none' }, kind: { fallback: 'episodic' } },
    })
    expect(allCalls).toHaveLength(1)
    expect(calls).toHaveLength(0)
    // jev vs the default 'logprob' thresholdMethod, no static cuts → nothing to mismatch
    expect([out.target.label, out.kind.label]).toEqual(['user', 'semantic'])
  })

  it('a field refused pre-call (requireCalibrated on a verbalized client) is left out of the set call', async () => {
    const { fn } = fakeDecide(() => logprobResult({ user: 1, none: 0 }))
    const seen: string[][] = []
    const decideAll = (async (input: { spec: DecisionSetSpec<Mem> }) => {
      seen.push(Object.keys(input.spec.fields))
      return { fields: { target: logprobResult({ user: 0.9, none: 0.1 }, { method: 'jev' }) } }
    }) as unknown as DecideAllFn
    decideAll.serving = (key) => ({
      method: key === 'memory.store.kind' ? 'verbalized' : 'jev',
    })
    const out = await decideFields(createScope('p', {}), {
      decide: fn,
      decideAll,
      set: SET,
      state: 's',
      policy: {
        target: { fallback: 'none' },
        kind: { fallback: 'episodic', requireCalibrated: true },
      },
    })
    expect(seen).toEqual([['target']])
    expect(out.kind).toMatchObject({ abstained: true, reason: 'uncalibrated', label: 'episodic' })
  })

  it('one field failing in fields mode does not fail the others', async () => {
    const { fn } = fakeDecide((i) => {
      if (i.spec.key === 'memory.store.target') throw new Error('target failed')
      return logprobResult({ episodic: 0.1, semantic: 0.1, trait: 0.8 })
    })
    const scope = createScope('p', {})
    const out = await decideFields(scope, { decide: fn, set: SET, state: 's', policy: SET_POLICY })
    expect(out.target).toMatchObject({ abstained: true, reason: 'error', label: 'none' })
    expect(out.kind).toMatchObject({ abstained: false, label: 'trait' })
    expect(ofType(scope.events, 'error')).toHaveLength(1)
  })
})

describe('decision-joint-refused', () => {
  const widen = (counts: number[]): DecisionSetSpec<Record<string, string>> => ({
    key: 'wide',
    mode: 'joint',
    fields: Object.fromEntries(
      counts.map((n, i) => [
        `f${i}`,
        {
          key: `wide.f${i}`,
          question: 'q',
          labels: Array.from({ length: n }, (_, j) => ({ id: `l${j}`, description: '' })),
        },
      ]),
    ),
  })

  it('a joint product above MAX_DECISION_LABELS throws, before any call', async () => {
    const set = widen([3, 7]) // 21
    expect(() => assertDecisionSetSpec(set)).toThrow(/MAX_DECISION_LABELS/)
    const { fn, calls } = fakeDecide(() => logprobResult({}))
    await expect(
      decideFields(createScope('p', {}), {
        decide: fn,
        set,
        state: 's',
        policy: { f0: { fallback: 'l0' }, f1: { fallback: 'l0' } },
      }),
    ).rejects.toThrow(/joint/)
    expect(calls).toHaveLength(0)
  })

  it('a product of exactly 20 is allowed, and a wide set in fields mode is not a joint product', () => {
    expect(() => assertDecisionSetSpec(widen([4, 5]))).not.toThrow()
    expect(() => assertDecisionSetSpec({ ...widen([4, 6]), mode: 'fields' })).not.toThrow()
    expect(() => assertDecisionSetSpec({ ...widen([4, 6]), mode: undefined })).not.toThrow()
  })
})

describe('decision-decidefields-events', () => {
  it('records ONE decision_made per field, in field order, each under its own key', async () => {
    const { fn } = fakeDecide(
      bySpec({
        'memory.store.target': { user: 0.9, none: 0.1 },
        'memory.store.kind': { episodic: 0.1, semantic: 0.8, trait: 0.1 },
      }),
    )
    const scope = createScope('p', {})
    const out = await decideFields(scope, { decide: fn, set: SET, state: 's', policy: SET_POLICY })

    expect(typesOf(scope.events)).toEqual(['decision_made', 'decision_made'])
    expect(scope.events.map((e) => (e.data as DecisionMadeEventData).key)).toEqual([
      'memory.store.target',
      'memory.store.kind',
    ])
    expect(out.target.eventId).toBe(scope.events[0].id)
    expect(out.kind.eventId).toBe(scope.events[1].id)
  })

  it('a set-wide failure records one decision_made per field and exactly ONE error', async () => {
    const call = record('DecideAll')
    const decideAll = (async () => {
      throw new LLMCallError('jev 500', call)
    }) as unknown as DecideAllFn
    const { fn } = fakeDecide(() => logprobResult({}))
    const scope = createScope('p', {})
    const out = await decideFields(scope, {
      decide: fn,
      decideAll,
      set: SET,
      state: 's',
      policy: SET_POLICY,
    })

    expect(typesOf(scope.events).filter((t) => t === 'decision_made')).toHaveLength(2)
    expect(ofType(scope.events, 'error')).toHaveLength(1)
    expect(scope.events.filter((e) => e.llmCall)).toHaveLength(1) // counted once
    expect([out.target.reason, out.kind.reason]).toEqual(['error', 'error'])
    expect([out.target.label, out.kind.label]).toEqual(['none', 'episodic'])
  })

  it('a record shared across the set’s results is attached to ONE event', async () => {
    const shared = record('DecideAll')
    const decideAll = (async () => ({
      fields: {
        target: logprobResult({ user: 0.9, none: 0.1 }, { llmCall: shared }),
        kind: logprobResult({ episodic: 0.1, semantic: 0.8, trait: 0.1 }, { llmCall: shared }),
      },
    })) as unknown as DecideAllFn
    const { fn } = fakeDecide(() => logprobResult({}))
    const scope = createScope('p', {})
    await decideFields(scope, { decide: fn, decideAll, set: SET, state: 's', policy: SET_POLICY })
    expect(scope.events.filter((e) => e.llmCall)).toHaveLength(1)
  })
})

// ============================================================================
// decisionRouter
// ============================================================================

const ROUTES = { neo4j: 'graph queries', web: 'web lookups' }

/** A raw seam that picks a route by id with the given mass. */
const picks = (id: string, p = 0.95) =>
  fakeDecide((i) => {
    const ids = i.spec.labels.map((l) => l.id)
    const rest = (1 - p) / Math.max(1, ids.length - 1)
    return logprobResult(Object.fromEntries(ids.map((l) => [l, l === id ? p : rest])))
  })

async function runRouter(
  router: ReturnType<typeof decisionRouter<Data>>,
  seed: Data = {},
  input = 'show me the graph',
) {
  const ran: string[] = []
  const dispatch = (name: string) =>
    configurePattern<Data>(name, async (scope) => (ran.push(name), scope), { patternId: name })
  const ctx = createContext<Data>(input, seed)
  await runInFrame(() =>
    runChain(ctx, [
      router,
      routes<Data>({ neo4j: dispatch('neo4j'), web: dispatch('web'), chat: dispatch('chat') }),
    ]),
  )
  return { ctx, ran }
}

describe('decisionRouter', () => {
  it('sets the decided route, writes the decision, and routes() dispatches it', async () => {
    const { fn } = picks('web')
    const { ctx, ran } = await runRouter(
      decisionRouter<Data>(ROUTES, { decide: fn, policy: { fallback: 'neo4j' } }),
    )
    expect(ctx.data.route).toBe('web')
    expect(ctx.data.decisions?.route).toMatchObject({ label: 'web', abstained: false })
    expect(ran).toEqual(['web'])
  })

  it('an abstain that is not a failure continues on the fallback ROUTE — routes() never sees undefined', async () => {
    const { fn } = picks('web', 0.55) // confidence ≈ 0.1, under the cut
    const { ctx, ran } = await runRouter(
      decisionRouter<Data>(ROUTES, {
        decide: fn,
        policy: { fallback: 'neo4j', minConfidence: 0.5 },
      }),
    )
    expect(ctx.data.route).toBe('neo4j')
    expect(ctx.data.decisions?.route).toMatchObject({ abstained: true, reason: 'low-confidence' })
    expect(ran).toEqual(['neo4j'])
  })

  it('NEVER sets DIRECT_RESPONSE_ROUTE: the conversational route is an ordinary key routes() dispatches', async () => {
    const { fn } = picks('chat')
    const { ctx, ran } = await runRouter(
      decisionRouter<Data>(ROUTES, {
        decide: fn,
        policy: { fallback: 'chat' },
        conversationalRoute: { name: 'chat', description: 'no tool — just answer' },
      }),
    )
    expect(ctx.data.route).toBe('chat')
    expect(ctx.data.route).not.toBe(DIRECT_RESPONSE_ROUTE)
    expect(ran).toEqual(['chat']) // dispatched, not skipped as a direct reply
  })

  it('refuses, at construction, a route named like the direct-response sentinel, a duplicate, or a fallback that is no route', () => {
    const { fn } = picks('web')
    expect(() =>
      decisionRouter<Data>(
        { ...ROUTES, [DIRECT_RESPONSE_ROUTE]: 'x' },
        { decide: fn, policy: { fallback: 'neo4j' } },
      ),
    ).toThrow(/direct-response sentinel/)
    expect(() =>
      decisionRouter<Data>(ROUTES, {
        decide: fn,
        policy: { fallback: 'neo4j' },
        conversationalRoute: { name: 'web', description: 'dup' },
      }),
    ).toThrow(/unique/)
    expect(() =>
      decisionRouter<Data>(ROUTES, { decide: fn, policy: { fallback: 'nowhere' } }),
    ).toThrow(/fallback 'nowhere'/)
  })

  it('preserveIntent: false (default) clears a carried-over intent; true leaves it', async () => {
    const { fn } = picks('web')
    const cleared = await runRouter(
      decisionRouter<Data>(ROUTES, { decide: fn, policy: { fallback: 'neo4j' } }),
      { intent: 'OLD ROUTER INTENT' },
    )
    expect(cleared.ctx.data.intent).toBeUndefined()

    const kept = await runRouter(
      decisionRouter<Data>(ROUTES, {
        decide: fn,
        policy: { fallback: 'neo4j' },
        preserveIntent: true,
      }),
      { intent: 'compacted intent' },
    )
    expect(kept.ctx.data.intent).toBe('compacted intent')
  })

  it('a FAILED decision defaults to irrecoverable (router parity): route + intent cleared, the chain stops before routes()', async () => {
    const { fn } = fakeDecide(() => {
      throw new Error('decision backend down')
    })
    const { ctx, ran } = await runRouter(
      decisionRouter<Data>(ROUTES, { decide: fn, policy: { fallback: 'neo4j' } }),
      { route: 'web', intent: 'stale intent' },
    )
    expect(ctx.data.route).toBeUndefined() // last turn's 'web' is NOT re-dispatched
    expect(ctx.data.intent).toBeUndefined()
    expect(ran).toEqual([])
    expect(ctx.status).toBe('error')
    expect((ofType(ctx.events, 'error')[0].data as ErrorEventData).severity).toBe('irrecoverable')
  })

  it("errorSeverity: 'recoverable' turns a failure into 'continue on policy.fallback'", async () => {
    const { fn } = fakeDecide(() => {
      throw new Error('decision backend down')
    })
    const { ctx, ran } = await runRouter(
      decisionRouter<Data>(ROUTES, {
        decide: fn,
        policy: { fallback: 'neo4j' },
        errorSeverity: 'recoverable',
      }),
    )
    expect(ctx.data.route).toBe('neo4j')
    expect(ran).toEqual(['neo4j'])
    expect(ctx.status).not.toBe('error')
  })

  it('shadow records the decision (shadow: true) and sets NOTHING — route, intent and decisions untouched', async () => {
    const { fn } = picks('web')
    const seed: Data = {
      route: 'neo4j',
      intent: 'keep me',
      decisions: { route: { ...STALE, key: 'route', label: 'neo4j' } },
    }
    const ctx = createContext<Data>('q', seed)
    await runInFrame(() =>
      runChain(ctx, [
        decisionRouter<Data>(ROUTES, { decide: fn, policy: { fallback: 'neo4j' }, shadow: true }),
      ]),
    )
    expect(ctx.data).toEqual(seed)
    const made = ofType(ctx.events, 'decision_made')
    expect(made).toHaveLength(1)
    expect((made[0].data as DecisionMadeEventData).shadow).toBe(true)
    expect((made[0].data as DecisionMadeEventData).label).toBe('web')
  })

  it('a shadow failure is always recoverable, whatever errorSeverity says: it can never end the turn', async () => {
    const { fn } = fakeDecide(() => {
      throw new Error('down')
    })
    const ran: string[] = []
    const ctx = createContext<Data>('q')
    await runInFrame(() =>
      runChain(ctx, [
        decisionRouter<Data>(ROUTES, {
          decide: fn,
          policy: { fallback: 'neo4j' },
          shadow: true,
          errorSeverity: 'irrecoverable',
        }),
        configurePattern<Data>('after', async (s) => (ran.push('after'), s)),
      ]),
    )
    expect(ran).toEqual(['after'])
    expect((ofType(ctx.events, 'error')[0].data as ErrorEventData).severity).toBe('recoverable')
  })

  it('asks over the router’s state (messages) with the routes as labels, under the key `route`', async () => {
    const { fn, calls } = picks('web')
    await runRouter(
      decisionRouter<Data>(ROUTES, {
        decide: fn,
        policy: { fallback: 'neo4j' },
        conversationalRoute: { name: 'chat', description: 'just answer' },
      }),
    )
    expect(calls[0].spec.key).toBe('route')
    expect(calls[0].spec.labels.map((l) => l.id)).toEqual(['neo4j', 'web', 'chat'])
    expect(calls[0].spec.labels[0].description).toBe('graph queries')
    expect(calls[0].state).toContain('User: show me the graph')
  })
})

// ============================================================================
// decision-state-sentinel (T2 paths) — SD-3
// ============================================================================

describe('decision-state-sentinel across the T2 entry points', () => {
  const SENTINEL = '⟦SENTINEL-mail-body-T2⟧'
  const everyEventJson = (events: ContextEvent[]) =>
    events.map((e) => JSON.stringify({ type: e.type, data: e.data })).join('\n')

  it('decide / decideFields / typedDecision / decisionRouter never copy the state into an event, on any outcome', async () => {
    const ok = fakeDecide(() => logprobResult({ yes: 0.9, no: 0.1 }))
    const bad = fakeDecide(() => {
      throw new Error('upstream 503')
    })
    const junk = fakeDecide(() => null)
    const scope = createScope('p', {})
    for (const { fn } of [ok, bad, junk]) {
      await decide(scope, { decide: fn, spec: SPEC, state: SENTINEL, policy: POLICY })
    }
    await decide(scope, {
      decide: ok.fn,
      spec: SPEC,
      state: SENTINEL,
      policy: { fallback: 'no', requireCalibrated: true },
    })
    await decideFields(scope, {
      decide: bad.fn,
      set: SET,
      state: SENTINEL,
      policy: SET_POLICY,
    })
    expect(scope.events.length).toBeGreaterThan(6)
    expect(everyEventJson(scope.events)).not.toContain(SENTINEL)

    const ctx = createContext<Data>(SENTINEL)
    await runInFrame(() =>
      runChain(ctx, [
        typedDecision<Data, YesNo>({ decide: ok.fn, spec: SPEC, policy: POLICY }),
        decisionRouter<Data>(ROUTES, {
          decide: bad.fn,
          policy: { fallback: 'neo4j' },
          errorSeverity: 'recoverable',
        }),
      ]),
    )
    const nonUser = ctx.events.filter((e) => e.type !== 'user_message')
    expect(nonUser.length).toBeGreaterThan(0)
    expect(everyEventJson(nonUser)).not.toContain(SENTINEL)
    expect(JSON.stringify(ctx.data)).not.toContain(SENTINEL)
  })
})

// ============================================================================
// Review round (PR #503, comment 6033934904)
// ============================================================================

const TOOL_SENTINEL = '⟦TOOL-RESULT-SECRET⟧'
const withToolResult = (ctx: ReturnType<typeof createContext<Data>>) =>
  ctx.events.unshift({
    type: 'tool_result',
    ts: 1,
    patternId: 'x',
    data: { tool: 'fetch_mail', result: TOOL_SENTINEL },
  })
/** A window that ADMITS tool results — so only the render filter stands between
 *  them and the default state (SD-1). */
const ADMITS_TOOLS = {
  fromLast: false,
  eventTypes: ['user_message', 'assistant_message', 'tool_result'],
} as const

describe('review F1 — SD-1: the default state never carries tool results', () => {
  it('typedDecision: a tool_result the window admits is absent from the default state', async () => {
    const { fn, calls } = fakeDecide(() => logprobResult({ yes: 0.9, no: 0.1 }))
    const ctx = createContext<Data>('and the mail?')
    withToolResult(ctx)
    await runInFrame(() =>
      runChain(ctx, [
        typedDecision<Data, YesNo>({
          decide: fn,
          spec: SPEC,
          policy: POLICY,
          viewConfig: { ...ADMITS_TOOLS, eventTypes: [...ADMITS_TOOLS.eventTypes] },
        }),
      ]),
    )
    expect(calls[0].state).toContain('User: and the mail?')
    expect(calls[0].state).not.toContain(TOOL_SENTINEL)
  })

  it('decisionRouter: same (it shares the renderer)', async () => {
    const { fn, calls } = picks('web')
    const ctx = createContext<Data>('and the mail?')
    withToolResult(ctx)
    await runInFrame(() =>
      runChain(ctx, [
        decisionRouter<Data>(ROUTES, {
          decide: fn,
          policy: { fallback: 'neo4j' },
          viewConfig: { ...ADMITS_TOOLS, eventTypes: [...ADMITS_TOOLS.eventTypes] },
        }),
      ]),
    )
    expect(calls[0].state).not.toContain(TOOL_SENTINEL)
  })
})

describe('review F2 — decisionRouter has a no-stale floor', () => {
  const throwingView = {
    fromLast: false,
    contentTransforms: [
      () => {
        throw new Error('transform broke')
      },
    ],
  }
  const seed: Data = {
    route: 'b',
    intent: 'old',
    decisions: { route: { ...STALE, key: 'route', label: 'b' } },
  }

  it('a throwing state build clears routing, replaces the verdict, records exactly one error', async () => {
    const { fn, calls } = picks('web')
    const ctx = createContext<Data>('q', seed)
    await runInFrame(() =>
      runChain(ctx, [
        decisionRouter<Data>(ROUTES, {
          decide: fn,
          policy: { fallback: 'neo4j' },
          viewConfig: throwingView,
        }),
      ]),
    )
    expect(calls).toHaveLength(0)
    expect(ctx.data.route).toBeUndefined()
    expect(ctx.data.intent).toBeUndefined()
    expect(ctx.data.decisions?.route).toMatchObject({ abstained: true, reason: 'no-state' })
    expect(ctx.data.decisions?.route).not.toMatchObject({ label: 'b' })
    expect(ofType(ctx.events, 'error')).toHaveLength(1)
    expect((ofType(ctx.events, 'error')[0].data as ErrorEventData).severity).toBe('irrecoverable')
  })

  it('shadow records the failure (recoverable) and touches nothing', async () => {
    const { fn } = picks('web')
    const ctx = createContext<Data>('q', seed)
    await runInFrame(() =>
      runChain(ctx, [
        decisionRouter<Data>(ROUTES, {
          decide: fn,
          policy: { fallback: 'neo4j' },
          viewConfig: throwingView,
          shadow: true,
        }),
      ]),
    )
    expect(ctx.data).toEqual(seed)
    expect(ofType(ctx.events, 'error')).toHaveLength(1)
    expect((ofType(ctx.events, 'error')[0].data as ErrorEventData).severity).toBe('recoverable')
  })
})

describe('review F3 — G1/G2 through decideFields', () => {
  const call = (key: string) => record(key)
  const mkAll = (extra?: Partial<DecideAllFn>) => {
    const seen: Array<string[]> = []
    const fn = (async (i: { spec: DecisionSetSpec<Mem> }) => {
      seen.push(Object.keys(i.spec.fields))
      return {
        fields: {
          target: logprobResult({ user: 0.9, none: 0.1 }, { method: 'jev' }),
          kind: logprobResult({ episodic: 0.1, semantic: 0.8, trait: 0.1 }, { method: 'jev' }),
        },
      }
    }) as unknown as DecideAllFn
    Object.assign(fn, extra)
    return { fn, seen }
  }
  const jointAnswer = () =>
    logprobResult({ 'user | semantic': 0.6, 'user | episodic': 0.2, 'none | trait': 0.2 })
  void call

  it('(a) mode joint with BOTH present: decideAll is never called, decide once', async () => {
    const { fn, calls } = fakeDecide(jointAnswer)
    const all = mkAll()
    await decideFields(createScope('p', {}), {
      decide: fn,
      decideAll: all.fn,
      set: { ...SET, mode: 'joint' },
      state: 's',
      policy: SET_POLICY,
    })
    expect(all.seen).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })

  it('(b) mode absent with BOTH present: decideAll once, decide never', async () => {
    const { fn, calls } = fakeDecide(jointAnswer)
    const all = mkAll()
    await decideFields(createScope('p', {}), {
      decide: fn,
      decideAll: all.fn,
      set: SET,
      state: 's',
      policy: SET_POLICY,
    })
    expect(all.seen).toHaveLength(1)
    expect(calls).toHaveLength(0)
  })

  it('(c) joint: a field refused pre-call is left out of the product spec', async () => {
    const { fn, calls } = fakeDecide(jointAnswer, {
      serving: (key) => ({ method: key === 'memory.store.kind' ? 'verbalized' : 'logprob' }),
    })
    const out = await decideFields(createScope('p', {}), {
      decide: fn,
      set: { ...SET, mode: 'joint' },
      state: 's',
      policy: {
        target: { fallback: 'none' },
        kind: { fallback: 'episodic', requireCalibrated: true },
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].spec.labels.map((l) => l.id)).toEqual(['user', 'none']) // target only
    expect(out.kind).toMatchObject({ abstained: true, reason: 'uncalibrated' })
  })

  it("(d) decideAll.serving's calibration entry cuts apply per field", async () => {
    const all = mkAll({
      serving: (key) => ({
        method: 'jev',
        ...(key === 'memory.store.target' && { calibration: { minConfidence: 0.99 } }),
      }),
    })
    const { fn } = fakeDecide(() => logprobResult({}))
    const out = await decideFields(createScope('p', {}), {
      decide: fn,
      decideAll: all.fn,
      set: SET,
      state: 's',
      policy: SET_POLICY,
    })
    expect(out.target).toMatchObject({ abstained: true, reason: 'low-confidence' })
    expect(out.kind.abstained).toBe(false)
  })

  it("(e) joint: the SET key's serving (verbalized) + requireCalibrated makes ZERO calls, and decideAll.serving is not consulted", async () => {
    const { fn, calls } = fakeDecide(jointAnswer, {
      serving: (key) => (key === 'memory.store' ? { method: 'verbalized' } : {}),
    })
    const all = mkAll({ serving: () => ({ method: 'jev' }) })
    const out = await decideFields(createScope('p', {}), {
      decide: fn,
      decideAll: all.fn,
      set: { ...SET, mode: 'joint' },
      state: 's',
      policy: {
        target: { fallback: 'none', requireCalibrated: true },
        kind: { fallback: 'episodic', requireCalibrated: true },
      },
    })
    expect(calls).toHaveLength(0)
    expect(all.seen).toHaveLength(0)
    expect([out.target.reason, out.kind.reason]).toEqual(['uncalibrated', 'uncalibrated'])
  })

  it('(f) a malformed spec abstains error through evaluateDecision — no throw', async () => {
    const { fn } = fakeDecide(() => logprobResult({ yes: 1, no: 0 }))
    const bad = { key: 'k', question: 'q', labels: undefined } as unknown as DecisionSpec<YesNo>
    const out = await evaluateDecision({ decide: fn, spec: bad, state: 's', policy: POLICY })
    expect(out.decision).toMatchObject({ abstained: true, reason: 'error', label: 'no' })
    expect(out.error?.error).toMatch(/could not be scored/)
  })
})

describe('review F4 — a partly corrupt readout is unusable, not confident', () => {
  it.each([
    ['NaN beside a real value', { yes: NaN, no: 0.3 }],
    ['Infinity beside a real value', { yes: Infinity, no: 1 }],
    ['a negative beside a real value', { yes: -0.2, no: 0.8 }],
    ['a string beside a real value', { yes: 'x', no: 0.8 }],
  ])('%s abstains error onto the fallback', async (_n, probs) => {
    const { fn } = fakeDecide(() => logprobResult(probs as unknown as Record<string, number>))
    const out = await evaluateDecision({ decide: fn, spec: SPEC, state: 's', policy: POLICY })
    expect(out.decision).toMatchObject({ abstained: true, reason: 'error', label: 'no' })
    expect(out.error).toBeDefined()
  })

  it('a label the readout simply does not mention is still fine (unseen → 0)', async () => {
    const { fn } = fakeDecide(() => logprobResult({ yes: 0.9 }))
    const out = await evaluateDecision({ decide: fn, spec: SPEC, state: 's', policy: POLICY })
    expect(out.decision).toMatchObject({ abstained: false, label: 'yes' })
  })
})

describe('review F5 — SD-3: a transport that echoes the state in its error', () => {
  const S = '⟦SENTINEL-ECHOED-STATE⟧'
  it('the message is redacted in every entry point, and capped', async () => {
    const echo = fakeDecide(() => {
      throw new Error(`HTTP 400 body: ${S} ${'x'.repeat(2000)}`)
    })
    const scope = createScope('p', {})
    await decide(scope, { decide: echo.fn, spec: SPEC, state: S, policy: POLICY })
    await decideFields(scope, { decide: echo.fn, set: SET, state: S, policy: SET_POLICY })
    await decideFields(scope, {
      decide: echo.fn,
      set: { ...SET, mode: 'joint' },
      state: S,
      policy: SET_POLICY,
    })
    const decideAll = (async () => {
      throw new Error(`echo ${S}`)
    }) as unknown as DecideAllFn
    await decideFields(scope, {
      decide: echo.fn,
      decideAll,
      set: SET,
      state: S,
      policy: SET_POLICY,
    })

    const errors = ofType(scope.events, 'error')
    expect(errors.length).toBeGreaterThanOrEqual(4)
    expect(JSON.stringify(scope.events.map((e) => e.data))).not.toContain(S)
    expect((errors[0].data as ErrorEventData).error).toContain('[state]')
    expect((errors[0].data as ErrorEventData).error.length).toBeLessThanOrEqual(501)
  })
})

describe('review F6 — DX', () => {
  it('a custom `state` sees tool results with NO viewConfig supplied', async () => {
    const { fn } = fakeDecide(() => logprobResult({ yes: 0.9, no: 0.1 }))
    let types: string[] = []
    const ctx = createContext<Data>('q')
    withToolResult(ctx)
    await runInFrame(() =>
      runChain(ctx, [
        typedDecision<Data, YesNo>({
          decide: fn,
          spec: SPEC,
          policy: POLICY,
          state: (view) => {
            types = view.get().map((e) => e.type)
            return 'custom'
          },
        }),
      ]),
    )
    expect(types).toContain('tool_result')
  })

  it('the documented composition: an intent writer → decisionRouter({ preserveIntent: true }) → routes', async () => {
    const { fn } = picks('web')
    let seen: string | undefined
    const writer = configurePattern<Data>(
      'intent-writer',
      async (scope) => ((scope.data = { ...scope.data, intent: 'compacted intent' }), scope),
      { patternId: 'intent-writer' },
    )
    const dispatch = configurePattern<Data>(
      'web',
      async (scope) => ((seen = scope.data.intent), scope),
      { patternId: 'web' },
    )
    const ctx = createContext<Data>('q')
    await runInFrame(() =>
      runChain(ctx, [
        writer,
        decisionRouter<Data>(ROUTES, {
          decide: fn,
          policy: { fallback: 'neo4j' },
          preserveIntent: true,
        }),
        routes<Data>({ web: dispatch, neo4j: dispatch }),
      ]),
    )
    expect(seen).toBe('compacted intent')
  })
})

// ============================================================================
// decision-seam-structural
// ============================================================================

describe('decision-seam-structural', () => {
  // The RAW seam is what `classifierFromDecide` is handed (D7). This block is
  // compile-checked by `pnpm typecheck`: the positive line fails to compile if
  // the raw seam stops fitting, and the `@ts-expect-error` line is an error
  // itself if the policy-applying wrapper ever starts to fit.
  const raw: DecideFn = async ({ spec }) => ({
    probs: Object.fromEntries(spec.labels.map((l, i) => [l.id, i === 0 ? 0.97 : 0.03])) as never,
    method: 'logprob',
    calibrated: true,
  })

  it('classifierFromDecide accepts the raw seam, and requireCalibrated still abstains on an uncalibrated read', async () => {
    const good = classifierFromDecide(raw)
    expect(await good({ text: 'ordinary document text' })).toMatchObject({
      suspicious: false,
      abstained: false,
    })

    const verbalized: DecideFn = async (i) => ({
      ...(await raw(i)),
      method: 'verbalized',
      calibrated: false,
    })
    expect(await classifierFromDecide(verbalized)({ text: 'x' })).toMatchObject({
      suspicious: true,
      abstained: true,
    })
  })

  it('a policy-applying wrapper does NOT compile against it (the negative control)', () => {
    const wrapped = async (input: { spec: typeof DOCUMENT_INJECTION_DECISION; state: string }) =>
      (
        await evaluateDecision({
          decide: raw,
          spec: input.spec,
          state: input.state,
          policy: { fallback: 'suspicious' as const },
        })
      ).decision
    // @ts-expect-error — `Decision` (probs Partial, method optional) is not the raw seam's `DecideResult`
    classifierFromDecide(wrapped)
    expect(typeof wrapped).toBe('function')
  })
})
