/** N8-09 hook-error channel probe: a host `onToolResult` hook receives the
 * outgoing arguments, so a hook that throws quoting them must not put that
 * raw text into an N8 executing-batch event (`simpleLoop.server.ts` hookResult
 * `batchEventSafe` branch). Non-N8 runs keep the raw hook diagnostic. All
 * transports are synthetic; no network, gateway, provider or tenant data. */
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

const CATALOG = ['web_search', 'read_neo4j_cypher']
const PUBLIC = { personal: 0, company: 0, nothing_private: 1 }
const PERSONAL = { personal: 0.9, company: 0.05, nothing_private: 0.05 }
const SENTINEL = 'n8-hook-sentinel-895'
const FIXED_HOOK_ERROR = 'onToolResult hook failed for batch call; see encrypted plan.'

let unregister: () => void
beforeEach(() => {
  unregister = registerToolNamespaces((n) => ({ web_search: 'web', read_neo4j_cypher: 'neo4j' })[n])
})
afterEach(() => unregister())

type Log = { name: string; args: Record<string, unknown> }[]

/** A transport that never echoes the outgoing arguments into its results, so
 * the only sentinel carrier under test is the hook's own thrown message. */
function transport(log: Log): ToolTransport {
  return {
    id: 'scripted',
    ownsTool: (name) => name === 'web_search',
    callTool: async (name, args) => {
      log.push({ name, args })
      return { success: true, data: { ok: true } }
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

/** The hook under test: it throws quoting the outgoing arguments it was handed,
 * which is exactly the failure shape N8-09 must not leak through an event. */
const throwingHook = () => ({
  onToolResult: async (
    _tool: string,
    _result: unknown,
    { args }: { callId?: string; args: Record<string, unknown> },
  ) => {
    throw new Error(`hook failed on outgoing args: ${JSON.stringify(args)}`)
  },
})

type Probs = typeof PUBLIC
function egressDecide(script: (Probs | 'hang')[]) {
  const calls = { n: 0 }
  const fn = (async () => {
    const step = script[Math.min(calls.n++, script.length - 1)]
    if (step === 'hang') return new Promise<never>(() => {})
    return { probs: step, method: 'jev', calibrated: false }
  }) as unknown as DecideFn
  Object.assign(fn, { supportedTypes: ['choice'], calls })
  return fn as DecideFn & { calls: { n: number } }
}

const loop = (controller: ControllerFn, tools: string[], config: object = {}) =>
  simpleLoop<Data>(controller, tools, { patternId: 'web', maxTurns: 6, ...config })

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

const batchWithSentinel = () =>
  act(
    'web_search',
    { query: SENTINEL },
    {
      additional_calls: [{ tool_name: 'web_search', tool_args: JSON.stringify({ query: 'two' }) }],
    },
  )

const errorEvents = (events: unknown[]) =>
  events
    .filter((event) => (event as { type?: string }).type === 'error')
    .map((event) => (event as { data?: { error?: string } }).data?.error ?? '')

describe('N8 hook-error channel stays metadata-only', () => {
  it('withholds a throwing hook raw diagnostic from zero-held batch events', async () => {
    const log: Log = []
    const live: unknown[] = []
    const web = scripted([batchWithSentinel(), done])
    const patterns = agent(
      { web: loop(web.fn, ['web_search'], throwingHook()) },
      ['web', DECISION_LOOP_ANSWER],
      { decide: egressDecide([PUBLIC, PUBLIC]) },
    )
    const result = await harness<Data>(...patterns)(
      'find it',
      'review-hook-zero-held',
      undefined,
      (event) => live.push(event),
      frameOf(log, memoryStore()),
    )
    expect(log).toHaveLength(2) // both members dispatched through the synthetic transport
    const errors = errorEvents(result.context.events)
    expect(errors).toContain(FIXED_HOOK_ERROR)
    expect(JSON.stringify(result.context.events)).not.toContain(SENTINEL)
    expect(JSON.stringify(live)).not.toContain(SENTINEL)
  })

  it('withholds a throwing hook raw diagnostic from resumed held-batch events', async () => {
    const log: Log = []
    const live: unknown[] = []
    const store = memoryStore()
    const web = scripted([batchWithSentinel(), done])
    const patterns = agent(
      { web: loop(web.fn, ['web_search'], throwingHook()) },
      ['web', DECISION_LOOP_ANSWER],
      { decide: egressDecide([PERSONAL, PERSONAL]) },
    )
    const frame = frameOf(log, store)
    const paused = await harness<Data>(...patterns)(
      'find it',
      'review-hook-held',
      undefined,
      (event) => live.push(event),
      frame,
    )
    expect(paused.status).toBe('paused')
    expect(log).toEqual([])
    const [request] = readHitl(paused.context).pending
    expect(request).toBeDefined()
    const flags = Object.fromEntries(
      (request.options[0].flags ?? []).map((flag) => [flag.id, true]),
    ) // every checklist row accepted: both members re-enter
    const resumed = await resumeHarness<Data>(
      paused.serialized,
      patterns,
      { [request.requestId]: { choice: 'continue', flags } },
      { frame, onEvent: (event) => live.push(event) },
    )
    expect(resumed.status).not.toBe('paused')
    expect(log).toEqual([
      { name: 'web_search', args: { query: SENTINEL } },
      { name: 'web_search', args: { query: 'two' } },
    ]) // the released members did dispatch, with their exact arguments
    const errors = errorEvents(resumed.context.events)
    expect(errors).toContain(FIXED_HOOK_ERROR)
    expect(JSON.stringify(resumed.context.events)).not.toContain(SENTINEL)
    expect(JSON.stringify(live)).not.toContain(SENTINEL)
  })

  it('retains the raw hook diagnostic on a non-N8 batch', async () => {
    const log: Log = []
    const live: unknown[] = []
    const web = scripted([batchWithSentinel(), done])
    // No egress gate: `plan` stays undefined, so batchEventSafe is false and
    // the original `for <tool>: <message>` diagnostic is the pinned behaviour.
    const patterns = [loop(web.fn, ['web_search'], throwingHook())]
    const result = await harness<Data>(...patterns)(
      'find it',
      'review-hook-non-n8',
      undefined,
      (event) => live.push(event),
      frameOf(log, memoryStore()),
    )
    expect(log).toHaveLength(2)
    const errors = errorEvents(result.context.events)
    expect(errors.some((message) => message.includes(SENTINEL))).toBe(true)
    expect(JSON.stringify(live)).toContain(SENTINEL)
  })
})
