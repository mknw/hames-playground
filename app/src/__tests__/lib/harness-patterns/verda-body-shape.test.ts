/**
 * What `VerdaQwen` actually puts on the wire.
 *
 * `clients-verda.test.ts` pins the ROUTING decision (which role goes where).
 * This file pins the REQUEST, because two of the client's properties are
 * invisible in a routing assertion and both fail silently:
 *
 *   - `chat_template_kwargs.enable_thinking = false`. Qwen3.8 is a thinking
 *     model and this deployment runs vLLM with no reasoning parser, so with the
 *     kwarg missing the reasoning lands in `content` ahead of the JSON envelope
 *     (measured live 2026-08-25: `'We need to respond to user: … </think>\n\n
 *     {"ok": true}'` vs `'{"ok": true}'`) and eats the `max_tokens` the envelope
 *     needs. The failure mode is a degraded parse, never an error — nothing
 *     upstream would look wrong. The mechanism being pinned is that
 *     `openai-generic` forwards an unrecognised option into the body verbatim:
 *     a rename, a typo, or a provider change quietly stops sending it.
 *   - No `cache_control` on any message. The client omits
 *     `allowed_role_metadata`, so the controller templates' #122 breakpoints are
 *     dropped rather than forwarded, and nothing in a confidential-compute
 *     request asks a third party to retain a prompt. Note the BAML *log* prints
 *     the dropped metadata inline as `{"cache_control": …}::` in front of the
 *     message text, which reads alarmingly like it was sent — the rendered body
 *     is the authority, and this test is what makes that readable.
 *
 * Rendered offline via `b.request.*`: no socket is opened, so this runs in CI
 * where the endpoint is unreachable. The live counterpart is
 * `scripts/smoke-verda.ts`.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import type { LoopTurn, ToolDescription } from '../../../../baml_client/types'

/** Fakes: rendering a request needs the options to resolve, not to connect. */
const ENV = {
  VERDA_INFERENCE_ENDPOINT: 'https://example.invalid/deployment/v1',
  VERDA_INFERENCE_API_KEY: 'offline-render-test',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'offline-render-test',
}
const VERDA = { client: 'VerdaQwen', env: ENV }

type Body = {
  model?: string
  max_tokens?: number
  chat_template_kwargs?: Record<string, unknown>
  messages?: unknown[]
}

let b: typeof import('../../../../baml_client').b

beforeAll(async () => {
  b = (await import('../../../../baml_client')).b
})

const TOOLS: ToolDescription[] = [
  { name: 'search', description: 'Search', args_schema: '{"query":"string"}' },
]
const TURNS: LoopTurn[] = [
  {
    n: 1,
    tool_call: { tool: 'search', args: '{"query":"x"}' },
    tool_result: { tool: 'search', result: 'rows', success: true },
  },
]

/** The three routed roles' functions — controller (both loops), critic,
 *  compactExecution. The kwarg is declared on the CLIENT, so every one of them
 *  must carry it without any call site knowing about it. */
const CALLS: [string, () => Promise<{ body: { json(): unknown } }>][] = [
  [
    'LoopController',
    () =>
      b.request.LoopController('q', 'i', TOOLS, TURNS, null, null, null, null, null, null, VERDA),
  ],
  [
    'ActorController',
    () => b.request.ActorController('q', 'i', TOOLS, [], null, null, 1, 5, null, VERDA),
  ],
  ['Critic', () => b.request.Critic('i', [], VERDA)],
  ['Synthesize', () => b.request.Synthesize('q', 'i', TURNS, false, null, VERDA)],
]

describe('VerdaQwen request body', () => {
  it.each(CALLS)('%s disables the chat template’s thinking block', async (_name, render) => {
    const body = (await render()).body.json() as Body
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  it('names the served model id exactly', async () => {
    const body = (await CALLS[0][1]()).body.json() as Body
    // `GET /v1/models` reports one model and vLLM 400s any other id.
    expect(body.model).toBe('Qwen/Qwen3.8-27B-FP8')
    const { CLIENT_MAX_OUTPUT_TOKENS } = await import('../../../lib/settings')
    expect(body.max_tokens).toBe(CLIENT_MAX_OUTPUT_TOKENS.VerdaQwen)
  })

  it('sends no cache_control anywhere in the body, where the Anthropic chain does', async () => {
    const verda = JSON.stringify((await CALLS[0][1]()).body.json())
    expect(verda).not.toContain('cache_control')
    // Not a vacuous assertion: the SAME function on the declared chain carries
    // the breakpoints, so this proves the client's omission is what drops them
    // rather than the template having stopped rendering them.
    const anthropic = await b.request.LoopController(
      'q',
      'i',
      TOOLS,
      TURNS,
      null,
      null,
      null,
      null,
      null,
      null,
      {
        client: 'AnthropicSonnet5NoThink',
        env: ENV,
      },
    )
    expect(JSON.stringify(anthropic.body.json())).toContain('cache_control')
  })
})
