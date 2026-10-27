/**
 * A blocking request's payload, held for its logical call (decision-loop-agent
 * slice 8, core half): the call key `simpleLoop` computes, and
 * `askHumanHolding`, which holds the payload in the host's store before it asks
 * and names it on the request by `payloadRef` only.
 *
 * Each pin names the source mutation that turns it red; each was run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { harness, resumeHarness } from '../harness.server'
import { askHumanHolding, HitlRequestError, readHitl } from '../hitl.server'
import { configurePattern } from '../patterns/chain.server'
import { simpleLoop } from '../patterns/simpleLoop.server'
import { amendRunFrame, type RunFrame } from '../run-frame.server'
import type { ToolTransport } from '../tool-transport.server'
import type {
  ControllerAction,
  ControllerFn,
  HitlOption,
  HitlPayloadStore,
  HoldingOutcome,
  ToolCallEventData,
} from '../types'

type Data = Record<string, unknown> & { response?: string }

const OPTIONS: HitlOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject', unattended: true },
]
const REQUEST = {
  kind: 'graph-write',
  question: 'Change the knowledge graph?',
  options: OPTIONS,
  defaultOption: 'reject',
  summary: { count: 1 },
} as const

/** An in-memory store with the host's contract: insert-only per call key. */
function memoryStore() {
  const rows = new Map<string, { ref: string; kind: string; json: string }>()
  const dropped: string[] = []
  let n = 0
  const store: HitlPayloadStore = {
    hold: async ({ callKey, kind, payload }) => {
      const json = JSON.stringify(payload)
      const row = rows.get(callKey)
      if (!row) {
        const ref = `ref-${++n}`
        rows.set(callKey, { ref, kind, json })
        return { payloadRef: ref, inserted: true }
      }
      return row.kind === kind && row.json === json
        ? { payloadRef: row.ref, inserted: false }
        : { rebound: true }
    },
    drop: async (ref) => {
      dropped.push(ref)
      for (const [key, row] of rows) if (row.ref === ref) rows.delete(key)
    },
  }
  return { store, rows, dropped }
}

/** `gated_write` holds its arguments for a person; nothing else is offered. */
function transport(outcomes: HoldingOutcome[]): ToolTransport {
  return {
    id: 'holding',
    ownsTool: (name) => name === 'gated_write',
    callTool: async (_name, args) => {
      const outcome = await askHumanHolding(REQUEST, args)
      outcomes.push(outcome)
      if (outcome.status === 'rebound') return { success: false, data: null, error: 'rebound' }
      return outcome.status === 'pending'
        ? { success: true, data: { held: true, requestId: outcome.requestId, note: 'waiting' } }
        : { success: true, data: `answered: ${outcome.choice}` }
    },
    listTools: async () => [],
  }
}

const act = (tool: string, args: unknown = {}): { action: ControllerAction } => ({
  action: {
    reasoning: `use ${tool}`,
    tool_name: tool,
    tool_args: typeof args === 'string' ? args : JSON.stringify(args),
    status: '',
    is_final: tool === 'Return',
  },
})

/** turn → action. */
function controller(script: Record<number, { action: ControllerAction }>): ControllerFn {
  return vi.fn<ControllerFn>(async (input) => script[input.turn] ?? act('Return', 'done'))
}

const loop = (c: ControllerFn) =>
  simpleLoop<Data>(c, ['gated_write'], { patternId: 'work', maxTurns: 4 })

const callKeys = (events: { type: string; data: unknown }[]) =>
  events.filter((e) => e.type === 'tool_call').map((e) => (e.data as ToolCallEventData).callKey)

/** Run to the pause; resume with Approve; return both results. */
async function pauseThenApprove(patterns: ReturnType<typeof loop>[], frame: RunFrame) {
  const paused = await harness<Data>(...patterns)(
    'change it',
    'sess-8',
    undefined,
    undefined,
    frame,
  )
  expect(paused.status).toBe('paused')
  const [request] = readHitl(paused.context).pending
  const resumed = await resumeHarness<Data>(
    paused.serialized,
    patterns,
    { [request.requestId]: 'approve' },
    { frame },
  )
  return { paused, request, resumed }
}

afterEach(() => vi.restoreAllMocks())

describe('slice 8 · askHumanHolding', () => {
  // MUTATION: drop either precondition → a request is raised whose payload is
  // held nowhere, or bound to no call → red.
  it('needs the call key and the host store', async () => {
    const { store, rows } = memoryStore()
    const thrown: unknown[] = []
    const asking = (withKey: boolean) =>
      configurePattern<Data>('gate', async (scope) => {
        const ask = () => askHumanHolding(REQUEST, { a: 1 })
        try {
          await (withKey ? amendRunFrame({ callKey: 'k' }, ask) : ask())
        } catch (error) {
          thrown.push(error)
        }
        return scope
      })
    // Inside a real run, so it is the precondition that refuses, not the run.
    await harness<Data>(asking(false))('q', 's', undefined, undefined, { hitlPayloads: store })
    await harness<Data>(asking(true))('q', 's')
    expect(thrown).toHaveLength(2)
    expect(thrown.every((e) => e instanceof HitlRequestError)).toBe(true)
    expect(String(thrown[0])).toMatch(/no callKey/)
    expect(String(thrown[1])).toMatch(/no hitlPayloads store/)
    expect(rows.size).toBe(0)
  })

  // MUTATION: ignore `rebound` (ask anyway) → a request is raised for a call
  // the store refused to rebind → red.
  it('a call rebound to a different payload raises no request', async () => {
    const outcomes: HoldingOutcome[] = []
    const { store } = memoryStore()
    // Hold a different payload under the key the loop's first call will have.
    const patterns = [loop(controller({ 0: act('gated_write', { title: 'B' }) }))]
    const frame: RunFrame = { transports: [transport(outcomes)], hitlPayloads: store }
    const hold = vi.spyOn(store, 'hold').mockResolvedValueOnce({ rebound: true })
    const result = await harness<Data>(...patterns)(
      'change it',
      'sess-8',
      undefined,
      undefined,
      frame,
    )

    expect(hold).toHaveBeenCalledTimes(1)
    expect(outcomes).toEqual([{ status: 'rebound' }])
    expect(readHitl(result.context).pending).toEqual([])
    expect(result.context.events.some((e) => e.type === 'hitl_request')).toBe(false)
  })

  // MUTATION: skip the drop on an answered outcome → the unattended run leaves
  // an orphaned payload row behind → red.
  it('an unattended run leaves no held payload behind', async () => {
    const outcomes: HoldingOutcome[] = []
    const { store, rows, dropped } = memoryStore()
    const patterns = [loop(controller({ 0: act('gated_write', { title: 'A' }) }))]
    const frame: RunFrame = {
      transports: [transport(outcomes)],
      hitlPayloads: store,
      hitl: { attended: false },
    }
    const result = await harness<Data>(...patterns)(
      'change it',
      'sess-8',
      undefined,
      undefined,
      frame,
    )

    expect(result.status).not.toBe('paused')
    expect(outcomes[0]).toMatchObject({ status: 'answered', choice: 'reject', by: 'unattended' })
    expect(dropped).toEqual(['ref-1'])
    expect(rows.size).toBe(0)
  })

  // MUTATION: key the request on the call alone (drop the digest) → with a
  // store that lets the call be rebound, the second payload is answered by
  // the FIRST payload's approval → red.
  it("the request's key covers the payload: a different payload is never answered by another's decision", async () => {
    const asked: HoldingOutcome[] = []
    const lax: HitlPayloadStore = {
      hold: async () => ({ payloadRef: 'ref-lax', inserted: false }),
      drop: async () => {},
    }
    // A pattern that is not resumable re-runs from its start on resume: the
    // first ask replays its approval, the second (another payload, same call)
    // must be a new request.
    const gate = configurePattern<Data>('gate', async (scope) => {
      await amendRunFrame({ callKey: 'one-call' }, async () => {
        asked.push(await askHumanHolding(REQUEST, { title: 'A' }))
        if (asked.at(-1)?.status === 'answered') {
          asked.push(await askHumanHolding(REQUEST, { title: 'B' }))
        }
      })
      return scope
    })
    const frame: RunFrame = { hitlPayloads: lax }
    const paused = await harness<Data>(gate)('change it', 'sess-8', undefined, undefined, frame)
    const [first] = readHitl(paused.context).pending
    expect(first.payloadRef).toBe('ref-lax')
    const resumed = await resumeHarness<Data>(
      paused.serialized,
      [gate],
      { [first.requestId]: 'approve' },
      { frame },
    )

    expect(asked.map((o) => o.status)).toEqual(['pending', 'answered', 'pending'])
    expect(resumed.status).toBe('paused')
    expect(readHitl(resumed.context).pending[0].key).not.toBe(first.key)
  })
})

describe('slice 8 · the logical call key', () => {
  // MUTATION: key on `currentToolCallId()` (a process-local counter) → a
  // retried resume in a fresh process computes another key, and a second row
  // is held → red.
  it('a retried resume reaching the same gate recomputes the same key and reuses the held payload', async () => {
    const outcomes: HoldingOutcome[] = []
    const { store, rows } = memoryStore()
    const script = { 0: act('gated_write', { title: 'A' }), 1: act('gated_write', { title: 'B' }) }
    const frame: RunFrame = { transports: [transport(outcomes)], hitlPayloads: store }
    const patterns = [loop(controller(script))]
    const paused = await harness<Data>(...patterns)(
      'change it',
      'sess-8',
      undefined,
      undefined,
      frame,
    )
    const [a] = readHitl(paused.context).pending
    const answers = { [a.requestId]: 'approve' }

    const first = await resumeHarness<Data>(paused.serialized, patterns, answers, { frame })
    expect(first.status).toBe('paused')
    const [b] = readHitl(first.context).pending

    // The same resume again — the save of the first was lost — in a fresh
    // process: the tool-call counter starts over.
    const counter = (globalThis as Record<symbol, { seq: number } | undefined>)[
      Symbol.for('hames.harness-patterns.tool-call-id')
    ]!
    counter.seq = 0
    const retried = await resumeHarness<Data>(
      paused.serialized,
      [loop(controller(script))],
      answers,
      { frame },
    )
    const [b2] = readHitl(retried.context).pending

    expect(b2.payloadRef).toBe(b.payloadRef)
    expect(rows.size).toBe(2)
    expect(callKeys(retried.context.events).at(-1)).toBe(callKeys(first.context.events).at(-1))
  })

  // MUTATION: leave the turn and the position out of the key → the second
  // identical write shares the first's key, its held row and its request
  // identity, and is approved by replay → red.
  it('two identical payloads in two calls are two requests', async () => {
    const outcomes: HoldingOutcome[] = []
    const { store, rows } = memoryStore()
    const same = act('gated_write', { title: 'A' })
    const patterns = [loop(controller({ 0: same, 1: same }))]
    const frame: RunFrame = { transports: [transport(outcomes)], hitlPayloads: store }
    const { request, resumed } = await pauseThenApprove(patterns, frame)

    expect(resumed.status).toBe('paused')
    const [second] = readHitl(resumed.context).pending
    expect(second.requestId).not.toBe(request.requestId)
    expect(second.payloadRef).not.toBe(request.payloadRef)
    expect(rows.size).toBe(2)
    const keys = callKeys(resumed.context.events)
    expect(new Set(keys).size).toBe(keys.length)
  })

  // MUTATION: drop the call key from the tool_call event → red.
  it('is recorded on the call it identifies', async () => {
    const outcomes: HoldingOutcome[] = []
    const { store } = memoryStore()
    const patterns = [loop(controller({ 0: act('gated_write', { title: 'A' }) }))]
    const frame: RunFrame = { transports: [transport(outcomes)], hitlPayloads: store }
    const paused = await harness<Data>(...patterns)(
      'change it',
      'sess-8',
      undefined,
      undefined,
      frame,
    )
    expect(callKeys(paused.context.events)).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)])
  })
})
