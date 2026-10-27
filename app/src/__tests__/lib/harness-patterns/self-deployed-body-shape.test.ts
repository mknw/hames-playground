/**
 * What the PRIVATE TIER actually puts on the wire — for every function it routes,
 * against the client it routes that function to.
 *
 * `clients-self-deployed.test.ts` pins the ROUTING decision (which role goes where).
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
 * the 4B `SmallQwen` and everything else to the 27B `LargeQwen`, so this
 * file derives each function's client from `SELF_DEPLOYED_CLIENT_BY_ROLE` rather than
 * rendering everything against one name. The reason is not tidiness: rendering a
 * describe function against `LargeQwen` would pin a request nothing makes, and
 * the 4B's own body would then be checked by nothing at all — while the file
 * still read as complete coverage of the tier.
 *
 * The `enable_thinking` check applies to BOTH clients, for the same reason and a
 * different weight: Qwen3.5-4B is a thinking model too, and its output cap is
 * 2 048 rather than 16 384, so an unsuppressed reasoning block does not just eat
 * the budget — it eats all of it. The `cache_control` and served-model checks are
 * LargeQwen's alone: they are properties of the confidential-compute deployment.
 *
 * Rendered offline via `b.request.*`: no socket is opened, so this runs in CI
 * where the endpoint is unreachable. The live counterpart is
 * `scripts/smoke-self-deployed.ts`.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import type { LoopTurn, ToolDescription } from '@hames-ai/harness-baml/baml_client/types'
import { DEFAULT_LARGE_LLM_MODEL } from '@hames-ai/harness-baml/inference-env.server'

// This file renders requests in a jsdom environment; `clients.server.ts` is
// imported for its derived function set only, never to route anything.
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

/** Fakes: rendering a request needs the options to resolve, not to connect. */
const ENV = {
  LARGE_LLM_BASE_URL: 'https://example.invalid/deployment/v1',
  LARGE_LLM_API_KEY: 'offline-render-test',
  // The model id the UNSET path puts on the wire: the default the boot
  // normalization applies, imported — not restated — so a changed default is
  // caught by the pins below rather than by a stale copy.
  LARGE_LLM_MODEL: DEFAULT_LARGE_LLM_MODEL,
  SMALL_LLM_BASE_URL: 'https://example.invalid/small/v1',
  SMALL_LLM_API_KEY: 'offline-render-test',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'offline-render-test',
}
const SELF_DEPLOYED = { client: 'LargeQwen', env: ENV }
/** The 4B summarizer the tier routes `describe` to. Same options-bag contract. */
const SMALL = { client: 'SmallQwen', env: ENV }

type Body = {
  model?: string
  max_tokens?: number
  chat_template_kwargs?: Record<string, unknown>
  messages?: unknown[]
}

// ONE corpus: every function in the CALLS table below is declared in
// `packages/harness-baml/baml_src` and generated into the committed client
// this imports — the same `b` the adapters call in production, so what is
// rendered here is what goes on the wire.
type BamlRequest = (typeof import('@hames-ai/harness-baml/baml_client').b)['request']
let b: { request: BamlRequest }

beforeAll(async () => {
  // Bound, not extracted: the generated `request` methods read private
  // `runtime` / `ctxManager` state off `this`, so pulling one out and calling
  // it dies with "Cannot read properties of undefined (reading 'runtime')".
  const client = await import('@hames-ai/harness-baml/baml_client')
  b = { request: client.b.request }
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
      b.request.LoopController(
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
        SELF_DEPLOYED,
      ),
  ],
  [
    'ActorController',
    () => b.request.ActorController('q', 'i', TOOLS, [], null, null, 1, 5, null, SELF_DEPLOYED),
  ],
  ['Critic', () => b.request.Critic('i', [], SELF_DEPLOYED)],
  [
    'Synthesize',
    () => b.request.Synthesize('q', 'i', TURNS, false, null, null, null, SELF_DEPLOYED),
  ],
  [
    'Router',
    () =>
      b.request.Router('q', [{ name: 'search', description: 'd' }], MESSAGES, null, SELF_DEPLOYED),
  ],
  ['Planner', () => b.request.Planner('q', 'i', TOOLS, null, SELF_DEPLOYED)],
  // The eight describe functions, on the 4B — the shipped route since the flip
  // (six of them at the flip, the two memory functions of #419 M9 since).
  ['ResultDescribe', () => b.request.ResultDescribe('search', '{}', 'r', 'rows', SMALL)],
  ['ResultDescribeBatch', () => b.request.ResultDescribeBatch(DESCRIBE_TARGETS, SMALL)],
  ['GenerateConversationTitle', () => b.request.GenerateConversationTitle('q', SMALL)],
  ['CompactIntent', () => b.request.CompactIntent(MESSAGES, 'q', SMALL)],
  ['RetrieveQuery', () => b.request.RetrieveQuery(MESSAGES, 'q', SMALL)],
  ['ReferenceSelector', () => b.request.ReferenceSelector('i', MESSAGES, CANDIDATES, SMALL)],
  ['ExtractMemory', () => b.request.ExtractMemory('preference', 'USER: q', 'q', SMALL)],
  [
    'CompactMemories',
    () =>
      b.request.CompactMemories(
        'preference',
        [{ content: 'likes tea', evidence: 'I like tea', last_seen: '2026-10-01' }],
        SMALL,
      ),
  ],
  [
    'ScreenUntrustedContent',
    () =>
      b.request.ScreenUntrustedContent(
        'web/fetch',
        'fetched page text',
        '0123456789abcdef',
        SELF_DEPLOYED,
      ),
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
    const { SELF_DEPLOYED_CLIENT_BY_ROLE, SWITCHED_FUNCTIONS_BY_ROLE } =
      await import('@hames-ai/harness-baml/clients.server')
    const MODEL_OF: Record<string, string> = {
      LargeQwen: DEFAULT_LARGE_LLM_MODEL,
      SmallQwen: 'qwen3.5-4b-instruct',
    }
    const expected = new Map<string, string>()
    for (const [role, fns] of Object.entries(SWITCHED_FUNCTIONS_BY_ROLE)) {
      if (role === 'decide') continue // REST systemone, outside the BAML corpus.
      const client =
        SELF_DEPLOYED_CLIENT_BY_ROLE[role as keyof typeof SELF_DEPLOYED_CLIENT_BY_ROLE]!
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
    // Without this, adding a role to `SELF_DEPLOYED_CLIENT_BY_ROLE` would route new
    // functions to a client whose one silent-failure property nothing checked
    // for them. Compared against the derived set, so the list above cannot go
    // short — and `ScreenUntrustedContent` is now present in BOTH, which is the
    // inversion of what this line pinned until 2026-08-26 (SD-4: the screen
    // moved on an explicit owner decision, so it is checked like every other
    // routed function rather than excluded).
    const { TIER_SWITCHED_FUNCTIONS } = await import('@hames-ai/harness-baml/clients.server')
    expect(CALLS.map(([name]) => name).sort()).toEqual(
      // The reasoning twins are pinned separately in planner-thinking-render.test.ts
      // and openrouter-route-body-shape.test.ts — they render on the thinking
      // leaves, not on the tier's non-thinking clients.
      [...TIER_SWITCHED_FUNCTIONS]
        .filter(
          (n) =>
            n !== 'Decide' &&
            n !== 'PlannerThinking' &&
            n !== 'ControllerThinking' &&
            n !== 'CriticThinking',
        )
        .sort(),
    )
    expect(CALLS.map(([name]) => name)).toContain('ScreenUntrustedContent')
  })

  it('names the served model id exactly', async () => {
    const body = (await CALLS[0][1]()).body.json() as Body
    // `GET /v1/models` reports one model and vLLM 400s any other id.
    // TWO pins now, because the id is env-overridable: the LITERAL (this
    // line — the DEFAULT path must fail here, not merely pass, if the default
    // changes) and the constant the default is held in. The render resolves
    // `env.LARGE_LLM_MODEL` through the bag's DEFAULT, so a drifted default
    // fails the literal below rather than pinning itself.
    expect(body.model).toBe('Qwen/Qwen3.8-27B-FP8')
    expect(DEFAULT_LARGE_LLM_MODEL).toBe('Qwen/Qwen3.8-27B-FP8')
    const { CLIENT_MAX_OUTPUT_TOKENS } = await import('../../../lib/settings')
    expect(body.max_tokens).toBe(CLIENT_MAX_OUTPUT_TOKENS.LargeQwen)
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
    expect(body.max_tokens).toBe(CLIENT_MAX_OUTPUT_TOKENS.SmallQwen)
    expect(body.max_tokens).toBeLessThan(CLIENT_MAX_OUTPUT_TOKENS.LargeQwen)
  })

  it('carries a recalled memory block on the wire as ONE user message, and costs nothing when absent', async () => {
    // `memory_context` is the trailing optional parameter of Router and
    // Synthesize (#419 M9). Two properties, both silent when lost: an absent
    // block must leave the body BYTE-IDENTICAL to the pre-memory prompt (every
    // non-memory agent's cached prefix and prompt budget ride on that), and a
    // present one must reach the private-tier body as DATA in a user message —
    // never in the leading system message, where the template would be handing
    // per-user text the instruction channel.
    const ROUTES = [{ name: 'search', description: 'd' }]
    const MEMORY = 'MEMTOKEN-7731: the user prefers metric units'
    const renders: [string, (memory: string | null | undefined) => Promise<unknown>][] = [
      [
        'Router',
        (m) =>
          m === undefined
            ? b.request.Router('q', ROUTES, MESSAGES, undefined, SELF_DEPLOYED)
            : b.request.Router('q', ROUTES, MESSAGES, m, SELF_DEPLOYED),
      ],
      [
        'Synthesize',
        (m) => b.request.Synthesize('q', 'i', TURNS, false, null, m, null, SELF_DEPLOYED),
      ],
    ]
    for (const [name, render] of renders) {
      const bodyOf = async (m: string | null | undefined) =>
        ((await render(m)) as { body: { json(): unknown } }).body.json() as Body
      const absent = JSON.stringify(await bodyOf(null))
      expect(JSON.stringify(await bodyOf(undefined)), name).toBe(absent)
      expect(absent, name).not.toContain('MEMTOKEN')
      // …and not even the block's FRAMING: a template that rendered its header
      // around an empty body would pass the byte-for-byte comparison above
      // against `undefined` while still changing every non-memory prompt.
      expect(absent, name).not.toContain('WHAT YOU REMEMBER')
      const present = await bodyOf(MEMORY)
      const messages = present.messages as { role: string; content: unknown }[]
      const carrying = messages.filter((m) => JSON.stringify(m.content).includes('MEMTOKEN-7731'))
      expect(carrying, name).toHaveLength(1)
      expect(carrying[0].role, name).toBe('user')
      expect(messages[0].role, name).toBe('system')
      expect(JSON.stringify(messages[0].content), name).not.toContain('MEMTOKEN')
    }
  })

  it('sends no cache_control anywhere in the body, where the Anthropic chain does', async () => {
    const self_deployed = JSON.stringify((await CALLS[0][1]()).body.json())
    expect(self_deployed).not.toContain('cache_control')
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
