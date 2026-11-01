/** PR #895 security delta review probe: the N8 error channel must not carry raw
 * outgoing argument text into persisted or live events (N8-09). All outgoing
 * calls use a synthetic transport. Proposed evidence from the security delta
 * review at 13bb8fc8 — expected RED on the current head if the channel leaks. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { harness, resumeHarness } from '../harness.server'
import { readHitl } from '../hitl.server'
import { decisionLoop, DECISION_LOOP_ANSWER } from '../patterns/decisionLoop.server'
import { simpleLoop } from '../patterns/simpleLoop.server'
import { withEgressGate, type EgressGateConfig } from '../patterns/withEgressGate.server'
import { registerToolNamespaces } from '../tools.server'
import type { RunFrame } from '../run-frame.server'
import type { ToolTransport } from '../tool-transport.server'
import type {
  ConfiguredPattern,
  ControllerAction,
  ControllerFn,
  ControllerInput,
  DecideFn,
  HitlPayloadStore,
} from '../types'

type Data = Record<string, unknown> & { response?: string }

const CATALOG = ['web_search', 'fetch', 'read_neo4j_cypher']
const PUBLIC = { personal: 0, company: 0, nothing_private: 1 }
const PERSONAL = { personal: 0.9, company: 0.05, nothing_private: 0.05 }
const SENTINEL = 'review-error-secret'

let unregister: () => void
beforeEach(() => {
  unregister = registerToolNamespaces(
    (n) => ({ web_search: 'web', fetch: 'web', read_neo4j_cypher: 'neo4j' })[n],
  )
})
afterEach(() => unregister())

type Log = { name: string; args: Record<string, unknown> }[]

function transport(log: Log): ToolTransport {
  return {
    id: 'scripted',
    ownsTool: (name) => ['web_search', 'fetch'].includes(name),
    callTool: async (name, args) => {
      log.push({ name, args })
      return { success: true, data: { hits: [`hit for ${String(args.query)}`] } }
    },
    listTools: async () => [],
  }
}

function memoryStore(): HitlPayloadStore {
  const rows = new Map<string, { ref: string; kind: string; json: string }>()
  let n = 0
  return {
    hold: async ({ callKey, kind, payload }) => {
      const json = JSON.stringify(payload)
      const row = rows.get(`${callKey}:${kind}`)
      if (!row) {
        const ref = `ref-${++n}`
        rows.set(`${callKey}:${kind}`, { ref, kind, json })
        return { payloadRef: ref, inserted: true }
      }
      return row.json === json ? { payloadRef: row.ref, inserted: false } : { rebound: true }
    },
    drop: async () => undefined,
    load: async (ref) => {
      const row = [...rows.values()].find((r) => r.ref === ref)
      return row ? { kind: row.kind, payload: JSON.parse(row.json) } : null
    },
  }
}

const act = (tool: string, args: unknown = {}, over: Partial<ControllerAction> = {}) => ({
  action: {
    reasoning: `use ${tool}`,
    tool_name: tool,
    tool_args: typeof args === 'string' ? args : JSON.stringify(args),
    status: `calling ${tool}`,
    is_final: tool === 'Return',
    ...over,
  } as ControllerAction,
})
const done = act('Return', {}, { tool_args: 'done' })

function scripted(script: ReturnType<typeof act>[]) {
  const inputs: ControllerInput[] = []
  const fn = vi.fn<ControllerFn>(async (input) => {
    inputs.push(structuredClone(input))
    return script[Math.min(input.turn, script.length - 1)]
  })
  return { fn, inputs }
}

type Probs = typeof PUBLIC
function egressDecide(script: (Probs | 'hang')[]) {
  const calls = { n: 0 }
  const fn = (async () => {
    const step = script[Math.min(calls.n++, script.length - 1)]
    if (step === 'hang') return new Promise<never>(() => {})
    return { probs: step, method: 'jev', calibrated: false }
  }) as unknown as DecideFn
  Object.defineProperty(fn, 'supportedTypes', { value: ['choice'] })
  return Object.assign(fn, { calls })
}

const loop = (controller: ControllerFn, tools: string[]) =>
  simpleLoop<Data>(controller, tools, { patternId: 'web', maxTurns: 6 })

function agent(
  routes: Record<string, ConfiguredPattern<Data>>,
  order: string[],
  gate: Partial<EgressGateConfig> = {},
): ConfiguredPattern<Data>[] {
  let nextRoute = 0
  return [
    withEgressGate({
      local: ['neo4j'],
      catalog: CATALOG,
      decide: egressDecide([PERSONAL]),
      askPerson: true,
      ...gate,
    })(
      decisionLoop<Data>(
        Object.fromEntries(
          Object.entries(routes).map(([name, pattern]) => [
            name,
            { pattern, description: `the ${name} route` },
          ]),
        ),
        {
          decide: (async ({ spec }: { spec: { labels: readonly { id: string }[] } }) => {
            const ids = spec.labels.map((l) => l.id)
            const want = order[Math.min(nextRoute++, order.length - 1)]
            return {
              probs: Object.fromEntries(ids.map((id) => [id, id === want ? 1 : 0])),
              method: 'jev',
              calibrated: false,
            }
          }) as unknown as DecideFn,
          answer: 'Answer now',
          patternId: 'orchestrator',
          gatedTools: [],
        },
      ),
    ),
  ]
}

function frameOf(log: Log, store: HitlPayloadStore): RunFrame {
  const claims = new Map<string, { digest: string; result?: import('../types').ToolCallResult }>()
  return {
    transports: [transport(log)],
    hitlPayloads: store,
    toolSendClaims: {
      claim: async ({ runId, callKey, digest }) => {
        const key = `${runId}:${callKey}`
        const old = claims.get(key)
        if (!old) {
          claims.set(key, { digest })
          return { status: 'new' }
        }
        if (old.digest !== digest) return { status: 'mismatch' }
        return old.result ? { status: 'finished', result: old.result } : { status: 'unknown' }
      },
      finish: async ({ runId, callKey, digest, result }) => {
        claims.set(`${runId}:${callKey}`, { digest, result })
      },
    },
  }
}

const assertNoSentinel = (events: unknown[], live: unknown[]) => {
  expect.soft(JSON.stringify(events), 'persisted events').not.toContain(SENTINEL)
  expect.soft(JSON.stringify(live), 'live events').not.toContain(SENTINEL)
}

describe('N8 error channel stays metadata-only', () => {
  it('withholds the raw controller record on terminal batch failure', async () => {
    const log: Log = []
    const live: unknown[] = []
    const malformed = `{"query": "x"} ${SENTINEL}`
    const controller = vi.fn<ControllerFn>(async () => ({
      ...act('web_search', malformed, {
        additional_calls: [{ tool_name: 'web_search', tool_args: malformed }],
      }),
      llmCall: {
        functionName: 'LoopController',
        variables: {},
        rawInput: SENTINEL,
        rawOutput: SENTINEL,
        hitOutputCap: true,
      },
    }))
    const patterns = agent(
      {
        web: simpleLoop<Data>(controller, ['web_search'], {
          patternId: 'web',
          maxTurns: 3,
          maxConsecutiveRecoveries: 1,
        }),
      },
      ['web', DECISION_LOOP_ANSWER],
      { decide: egressDecide([PUBLIC]) },
    )
    const result = await harness<Data>(...patterns)(
      'find it',
      'review-error-terminal',
      undefined,
      (event) => live.push(event),
      frameOf(log, memoryStore()),
    )
    expect(log).toEqual([])
    expect(result.context.events.some((event) => event.type === 'error')).toBe(true)
    assertNoSentinel(result.context.events, live)
  })

  it('keeps raw unrepairable tool_args out of zero-held batch events', async () => {
    const log: Log = []
    const live: unknown[] = []
    const store = memoryStore()
    const web = scripted([
      act(
        'web_search',
        { query: 'review-ok-one' },
        {
          additional_calls: [
            // Trailing content after valid JSON: repairJsonTracked throws a plain
            // SyntaxError, so simpleLoop embeds the RAW string in precheckError.
            { tool_name: 'web_search', tool_args: `{"query": "x"} ${SENTINEL}` },
          ],
        },
      ),
      done,
    ])
    const patterns = agent({ web: loop(web.fn, ['web_search']) }, ['web', DECISION_LOOP_ANSWER], {
      decide: egressDecide([PUBLIC, PUBLIC]),
    })
    const result = await harness<Data>(...patterns)(
      'find it',
      'review-error-zero-hold',
      undefined,
      (event) => live.push(event),
      frameOf(log, store),
    )
    expect(log).toEqual([{ name: 'web_search', args: { query: 'review-ok-one' } }])
    expect(readHitl(result.context).pending).toEqual([])
    expect(
      result.context.events.some(
        (event) =>
          event.type === 'tool_result' &&
          (event.data as { error?: string }).error?.includes('Batch call 2 failed'),
      ),
    ).toBe(true)
    assertNoSentinel(result.context.events, live)
  })

  it.each([false, true])(
    'keeps raw unrepairable tool_args out of resumed held-batch events (accept=%s)',
    async (accept) => {
      const log: Log = []
      const live: unknown[] = []
      const store = memoryStore()
      const web = scripted([
        act(
          'web_search',
          { query: 'review-held-ok' },
          {
            additional_calls: [
              { tool_name: 'web_search', tool_args: `{"query": "x"} ${SENTINEL}` },
            ],
          },
        ),
        done,
      ])
      const patterns = agent(
        { web: loop(web.fn, ['web_search']) },
        accept ? ['web', DECISION_LOOP_ANSWER] : ['web', 'web', DECISION_LOOP_ANSWER],
        { decide: egressDecide([PERSONAL, PERSONAL]) },
      )
      const frame = frameOf(log, store)
      const paused = await harness<Data>(...patterns)(
        'find it',
        'review-error-held',
        undefined,
        (event) => live.push(event),
        frame,
      )
      expect(paused.status).toBe('paused')
      expect(log).toEqual([])
      const [request] = readHitl(paused.context).pending
      expect(request).toBeDefined()
      const acceptFlag = request.options[0].flags?.[0]?.id
      expect(acceptFlag).toBeDefined()
      const resumed = await resumeHarness<Data>(
        paused.serialized,
        patterns,
        { [request.requestId]: { choice: 'continue', flags: { [acceptFlag!]: accept } } },
        { frame, onEvent: (event) => live.push(event) },
      )
      expect(resumed.status).not.toBe('paused')
      expect(log).toEqual(accept ? [{ name: 'web_search', args: { query: 'review-held-ok' } }] : [])
      expect(
        resumed.context.events.some(
          (event) =>
            event.type === 'tool_result' &&
            (event.data as { error?: string }).error?.includes('Batch call 2 failed'),
        ),
      ).toBe(true)
      if (!accept)
        expect(
          resumed.context.events.some(
            (event) =>
              event.type === 'loop_recovery' &&
              (event.data as { error?: string }).error?.includes('Batch call 2 failed'),
          ),
        ).toBe(true)
      assertNoSentinel(resumed.context.events, live)
    },
  )
})
