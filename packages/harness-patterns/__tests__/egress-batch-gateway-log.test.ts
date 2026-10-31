/** N8-09 gateway warning regression: fake MCP SDK, no network or provider. */
import { afterEach, expect, it, vi } from 'vitest'
import { harness, resumeHarness } from '../harness.server'
import { readHitl } from '../hitl.server'
import { callTool, closeMcpClient, isReadOnlyTool } from '../mcp-client.server'
import { decisionLoop, DECISION_LOOP_ANSWER } from '../patterns/decisionLoop.server'
import { simpleLoop } from '../patterns/simpleLoop.server'
import { withEgressGate } from '../patterns/withEgressGate.server'
import { registerToolNamespaces } from '../tools.server'
import type { RunFrame } from '../run-frame.server'
import type { ControllerAction, ControllerFn, DecideFn } from '../types'

type Data = Record<string, unknown> & { response?: string }
const SENTINEL = 'n8-outgoing-sentinel-895'
const { gatewayCall, gatewayClose } = vi.hoisted(() => ({
  gatewayCall: vi.fn(),
  gatewayClose: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = vi.fn(async () => undefined)
    close = gatewayClose
    callTool = gatewayCall
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}))

afterEach(async () => {
  await closeMcpClient()
  vi.restoreAllMocks()
  gatewayCall.mockReset()
  gatewayClose.mockReset()
})

it.each([false, true])(
  'withholds an N8 non-read gateway error from server logs and events without retrying (held=%s)',
  async (held) => {
    const unregister = registerToolNamespaces((name) =>
      name === 'create_issue' ? 'github' : name === 'read_neo4j_cypher' ? 'neo4j' : undefined,
    )
    try {
      gatewayCall.mockRejectedValue(new Error(`transport dropped: payload=${SENTINEL}`))
      const timeline: string[] = []
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
        timeline.push('warn')
      })
      const args = { title: SENTINEL }
      const action: ControllerAction = {
        reasoning: 'send a batch',
        tool_name: 'create_issue',
        tool_args: JSON.stringify(args),
        status: 'calling',
        is_final: false,
        additional_calls: [
          { tool_name: 'create_issue', tool_args: JSON.stringify({ title: 'second' }) },
        ],
      }
      const controller = vi.fn<ControllerFn>(async ({ turn }) => ({
        action:
          turn === 0
            ? action
            : {
                reasoning: 'done',
                tool_name: 'Return',
                tool_args: 'done',
                status: 'done',
                is_final: true,
              },
      }))
      const publicDecide = Object.assign(
        (async () => ({
          probs: held
            ? { personal: 0.9, company: 0.05, nothing_private: 0.05 }
            : { personal: 0, company: 0, nothing_private: 1 },
          method: 'jev',
          calibrated: false,
        })) as unknown as DecideFn,
        { supportedTypes: ['choice'] },
      )
      let route = 0
      const routeDecide = Object.assign(
        (async ({ spec }: { spec: { labels: readonly { id: string }[] } }) => {
          const wanted = route++ === 0 ? 'web' : DECISION_LOOP_ANSWER
          return {
            probs: Object.fromEntries(spec.labels.map(({ id }) => [id, id === wanted ? 1 : 0])),
            method: 'jev',
            calibrated: false,
          }
        }) as unknown as DecideFn,
        { supportedTypes: ['choice'], limits: () => ({ contextWindow: 131_072 }) },
      )
      const pattern = withEgressGate({
        local: ['neo4j'],
        catalog: ['create_issue', 'read_neo4j_cypher'],
        decide: publicDecide,
        askPerson: true,
      })(
        decisionLoop<Data>(
          {
            web: {
              pattern: simpleLoop<Data>(controller, ['create_issue'], {
                patternId: 'web',
                maxTurns: 3,
              }),
              description: 'outgoing route',
            },
          },
          { decide: routeDecide, answer: 'Answer now', patternId: 'orchestrator', gatedTools: [] },
        ),
      )
      const claims = new Map<string, string>()
      const payloads = new Map<string, { kind: string; payload: unknown }>()
      const frame: RunFrame = {
        hitlPayloads: {
          hold: async ({ kind, payload }) => {
            const payloadRef = `payload-${payloads.size}`
            payloads.set(payloadRef, { kind, payload })
            return { payloadRef, inserted: true }
          },
          load: async (payloadRef) => payloads.get(payloadRef) ?? null,
          drop: async () => undefined,
        },
        toolSendClaims: {
          claim: async ({ runId, callKey, digest }) => {
            const key = `${runId}:${callKey}`
            if (claims.has(key))
              return { status: claims.get(key) === digest ? 'unknown' : 'mismatch' }
            claims.set(key, digest)
            return { status: 'new' }
          },
          finish: async () => undefined,
        },
      }
      const live: unknown[] = []
      const pausedOrDone = await harness<Data>(pattern)(
        'synthetic request',
        'review-gateway-log',
        undefined,
        (event) => {
          timeline.push(event.type)
          live.push(event)
        },
        frame,
      )
      let result = pausedOrDone
      if (held) {
        expect(pausedOrDone.status).toBe('paused')
        expect(gatewayCall).not.toHaveBeenCalled()
        const [request] = readHitl(pausedOrDone.context).pending
        expect(request).toBeDefined()
        const flags = Object.fromEntries(
          (request.options[0].flags ?? []).map((flag) => [flag.id, true]),
        )
        result = await resumeHarness<Data>(
          pausedOrDone.serialized,
          [pattern],
          { [request.requestId]: { choice: 'continue', flags } },
          {
            frame,
            onEvent: (event) => {
              timeline.push(event.type)
              live.push(event)
            },
          },
        )
      }

      expect(isReadOnlyTool('create_issue')).toBe(false)
      expect(gatewayCall).toHaveBeenCalledTimes(2) // two batch members, neither retried
      expect(gatewayClose).toHaveBeenCalledTimes(2) // each broken lease is reset
      expect(gatewayCall).toHaveBeenCalledWith({ name: 'create_issue', arguments: args })
      expect(result.context.events.some((event) => event.type === 'tool_result')).toBe(true)
      expect(timeline.indexOf('warn')).toBeLessThan(timeline.lastIndexOf('tool_result'))
      expect(JSON.stringify(result.context.events)).not.toContain(SENTINEL)
      expect(JSON.stringify(live)).not.toContain(SENTINEL)
      expect(warn).toHaveBeenCalledTimes(2)
      expect(
        warn.mock.calls.every(([message]) =>
          String(message).includes('transport error details withheld for executing batch'),
        ),
      ).toBe(true)
      expect(JSON.stringify(warn.mock.calls)).not.toContain(SENTINEL)
    } finally {
      unregister()
    }
  },
)

it('retains the ordinary non-N8 transport diagnostic and no-retry rule', async () => {
  gatewayCall.mockRejectedValue(new Error(`transport dropped: payload=${SENTINEL}`))
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const result = await callTool('create_issue', { title: SENTINEL })
  expect(result).toMatchObject({ success: false, error: `transport dropped: payload=${SENTINEL}` })
  expect(gatewayCall).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(warn.mock.calls)).toContain(SENTINEL)
})
