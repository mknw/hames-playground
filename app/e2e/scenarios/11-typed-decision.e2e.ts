/** Systemone decisions through the turn runner, SSE and persistence. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type {
  ConfiguredPattern,
  ContextEvent,
  DecisionMadeEventData,
  LLMCallRecord,
} from '@hames-ai/harness-patterns/types'
import type { SessionData } from '../../src/lib/harness-client/session.server'
import { bootApp, eventsOfType, newSessionId, type AppHandles } from '../lib/app'
import { FAKE_ANSWER_MARK } from '../lib/fake-llm'
import { IS_HERMETIC, TIERS } from '../lib/mode'

type DecisionData = SessionData &
  import('@hames-ai/harness-patterns/patterns/typedDecision.server').TypedDecisionData

let app: AppHandles
let adapters: typeof import('@hames-ai/harness-baml/baml-adapters.server')
let patterns: typeof import('@hames-ai/harness-patterns/patterns/typedDecision.server')
let registerAgent: typeof import('../../src/lib/harness-client/registry.server').registerAgent
let answer: () => ConfiguredPattern<SessionData>
const SPEC = {
  key: 'e2e.decision',
  question: 'Which action follows?',
  labels: [
    { id: 'take', description: 'Take the action' },
    { id: 'skip', description: 'Skip the action' },
  ],
} as const
const SCORE = {
  type: 'score',
  key: 'e2e.score',
  question: 'How disruptive is the synthetic report?',
  levels: [
    { id: 'minor', description: 'Work continues normally.' },
    { id: 'workaround', description: 'Work continues with a workaround.' },
    { id: 'blocked', description: 'Work cannot continue.' },
  ],
} as const
const NOUL = {
  type: 'noul',
  key: 'e2e.noul',
  question: 'The message is a greeting.',
  criteria: { true: 'A hello or equivalent greeting.', false: 'Anything else.' },
} as const
const STATE = 'E2E-DECISION-STATE-SENTINEL'
const JEV_MODEL = 'typesafe/jev-1.13'
function register(id: string, createPatterns: () => Promise<ConfiguredPattern<SessionData>[]>) {
  registerAgent({
    id,
    name: id,
    description: 'Test-only decision conversation',
    welcome: 'Test-only decision conversation',
    servers: [],
    icon: 'i-material-symbols-rule',
    accent: 'indigo',
    createPatterns,
  })
}
async function decisions(sessionId: string) {
  const row = await app.readRow(sessionId)
  expect(row).not.toBeNull()
  const context = JSON.parse(row!.serializedContext) as { events: ContextEvent[] }
  return { row: row!, events: context.events.filter((e) => e.type === 'decision_made') }
}
beforeAll(async () => {
  app = await bootApp()
  adapters = await import('@hames-ai/harness-baml/baml-adapters.server')
  patterns = await import('@hames-ai/harness-patterns/patterns/typedDecision.server')
  ;({ registerAgent } = await import('../../src/lib/harness-client/registry.server'))
  const { compactExecution } =
    await import('@hames-ai/harness-patterns/patterns/compactExecution.server')
  const { bamlPatterns } = await import('@hames-ai/harness-baml/baml-patterns.server')
  answer = () =>
    compactExecution<SessionData>({ mode: 'message', synthesize: bamlPatterns().synthesize })
  await app.wipe()
})
beforeEach(() => {
  app.fakeLlm.reset()
})
afterAll(async () => {
  await app.wipe()
})
describe.runIf(IS_HERMETIC)('typed decisions through a conversation', () => {
  it('exercises both tier positions', () => {
    expect([...TIERS].sort()).toEqual(['anthropic', 'verda'])
  })
  describe.each(TIERS)('on the %s tier', (tier) => {
    it('streams and persists the decision with its actual serving client', async () => {
      const id = `e2e-decision-${tier}`
      register(id, async () => [
        patterns.typedDecision<DecisionData, string>({
          decide: adapters.createDecideAdapter(),
          spec: SPEC,
        }),
        answer(),
      ])
      await app.setTier(tier)
      const sessionId = newSessionId(id)
      const { status, frames } = await app.runTurnOverSse({
        sessionId,
        agentId: id,
        message: STATE,
      })
      expect(status).toBe(200)
      expect(frames.find((f) => f.event === 'done')?.data.response).toContain(FAKE_ANSWER_MARK)
      expect(frames.some((f) => f.event === 'message' && f.data.type === 'decision_made')).toBe(
        true,
      )
      const { row, events } = await decisions(sessionId)
      expect(row.status).toBe('done')
      expect(events).toHaveLength(1)
      const event = events[0]
      expect(event.data).toMatchObject({
        key: SPEC.key,
        label: 'take',
        abstained: false,
        method: 'jev',
      })
      expect((event.data as DecisionMadeEventData).probs.take).toBeCloseTo(0.9)
      expect(event.llmCall?.clientName).toBe(tier === 'verda' ? 'PrivateSystemOne' : 'JevDecide')
      expect((event.llmCall as LLMCallRecord)?.hitOutputCap).toBe(false)
      expect(event.llmCall?.variables).toMatchObject({ state: expect.stringContaining(STATE) })
      expect(JSON.stringify(event.data)).not.toContain(STATE)
      expect(eventsOfType(row.serializedContext, 'assistant_message').at(-1)?.content).toContain(
        FAKE_ANSWER_MARK,
      )
      const calls = app.fakeLlm.calls.filter((c) => c.model === JEV_MODEL)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        model: JEV_MODEL,
        outcome: 'ok',
      })
    })
    it('streams and persists score/noul probabilities and actual clients', async () => {
      const id = `e2e-score-noul-${tier}`
      register(id, async () => [
        patterns.typedDecision<DecisionData, typeof SCORE>({
          decide: adapters.createDecideAdapter(),
          spec: SCORE,
        }),
        patterns.typedDecision<DecisionData, typeof NOUL>({
          decide: adapters.createDecideAdapter(),
          spec: NOUL,
        }),
        answer(),
      ])
      await app.setTier(tier)
      const sessionId = newSessionId(id)
      const { status, frames } = await app.runTurnOverSse({
        sessionId,
        agentId: id,
        message: STATE,
      })
      expect(status).toBe(200)
      expect(frames.find((f) => f.event === 'done')?.data.response).toContain(FAKE_ANSWER_MARK)
      expect(
        frames.filter((f) => f.event === 'message' && f.data.type === 'decision_made'),
      ).toHaveLength(2)
      const { row, events } = await decisions(sessionId)
      expect(row.status).toBe('done')
      expect(events).toHaveLength(2)
      expect(events[0].data).toMatchObject({
        type: 'score',
        key: SCORE.key,
        label: 'minor',
        abstained: false,
      })
      expect((events[0].data as DecisionMadeEventData).expected).toBeCloseTo(0.15)
      expect(events[1].data).toMatchObject({
        type: 'noul',
        key: NOUL.key,
        label: 'true',
        abstained: false,
      })
      expect((events[1].data as DecisionMadeEventData).pTrue).toBeCloseTo(0.9)
      for (const event of events) {
        expect(event.llmCall?.clientName).toBe(tier === 'verda' ? 'PrivateSystemOne' : 'JevDecide')
        expect((event.llmCall as LLMCallRecord)?.hitOutputCap).toBe(false)
        expect(event.llmCall?.variables).toMatchObject({ state: expect.stringContaining(STATE) })
        expect(JSON.stringify(event.data)).not.toContain(STATE)
      }
      const calls = app.fakeLlm.calls.filter((c) => c.model === JEV_MODEL)
      expect(calls).toHaveLength(2)
      expect(calls.map((c) => c.model)).toEqual([JEV_MODEL, JEV_MODEL])
      expect(calls.map((c) => Object.values(JSON.parse(c.prompt).questions)[0])).toEqual([
        {
          type: 'score',
          instructions: SCORE.question,
          criteria: SCORE.levels.map((l) => l.description),
        },
        { type: 'noul', instructions: NOUL.question, criteria: NOUL.criteria },
      ])
      expect(JSON.parse(events[1].llmCall!.rawOutput!).answers[NOUL.key]).toEqual({
        type: 'noul',
        noul: 0.9,
      })
    })
    it('records four fields with shared state and one systemone request', async () => {
      const id = `e2e-fields-${tier}`
      register(id, async () => {
        const decide = adapters.createDecideAdapter()
        const step = patterns.typedDecision<DecisionData, string>({
          decide,
          spec: SPEC,
        })
        step.fn = async (scope) => {
          const fields = Object.fromEntries(
            ['one', 'two', 'three', 'four'].map((name) => [name, { ...SPEC, key: `e2e.${name}` }]),
          )
          await patterns.decideFields(scope, {
            decide,
            decideAll: adapters.createDecideAllAdapter(),
            set: { key: 'e2e.fields', fields },
            state: STATE,
          })
          return scope
        }
        return [step, answer()]
      })
      await app.setTier(tier)
      const sessionId = newSessionId(id)
      expect((await app.runTurn(sessionId, STATE, id)).response).toContain(FAKE_ANSWER_MARK)
      const { events } = await decisions(sessionId)
      expect(events.map((e) => (e.data as DecisionMadeEventData).key)).toEqual([
        'e2e.one',
        'e2e.two',
        'e2e.three',
        'e2e.four',
      ])
      expect(events.every((e) => !(e.data as DecisionMadeEventData).abstained)).toBe(true)
      const calls = app.fakeLlm.calls.filter((c) => c.model === JEV_MODEL)
      expect(calls).toHaveLength(1)
      const body = JSON.parse(calls[0].prompt)
      expect(body.state).toBe(STATE)
      expect(Object.keys(body.questions)).toEqual(['one', 'two', 'three', 'four'])
    })
  })
  it('keeps a gated post-reply decision on the private turn frame (D16)', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let trailing!: ReturnType<typeof patterns.evaluateDecision>
    register('e2e-post-reply', async () => {
      const step = answer()
      const reply = step.fn
      step.fn = async (scope, view) => {
        const result = await reply(scope, view)
        // The continuation starts in the real turn frame and cannot call until
        // the caller has received the reply and flipped the next turn's seed.
        trailing = (async () => {
          await gate
          return patterns.evaluateDecision({
            decide: adapters.createDecideAdapter(),
            spec: SPEC,
            state: STATE,
          })
        })()
        return result
      }
      return [step]
    })
    await app.setTier('verda')
    try {
      const result = await app.runTurn(newSessionId('post-reply'), STATE, 'e2e-post-reply')
      expect(result.response).toContain(FAKE_ANSWER_MARK)
      expect(app.fakeLlm.calls.filter((c) => c.model === JEV_MODEL)).toHaveLength(0)
      await app.setTier('anthropic')
      release()
      const evaluated = await trailing
      expect(evaluated.decision).toMatchObject({
        label: 'take',
        abstained: false,
        method: 'jev',
      })
      expect(evaluated.llmCall?.clientName).toBe('PrivateSystemOne')
      expect(app.fakeLlm.calls.filter((c) => c.model === JEV_MODEL).map((c) => c.model)).toEqual([
        JEV_MODEL,
      ])
    } finally {
      release()
      await trailing
    }
  })
  it('a Jev 500 ends decisionRouter irrecoverably without another provider', async () => {
    register('e2e-decision-router-error', async () => [
      patterns.decisionRouter(
        { take: 'Take action', skip: 'Skip action' },
        { decide: adapters.createDecideAdapter() },
      ),
      answer(),
    ])
    await app.setTier('anthropic')
    app.fakeLlm.arm({ kind: 'status', status: 500, model: JEV_MODEL })
    const sessionId = newSessionId('router-error')
    const { frames } = await app.runTurnOverSse({
      sessionId,
      agentId: 'e2e-decision-router-error',
      message: STATE,
    })
    expect(frames.find((f) => f.event === 'done')?.data.status).toBe('error')
    const { row, events } = await decisions(sessionId)
    expect(row.status).toBe('error')
    expect(events[0].data).toMatchObject({ reason: 'error', label: null })
    expect(eventsOfType(row.serializedContext, 'error')).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: 'irrecoverable' })]),
    )
    expect(app.fakeLlm.calls.filter((c) => c.model === JEV_MODEL)).toHaveLength(1)
    expect(app.fakeLlm.calls.filter((c) => c.fn === 'Synthesize')).toEqual([])
  })
  it('a systemone 500 records no verdict and preserves the answer', async () => {
    register('e2e-decision-gate-error', async () => [
      patterns.typedDecision<DecisionData, string>({
        decide: adapters.createDecideAdapter(),
        spec: SPEC,
      }),
      answer(),
    ])
    await app.setTier('anthropic')
    app.fakeLlm.arm({ kind: 'status', status: 500, model: JEV_MODEL })
    const sessionId = newSessionId('gate-error')
    expect((await app.runTurn(sessionId, STATE, 'e2e-decision-gate-error')).response).toContain(
      FAKE_ANSWER_MARK,
    )
    const { row, events } = await decisions(sessionId)
    expect(row.status).toBe('done')
    expect(events[0].data).toMatchObject({ reason: 'error', label: null })
    expect(eventsOfType(row.serializedContext, 'error')).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: 'recoverable' })]),
    )
    expect(app.fakeLlm.calls.filter((c) => c.model === JEV_MODEL)).toHaveLength(1)
  })
})
