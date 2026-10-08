/** #418 T7: real decisions, turn runner, SSE and persistence. Test-only agents
 * opt in through the existing in-process registry; production waits for T9/T10. */
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
import { FAKE_ANTHROPIC_TIER_MODEL, IS_HERMETIC, SMALL_MODEL, TIERS } from '../lib/mode'

type DecisionData = SessionData &
  import('@hames-ai/harness-patterns/patterns/typedDecision.server').TypedDecisionData

let app: AppHandles
let adapters: typeof import('@hames-ai/harness-baml/baml-adapters.server')
let clients: typeof import('@hames-ai/harness-baml/clients.server')
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
const STATE = 'E2E-DECISION-STATE-SENTINEL'
const JEV_MODEL = 'typesafe/jev-1.13'
function policy(tier: string) {
  return {
    fallback: 'skip',
    minConfidence: 0.4,
    thresholdMethod: tier === 'verda' ? ('logprob' as const) : ('jev' as const),
  }
}
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
  clients = await import('@hames-ai/harness-baml/clients.server')
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
  clients.configureDecideSecondary(undefined)
  clients.configureDecisionCalibration({})
})
afterAll(async () => {
  clients.configureDecideSecondary(undefined)
  clients.configureDecisionCalibration({})
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
          policy: policy(tier),
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
        method: tier === 'verda' ? 'logprob' : 'jev',
        calibrated: tier !== 'verda',
      })
      expect((event.data as DecisionMadeEventData).probs.take).toBeCloseTo(0.9)
      expect(event.llmCall?.clientName).toBe(
        tier === 'verda' ? 'LocalQwenSmallDecide' : 'JevDecide',
      )
      expect((event.llmCall as LLMCallRecord)?.hitOutputCap).toBe(false)
      expect(event.llmCall?.variables).toMatchObject({ state: expect.stringContaining(STATE) })
      expect(JSON.stringify(event.data)).not.toContain(STATE)
      expect(eventsOfType(row.serializedContext, 'assistant_message').at(-1)?.content).toContain(
        FAKE_ANSWER_MARK,
      )
      const calls = app.fakeLlm.calls.filter((c) => c.fn === 'Decide' || c.model === JEV_MODEL)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        model: tier === 'verda' ? SMALL_MODEL : JEV_MODEL,
        outcome: 'ok',
      })
    })
    it('records four fields with shared state and one Jev request', async () => {
      const id = `e2e-fields-${tier}`
      register(id, async () => {
        const decide = adapters.createDecideAdapter()
        const step = patterns.typedDecision<DecisionData, string>({
          decide,
          spec: SPEC,
          policy: policy(tier),
        })
        step.fn = async (scope) => {
          const fields = Object.fromEntries(
            ['one', 'two', 'three', 'four'].map((name) => [name, { ...SPEC, key: `e2e.${name}` }]),
          )
          await patterns.decideFields(scope, {
            decide,
            decideAll: adapters.createDecideAllAdapter(decide),
            set: { key: 'e2e.fields', mode: 'fields', fields },
            state: STATE,
            policy: Object.fromEntries(Object.keys(fields).map((name) => [name, policy(tier)])),
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
      const calls = app.fakeLlm.calls.filter((c) => c.fn === 'Decide' || c.model === JEV_MODEL)
      expect(calls).toHaveLength(tier === 'verda' ? 4 : 1)
      if (tier === 'verda') {
        const states = calls.map(
          (c) => c.prompt.split('---BEGIN DATA---')[1].split('---END DATA---')[0],
        )
        expect(new Set(states).size).toBe(1)
        expect(states[0]).toContain(STATE)
      } else {
        const body = JSON.parse(calls[0].prompt)
        expect(body.state).toBe(STATE)
        expect(Object.keys(body.questions)).toEqual(['one', 'two', 'three', 'four'])
      }
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
            policy: policy('verda'),
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
      expect(app.fakeLlm.calls.filter((c) => c.fn === 'Decide')).toHaveLength(0)
      await app.setTier('anthropic')
      release()
      const evaluated = await trailing
      expect(evaluated.decision).toMatchObject({
        label: 'take',
        abstained: false,
        method: 'logprob',
      })
      expect(evaluated.llmCall?.clientName).toBe('LocalQwenSmallDecide')
      expect(app.fakeLlm.calls.filter((c) => c.fn === 'Decide').map((c) => c.model)).toEqual([
        SMALL_MODEL,
      ])
      expect(app.fakeLlm.calls.filter((c) => c.model === JEV_MODEL)).toEqual([])
    } finally {
      release()
      await trailing
    }
  })
  it('a Jev 500 ends decisionRouter irrecoverably without another provider', async () => {
    register('e2e-decision-router-error', async () => [
      patterns.decisionRouter(
        { take: 'Take action', skip: 'Skip action' },
        { decide: adapters.createDecideAdapter(), policy: policy('anthropic') },
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
    expect(events[0].data).toMatchObject({ abstained: true, reason: 'error', label: 'skip' })
    expect(eventsOfType(row.serializedContext, 'error')).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: 'irrecoverable' })]),
    )
    expect(app.fakeLlm.calls.filter((c) => c.model === JEV_MODEL)).toHaveLength(1)
    expect(
      app.fakeLlm.calls.filter(
        (c) => c.fn === 'Decide' || c.fn === 'DecideVerbalized' || c.fn === 'Synthesize',
      ),
    ).toEqual([])
  })
  it('a Jev 500 abstains a recoverable gate and preserves the answer', async () => {
    register('e2e-decision-gate-error', async () => [
      patterns.typedDecision<DecisionData, string>({
        decide: adapters.createDecideAdapter(),
        spec: SPEC,
        policy: policy('anthropic'),
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
    expect(events[0].data).toMatchObject({ abstained: true, reason: 'error', label: 'skip' })
    expect(eventsOfType(row.serializedContext, 'error')).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: 'recoverable' })]),
    )
    expect(app.fakeLlm.calls.filter((c) => c.model === JEV_MODEL)).toHaveLength(1)
    expect(
      app.fakeLlm.calls.filter((c) => c.fn === 'Decide' || c.fn === 'DecideVerbalized'),
    ).toEqual([])
  })
  it('persists the explicitly named verbalized secondary as uncalibrated', async () => {
    clients.configureDecideSecondary('DecideAnthropic')
    register('e2e-verbalized', async () => [
      patterns.typedDecision<DecisionData, string>({
        decide: adapters.createDecideAdapter({ verbalized: adapters.createVerbalizedDecide() }),
        spec: SPEC,
        policy: { fallback: 'skip', thresholdMethod: 'verbalized', minConfidence: 0.4 },
      }),
      answer(),
    ])
    await app.setTier('anthropic')
    const sessionId = newSessionId('verbalized')
    // Offline preflight BEFORE a socket is opened: a named override bypasses
    // the registry's primary unless that client is registered as well.
    const { b } = await import('@hames-ai/harness-baml/baml_client')
    const options = (
      b as unknown as {
        bamlOptions: NonNullable<Parameters<typeof b.request.DecideVerbalized>[3]>
      }
    ).bamlOptions
    const request = await b.request.DecideVerbalized(
      STATE,
      SPEC.question,
      SPEC.labels.map((label, i) => ({
        letter: String.fromCharCode(65 + i),
        description: label.description,
      })),
      { ...options, client: 'DecideAnthropic' },
    )
    expect(request.url).toBe(`${app.fakeLlm.baseUrl}/chat/completions`)
    expect(request.body.json()).toMatchObject({ model: FAKE_ANTHROPIC_TIER_MODEL })
    await app.runTurn(sessionId, STATE, 'e2e-verbalized')
    const { events } = await decisions(sessionId)
    expect(events[0].data).toMatchObject({
      label: 'take',
      abstained: false,
      method: 'verbalized',
      calibrated: false,
      probs: { take: 0.9, skip: 0.1 },
    })
    expect(events[0].llmCall?.clientName).toBe('AnthropicSonnet5NoThink')
    expect(
      app.fakeLlm.calls.filter((c) => c.fn === 'DecideVerbalized').map((c) => c.model),
    ).toEqual([FAKE_ANTHROPIC_TIER_MODEL])
    expect(app.fakeLlm.calls.filter((c) => c.model === JEV_MODEL || c.fn === 'Decide')).toEqual([])
  })
})
