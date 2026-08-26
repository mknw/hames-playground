/**
 * What the PRIVATE TIER actually puts on the wire — for every function it routes,
 * against the client it routes that function to.
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
 * SINCE 2026-08-26 THAT IS TWO CLIENTS, not one. The tier routes `describe` to
 * the 4B `LocalQwenSmall` and everything else to the 27B `VerdaQwen`, so this
 * file derives each function's client from `VERDA_CLIENT_BY_ROLE` rather than
 * rendering everything against one name. The reason is not tidiness: rendering a
 * describe function against `VerdaQwen` would pin a request nothing makes, and
 * the 4B's own body would then be checked by nothing at all — while the file
 * still read as complete coverage of the tier.
 *
 * The `enable_thinking` check applies to BOTH clients, for the same reason and a
 * different weight: Qwen3.5-4B is a thinking model too, and its output cap is
 * 2 048 rather than 16 384, so an unsuppressed reasoning block does not just eat
 * the budget — it eats all of it. The `cache_control` and served-model checks are
 * VerdaQwen's alone: they are properties of the confidential-compute deployment.
 *
 * Rendered offline via `b.request.*`: no socket is opened, so this runs in CI
 * where the endpoint is unreachable. The live counterpart is
 * `scripts/smoke-verda.ts`.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import type { LoopTurn, ToolDescription } from '../../../../baml_client/types'

// This file renders requests in a jsdom environment; `clients.server.ts` is
// imported for its derived function set only, never to route anything.
vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

/** Fakes: rendering a request needs the options to resolve, not to connect. */
const ENV = {
  VERDA_INFERENCE_ENDPOINT: 'https://example.invalid/deployment/v1',
  VERDA_INFERENCE_API_KEY: 'offline-render-test',
  SMALL_LLM_BASE_URL: 'https://example.invalid/small/v1',
  SMALL_LLM_API_KEY: 'offline-render-test',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'offline-render-test',
}
const VERDA = { client: 'VerdaQwen', env: ENV }
/** The 4B summarizer the tier routes `describe` to. Same options-bag contract. */
const SMALL = { client: 'LocalQwenSmall', env: ENV }

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

const MESSAGES = [{ role: 'user', content: 'q' }]
const CANDIDATES = [{ ref_id: 'r1', tool: 'search', summary: 's', tool_args: null, ts_offset_s: 1 }]
const DESCRIBE_TARGETS = [
  { id: '1', tool: 'search', tool_args: '{}', reasoning: 'r', result: 'rows' },
]

/**
 * EVERY routed role's functions — which since 2026-08-26 is every function in
 * `baml_src/`, `ScreenUntrustedContent` included — each rendered against the
 * client the tier routes IT to (`describe` → the 4B, everything else → the 27B).
 * `renders each function against the client the tier routes it to` below pins
 * that pairing against the production map, so it cannot silently go stale.
 *
 * The kwarg is declared on the CLIENT, so all of them must carry it without any
 * call site knowing about it. That was cheap reassurance while only four heavy
 * functions took this route; it is the actual check now that the describe tier
 * does too, because a describe call is short and its `max_tokens` is the same
 * 16 384 — an unsuppressed reasoning block in `content` would eat a two-line
 * summary's whole budget and the failure mode is a degraded parse, never an
 * error. It matters a third time for the SCREEN: a reasoning block ahead of a
 * `ScreenVerdict` degrades the parse of `spans`, and a span that does not
 * survive character-for-character is one the guard cannot neutralize (SD-3),
 * so the failure would be a quietly weaker control rather than an error.
 * `TIER_SWITCHED_FUNCTIONS` is asserted equal to these names below, so a role
 * added to the map cannot skip this file.
 */
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
  ['Router', () => b.request.Router('q', [{ name: 'search', description: 'd' }], MESSAGES, VERDA)],
  ['Planner', () => b.request.Planner('q', 'i', TOOLS, null, VERDA)],
  // The six describe functions, on the 4B — the shipped route since the flip.
  ['ResultDescribe', () => b.request.ResultDescribe('search', '{}', 'r', 'rows', SMALL)],
  ['ResultDescribeBatch', () => b.request.ResultDescribeBatch(DESCRIBE_TARGETS, SMALL)],
  ['GenerateConversationTitle', () => b.request.GenerateConversationTitle('q', SMALL)],
  ['CompactIntent', () => b.request.CompactIntent(MESSAGES, 'q', SMALL)],
  ['RetrieveQuery', () => b.request.RetrieveQuery(MESSAGES, 'q', SMALL)],
  ['ReferenceSelector', () => b.request.ReferenceSelector('i', MESSAGES, CANDIDATES, SMALL)],
  [
    'ScreenUntrustedContent',
    () => b.request.ScreenUntrustedContent('web/fetch', 'fetched page text', VERDA),
  ],
]

describe('private-tier request bodies', () => {
  it.each(CALLS)('%s disables the chat template’s thinking block', async (_name, render) => {
    const body = (await render()).body.json() as Body
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  it('renders each function against the client the tier routes it to', async () => {
    // The pairing above is a hand-written table, and the failure it can have is
    // silent: retarget a function at the wrong client and the thinking check
    // still passes (both clients declare the kwarg) while the file pins a
    // request production never makes. So the table is compared against the
    // production map, by reading the `model` field off each rendered body — the
    // one field that names the client BAML actually resolved.
    const { VERDA_CLIENT_BY_ROLE, SWITCHED_FUNCTIONS_BY_ROLE } =
      await import('../../../lib/harness-patterns/clients.server')
    const MODEL_OF: Record<string, string> = {
      VerdaQwen: 'Qwen/Qwen3.8-27B-FP8',
      LocalQwenSmall: 'qwen3.5-4b-instruct',
    }
    const expected = new Map<string, string>()
    for (const [role, fns] of Object.entries(SWITCHED_FUNCTIONS_BY_ROLE)) {
      const client = VERDA_CLIENT_BY_ROLE[role as keyof typeof VERDA_CLIENT_BY_ROLE]!
      for (const fn of fns as readonly string[]) expected.set(fn, MODEL_OF[client])
    }
    // Every routed client has a model id here — a third one added to the tier
    // fails loudly rather than comparing against `undefined`.
    expect([...expected.values()].every(Boolean)).toBe(true)

    const wrong: string[] = []
    for (const [name, render] of CALLS) {
      const model = ((await render()).body.json() as Body).model
      if (model !== expected.get(name)) {
        wrong.push(`${name}: rendered ${model}, tier routes it to ${expected.get(name)}`)
      }
    }
    expect(wrong).toEqual([])
    // Not vacuous: the tier really does route two clients, so this comparison is
    // distinguishing something.
    expect(new Set(expected.values()).size).toBe(2)
  })

  it('renders every function a tier decision routes, and nothing it does not', async () => {
    // Without this, adding a role to `VERDA_CLIENT_BY_ROLE` would route new
    // functions to a client whose one silent-failure property nothing checked
    // for them. Compared against the derived set, so the list above cannot go
    // short — and `ScreenUntrustedContent` is now present in BOTH, which is the
    // inversion of what this line pinned until 2026-08-26 (SD-4: the screen
    // moved on an explicit owner decision, so it is checked like every other
    // routed function rather than excluded).
    const { TIER_SWITCHED_FUNCTIONS } = await import('../../../lib/harness-patterns/clients.server')
    expect(CALLS.map(([name]) => name).sort()).toEqual([...TIER_SWITCHED_FUNCTIONS].sort())
    expect(CALLS.map(([name]) => name)).toContain('ScreenUntrustedContent')
  })

  it('names the served model id exactly', async () => {
    const body = (await CALLS[0][1]()).body.json() as Body
    // `GET /v1/models` reports one model and vLLM 400s any other id.
    expect(body.model).toBe('Qwen/Qwen3.8-27B-FP8')
    const { CLIENT_MAX_OUTPUT_TOKENS } = await import('../../../lib/settings')
    expect(body.max_tokens).toBe(CLIENT_MAX_OUTPUT_TOKENS.VerdaQwen)
  })

  it('caps the 4B at its own max_tokens, not the 27B’s', async () => {
    // The describe flip's other half. 2 048 against the 27B's own cap is what
    // re-imposes `maxBatchItems()`'s batch-of-5 floor, so a body carrying the
    // 27B's number would mean the flip routed but did not re-budget — and the
    // summarizer would be asked for eight items' worth of output it cannot
    // produce. Written as the inequality plus the named mirror rather than as
    // two literals, so the 27B's cap can move (it did, in #279) without
    // touching this.
    const body = (
      await b.request.ResultDescribe('search', '{}', 'r', 'rows', SMALL)
    ).body.json() as Body
    const { CLIENT_MAX_OUTPUT_TOKENS } = await import('../../../lib/settings')
    expect(body.max_tokens).toBe(CLIENT_MAX_OUTPUT_TOKENS.LocalQwenSmall)
    expect(body.max_tokens).toBeLessThan(CLIENT_MAX_OUTPUT_TOKENS.VerdaQwen)
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
