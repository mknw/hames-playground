// @vitest-environment node
/**
 * Where the turn's clock block (`current_time`) lands in every prompt that
 * takes it: Router, LoopController, ControllerThinking, ActorController,
 * Planner, PlannerThinking, Synthesize.
 *
 * Three properties, each one a way the block could cost more than it is worth:
 *
 * 1. **After the last cache marker.** The block changes every turn. Rendered
 *    inside a #122 cached prefix (the controllers' agent-static tier 1 or
 *    run-static tier 2, the actor's task frame, the planner's tool catalog) it
 *    would make every cache read a cache write. Asserted on the Anthropic wire,
 *    the only one that carries `cache_control`.
 * 2. **In a user message, never a system one.** A system block after a message
 *    is a 400 on vLLM (`prompt-role-order.test.ts` pins the rule for every
 *    function; this pins the block's own role).
 * 3. **Null renders nothing.** A run with no clock sends the prompt it sent
 *    before this parameter existed.
 *
 * Mutations, each verified to redden this file:
 *   - move `{{ CurrentTime(current_time) }}` in `LoopControllerBody` into the
 *     tier-2 block (beside INTENT) → LoopController/ControllerThinking fail (1).
 *   - move it in `PlannerBody` above the tier-1 marker → Planner fails (1).
 *   - render it under `_.role("system")` in Synthesize → Synthesize fails (2).
 *   - drop the `{% if current_time %}` guard in `CurrentTime` → (3) fails.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type {
  Attempt,
  LoopTurn,
  Message,
  RouteOption,
  ToolDescription,
} from '@hames-ai/harness-baml/baml_client/types'

const ENV = {
  LARGE_LLM_BASE_URL: 'https://example.invalid/deployment/v1',
  LARGE_LLM_API_KEY: 'offline-render-test',
  SMALL_LLM_BASE_URL: 'https://example.invalid/v1',
  SMALL_LLM_API_KEY: 'offline-render-test',
  ANTHROPIC_API_KEY: 'offline-render-test',
}
const ANTHROPIC = { client: 'AnthropicSonnet5', env: ENV }
const OPENAI = { client: 'LargeQwen', env: ENV }
const THINK = { client: 'LargeQwenThink', env: ENV }

const BLOCK = 'CURRENT TIME (sentinel): Thursday, 2026-11-05, 00:30 UTC+01:00 (Europe/Brussels)'

type BamlRequest = (typeof import('@hames-ai/harness-baml/baml_client').b)['request']
let request: BamlRequest
beforeAll(async () => {
  request = (await import('@hames-ai/harness-baml/baml_client')).b.request
})

const TOOLS: ToolDescription[] = [{ name: 'search', description: 'Search', args_schema: '{}' }]
const HISTORY: Message[] = [
  { role: 'user', content: 'earlier question' },
  { role: 'assistant', content: 'earlier answer' },
]
const ROUTES: RouteOption[] = [{ name: 'graph', description: 'Graph questions' }]
const TURNS: LoopTurn[] = [
  {
    n: 0,
    reasoning: 'r',
    status: 's',
    tool_call: { tool: 'search', args: '{}' },
    tool_result: { tool: 'search', result: 'rows', success: true },
  },
  {
    n: 1,
    reasoning: 'r',
    status: 's',
    tool_call: { tool: 'search', args: '{}' },
    tool_result: { tool: 'search', result: 'more rows', success: true },
  },
]
const ATTEMPTS: Attempt[] = [
  {
    n: 1,
    action: { reasoning: 'r', tool_name: 'search', tool_args: '{}', status: 's', is_final: false },
    result: 'rows',
    feedback: 'not enough',
  },
]

type Render = (time: string | null, opts: object) => Promise<{ body: { json(): unknown } }>
const FUNCTIONS: [string, Render, object][] = [
  ['Router', (t, o) => request.Router('q', ROUTES, HISTORY, 'MEMORY', t, o), ANTHROPIC],
  [
    'LoopController',
    (t, o) =>
      request.LoopController('q', 'i', TOOLS, TURNS, 'CTX', null, null, null, 'PLAN', null, t, o),
    ANTHROPIC,
  ],
  [
    'ControllerThinking',
    (t, o) =>
      request.ControllerThinking(
        'q',
        'i',
        TOOLS,
        TURNS,
        'CTX',
        null,
        null,
        null,
        'PLAN',
        null,
        t,
        o,
      ),
    THINK,
  ],
  [
    'ActorController',
    (t, o) => request.ActorController('q', 'i', TOOLS, ATTEMPTS, 'CTX', null, 2, 5, null, t, o),
    ANTHROPIC,
  ],
  ['Planner', (t, o) => request.Planner('q', 'i', TOOLS, 'CTX', t, o), ANTHROPIC],
  ['PlannerThinking', (t, o) => request.PlannerThinking('q', 'i', TOOLS, 'CTX', t, o), THINK],
  ['Critic', (t, o) => request.Critic('i', ATTEMPTS, t, o), ANTHROPIC],
  ['CriticThinking', (t, o) => request.CriticThinking('i', ATTEMPTS, t, o), THINK],
  ['CompactIntent', (t, o) => request.CompactIntent(HISTORY, 'latest', t, o), ANTHROPIC],
  [
    'Synthesize',
    // references, guide (#985), then current_time: the two string slots are
    // adjacent, so a swap typechecks — the guide slot stays null here.
    (t, o) => request.Synthesize('q', 'i', TURNS, false, null, 'MEMORY', null, null, t, o),
    ANTHROPIC,
  ],
]

interface Part {
  role: string
  text: string
  cached: boolean
}
/** The body as an ordered list of content parts, each with its message's role. */
function parts(body: unknown): Part[] {
  const b = body as {
    system?: string | { text?: string; cache_control?: unknown }[]
    messages: {
      role: string
      content: string | { text?: string; cache_control?: unknown }[]
    }[]
  }
  const out: Part[] = []
  const push = (role: string, c: string | { text?: string; cache_control?: unknown }[]) => {
    for (const p of typeof c === 'string' ? [{ text: c }] : c) {
      out.push({ role, text: p.text ?? '', cached: 'cache_control' in p && !!p.cache_control })
    }
  }
  if (b.system) push('system', b.system)
  for (const m of b.messages) push(m.role, m.content)
  return out
}

describe('current_time placement', () => {
  it.each(FUNCTIONS)(
    '%s renders the block once, in a user part after every cache marker',
    async (_name, render, opts) => {
      const seq = parts((await render(BLOCK, opts)).body.json())
      const at = seq.findIndex((p) => p.text.includes(BLOCK))
      expect(at, 'block rendered').toBeGreaterThan(-1)
      expect(seq.filter((p) => p.text.includes(BLOCK))).toHaveLength(1)
      expect(seq[at].role).toBe('user')
      expect(seq[at].cached).toBe(false)
      const lastCached = seq.map((p) => p.cached).lastIndexOf(true)
      expect(at).toBeGreaterThan(lastCached)
    },
  )

  it.each(FUNCTIONS)(
    '%s keeps the cache markers it had (the prefix is intact)',
    async (_n, render, opts) => {
      const marks = (t: string | null) => async () =>
        parts((await render(t, opts)).body.json())
          .filter((p) => p.cached)
          .map((p) => p.text)
      expect(await marks(BLOCK)()).toEqual(await marks(null)())
    },
  )

  // (2) on the wire that enforces it: Anthropic rewrites a later system block to
  // `user`, so a block rendered under `_.role("system")` passes the Anthropic case
  // above and is a 400 on vLLM. Mutation (synth block under a system role) → red.
  it.each(FUNCTIONS)(
    '%s puts the block in a user message on the OpenAI-compatible wire',
    async (_name, render, opts) => {
      const wire = opts === THINK ? THINK : OPENAI
      const seq = parts((await render(BLOCK, wire)).body.json())
      const at = seq.findIndex((p) => p.text.includes(BLOCK))
      expect(at).toBeGreaterThan(-1)
      expect(seq[at].role).toBe('user')
    },
  )

  it.each(FUNCTIONS)('%s renders nothing for a null block', async (_name, render) => {
    const text = JSON.stringify((await render(null, OPENAI)).body.json())
    expect(text).not.toContain('CURRENT TIME')
  })

  it('the Anthropic leaf actually carries cache markers here (guards (1) from passing vacuously)', async () => {
    const seq = parts((await FUNCTIONS[1][1](BLOCK, ANTHROPIC)).body.json())
    expect(seq.filter((p) => p.cached).length).toBeGreaterThanOrEqual(2)
  })
})
