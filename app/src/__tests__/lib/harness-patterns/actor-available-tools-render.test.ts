/** #613: the actor adapter renders `input.availableTools` UNION its own
 * `toolNames`, so an agent declares the allowlist once. Runs the real adapter
 * and renders the real ActorController request offline (`b.request`, no socket),
 * pinning the RENDERED catalogue rather than an adapter option. */
import { beforeAll, expect, it, vi } from 'vitest'
import '../../mocks/namespace-catalog'
import '../../../lib/inference/config.server'
import { withRunFrame } from '@hames-ai/harness-patterns'
import type { ActorInput } from '@hames-ai/harness-patterns'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

const NAMES = ['tool_alpha', 'tool_beta', 'tool_gamma', 'tool_withheld']
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = vi.fn()
    close = vi.fn()
    listTools = vi.fn(async () => ({
      tools: NAMES.map((name) => ({ name, description: `desc of ${name}`, inputSchema: {} })),
    }))
    callTool = vi.fn()
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}))

let lastBody = ''
beforeAll(async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'offline-render-test')
  vi.stubEnv('USE_VERDA_INFERENCE', '0')
  const { b } = await import('@hames-ai/harness-baml/baml_client')
  vi.spyOn(b, 'ActorController').mockImplementation((async (...args: unknown[]) => {
    const request = await b.request.ActorController(
      ...(args.slice(0, 9) as Parameters<typeof b.request.ActorController>),
    )
    lastBody = JSON.stringify(request.body.json())
    return {
      reasoning: 'r',
      tool_name: 'Return',
      tool_args: 'd',
      status: 'success',
      is_final: true,
    }
  }) as never)
})

const input = (availableTools: string[]): ActorInput => ({
  userMessage: 'synthetic task',
  intent: 'synthetic intent',
  availableTools,
  previousAttempts: [],
  attemptNumber: 1,
  maxAttempts: 3,
})
const catalogue = () =>
  [...lastBody.matchAll(/\\n- ([A-Za-z0-9_-]+): desc of /g)].map((m) => m[1]).sort()

const render = async (opts: { toolNames?: string[] }, available: string[]) => {
  const { createActorControllerAdapter } = await import('@hames-ai/harness-baml')
  const actor = createActorControllerAdapter(opts)
  await withRunFrame({ inference: { tier: 'anthropic' } }, () => actor(input(available)))
  return catalogue()
}

it('renders input.availableTools with no toolNames declared', async () => {
  expect(await render({}, ['tool_alpha', 'tool_beta'])).toEqual(['tool_alpha', 'tool_beta'])
})

it('renders the union of availableTools and toolNames, once each', async () => {
  expect(
    await render({ toolNames: ['tool_beta', 'tool_gamma'] }, ['tool_alpha', 'tool_beta']),
  ).toEqual(['tool_alpha', 'tool_beta', 'tool_gamma'])
})

it('never renders a tool that is in neither list', async () => {
  await render({ toolNames: ['tool_alpha'] }, ['tool_beta'])
  expect(lastBody).not.toContain('desc of tool_withheld')
  expect(lastBody).not.toContain('desc of tool_gamma')
})

it('renders nothing from the gateway when both are empty (sandbox shape)', async () => {
  expect(await render({}, [])).toEqual([])
})
