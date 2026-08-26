/**
 * Where the `system` role is allowed to appear in a rendered prompt.
 *
 * OpenAI-compatible servers require every system message at the FRONT of the
 * conversation. vLLM enforces it literally — `400 {"message":"System message
 * must be at the beginning."}` — and rejects the whole request. Anthropic never
 * does: it lifts the LEADING system block into its top-level `system` field and
 * silently rewrites every later one to `user`, so a template can carry an
 * illegal ordering for as long as it only ever runs on that provider.
 *
 * That is exactly what shipped. `ActorController` emitted `system` markers in
 * two places after the conversation had started — the CONTEXT block in
 * `ActorTaskFrame` and every result block in `ActorAttemptLog` — and it went
 * unnoticed until the harness evals ran the actor against the self-hosted
 * deployment (`USE_VERDA_INFERENCE=1`, `baml_src/verda-client.baml`). There the
 * first attempt passed and every RETRY 400d, which kills actorCritic's whole
 * reason for existing on that route, silently: nothing fails until a critic
 * first rejects something.
 *
 * So this file pins two things.
 *
 * 1. **The invariant, over EVERY function** — not just the two that were wrong
 *    and not just the roles the Verda map routes today. The blast radius of the
 *    original defect was set by which client a role happened to resolve to, and
 *    that map is one edit away from moving; a template that is legal on both
 *    providers costs nothing and cannot regress this way.
 *
 * 2. **That the Anthropic path did not move.** The fix rewrote those markers
 *    `system` → `user`, which is a no-op on the Anthropic wire because the
 *    provider was already coercing them. Measured on a 3-attempt + context
 *    render of `ActorController` before and after: model-visible text
 *    byte-identical (4046 chars), the ordered per-content-block role sequence
 *    identical, and the single #122 cache breakpoint on the same block. Only
 *    the message ENVELOPE grouping changed — adjacent same-role content blocks
 *    now sit in one message (10 → 7) instead of three, which Anthropic reads
 *    identically and which leaves the cached prefix ending at the same byte.
 *    The assertions below are what a future edit has to keep true.
 *
 * On the OpenAI wire that same grouping concatenates the blocks into one string
 * with a space where the message boundary used to be (`---\nCONTEXT:` becomes
 * `--- CONTEXT:`). That is BAML's joiner, not this change: `LoopController`'s
 * two cached user tiers have always merged that way, on the route measured
 * 47/47 envelopes parsed.
 *
 * Rendered offline via `b.request.*` — no socket is opened, so this runs in CI
 * where the endpoint is unreachable. Live counterpart:
 * `scripts/smoke-verda.ts`.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import type {
  Attempt,
  DescribeTarget,
  LoopTurn,
  Message,
  PriorResult,
  ReferenceCandidate,
  RouteOption,
  ToolDescription,
} from '../../../../baml_client/types'

/** Fakes: rendering a request needs the options to resolve, not to connect. */
const ENV = {
  VERDA_INFERENCE_ENDPOINT: 'https://example.invalid/deployment/v1',
  VERDA_INFERENCE_API_KEY: 'offline-render-test',
  SMALL_LLM_BASE_URL: 'https://example.invalid/v1',
  SMALL_LLM_API_KEY: 'offline-render-test',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'offline-render-test',
}
/** An OpenAI-generic client: the wire format that enforces the ordering. */
const OPENAI = { client: 'VerdaQwen', env: ENV }
const ANTHROPIC = { client: 'AnthropicSonnet5', env: ENV }

let b: typeof import('../../../../baml_client').b

beforeAll(async () => {
  b = (await import('../../../../baml_client')).b
})

// ---------------------------------------------------------------------------
// Worst-case arguments: every optional populated and every history non-empty,
// because the defect was invisible on the empty ones. `verda-body-shape.test.ts`
// renders ActorController with `[]` attempts and passed throughout.
// ---------------------------------------------------------------------------
const TOOLS: ToolDescription[] = [
  { name: 'search', description: 'Search', args_schema: '{"query":"string"}' },
]
const HISTORY: Message[] = [
  { role: 'user', content: 'earlier question' },
  { role: 'assistant', content: 'earlier answer' },
]
const TURNS: LoopTurn[] = [
  {
    n: 0,
    reasoning: 'look it up',
    status: 'searching',
    tool_call: { tool: 'search', args: '{"query":"x"}' },
    tool_result: { tool: 'search', result: 'rows', success: true },
    expansions: [{ ref_id: 'r1', content: 'expanded' }],
  },
  {
    n: 1,
    reasoning: 'retry',
    status: 'retrying',
    tool_call: { tool: 'search', args: '{"query":"y"}' },
    tool_result: { tool: 'search', result: '', error: 'boom', success: false },
  },
]
const attempt = (n: number): Attempt => ({
  n,
  action: {
    reasoning: `reasoning ${n}`,
    tool_name: 'search',
    tool_args: `{"query":"q${n}"}`,
    additional_calls: [{ tool_name: 'search', tool_args: '{"query":"also"}' }],
    status: `status ${n}`,
    is_final: false,
  },
  result: `rows ${n}`,
  feedback: n === 1 ? 'not enough' : null,
})
const ATTEMPTS: Attempt[] = [attempt(1), attempt(2), attempt(3)]
const PRIOR: PriorResult[] = [{ ref_id: 'r0', tool: 'search', summary: 'earlier rows' }]
const FEW_SHOTS = [{ user: 'u', reasoning: 'r', tool: 'search', args: '{}' }]
const ROUTES: RouteOption[] = [{ name: 'graph', description: 'Graph questions' }]
const CANDIDATES: ReferenceCandidate[] = [
  { ref_id: 'r0', tool: 'search', summary: 's', tool_args: '{}', ts_offset_s: 12 },
]
const TARGETS: DescribeTarget[] = [
  { id: 'd0', tool: 'search', tool_args: '{}', reasoning: 'r', result: 'rows' },
]

type Render = () => Promise<{ body: { json(): unknown } }>
type Body = { messages?: { role: string; content: unknown }[]; system?: unknown }

/** Every BAML function, at its most conversational. */
const FUNCTIONS: [string, (opts: object) => Render][] = [
  [
    'ActorController',
    (o) => () =>
      b.request.ActorController(
        'q',
        'i',
        TOOLS,
        ATTEMPTS,
        'CONTEXT BLOCK',
        FEW_SHOTS,
        4,
        5,
        'parallel',
        o,
      ),
  ],
  [
    'LoopController',
    (o) => () =>
      b.request.LoopController(
        'q',
        'i',
        TOOLS,
        TURNS,
        'CONTEXT BLOCK',
        PRIOR,
        FEW_SHOTS,
        'parallel',
        'PLAN',
        'answer',
        o,
      ),
  ],
  ['Critic', (o) => () => b.request.Critic('i', ATTEMPTS, o)],
  ['Synthesize', (o) => () => b.request.Synthesize('q', 'i', TURNS, true, 'boom', o)],
  ['Planner', (o) => () => b.request.Planner('q', 'i', TOOLS, 'CONTEXT BLOCK', o)],
  ['Router', (o) => () => b.request.Router('q', ROUTES, HISTORY, o)],
  ['CompactIntent', (o) => () => b.request.CompactIntent(HISTORY, 'latest', o)],
  ['RetrieveQuery', (o) => () => b.request.RetrieveQuery(HISTORY, 'latest', o)],
  ['ReferenceSelector', (o) => () => b.request.ReferenceSelector('i', HISTORY, CANDIDATES, o)],
  ['ResultDescribe', (o) => () => b.request.ResultDescribe('search', '{}', 'r', 'rows', o)],
  ['ResultDescribeBatch', (o) => () => b.request.ResultDescribeBatch(TARGETS, o)],
  ['GenerateConversationTitle', (o) => () => b.request.GenerateConversationTitle('q', o)],
  [
    'ScreenUntrustedContent',
    (o) => () => b.request.ScreenUntrustedContent('web', 'fetched page text', o),
  ],
]

const roles = (body: Body) => (body.messages ?? []).map((m) => m.role)

describe('system-role placement on an OpenAI-compatible wire', () => {
  it.each(FUNCTIONS)('%s puts every system message at the beginning', async (_name, render) => {
    const seq = roles((await render(OPENAI)()).body.json() as Body)
    expect(seq.length).toBeGreaterThan(0)
    // The literal vLLM rule: no system message may follow a non-system one.
    // Asserted on the tail rather than on an index, so a failure prints the
    // offending sequence instead of two bare numbers.
    const firstNonSystem = seq.findIndex((r) => r !== 'system')
    expect(firstNonSystem === -1 ? [] : seq.slice(firstNonSystem)).not.toContain('system')
  })

  it('renders the actor’s conversation with the log intact, not flattened away', async () => {
    // Guards the assertion above from passing by rendering nothing: the actor
    // must still produce a real multi-turn conversation after the reorder.
    const seq = roles((await FUNCTIONS[0][1](OPENAI)()).body.json() as Body)
    expect(seq).toEqual([
      'system',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ])
  })
})

describe('the Anthropic path is unchanged by the reorder', () => {
  /** Flatten to (role, text) content blocks + the ordered cache breakpoints. */
  function chunks(body: Record<string, unknown>) {
    const text: [string, string][] = []
    const cache: [string, unknown][] = []
    /** Indices into `text` of the blocks carrying a breakpoint. */
    const markedAt: number[] = []
    const push = (role: string, blk: { text: string; cache_control?: unknown }) => {
      if (blk.cache_control) {
        cache.push([role, blk.cache_control])
        markedAt.push(text.length)
      }
      text.push([role, blk.text])
    }
    for (const blk of (body.system as { text: string; cache_control?: unknown }[]) ?? []) {
      push('system-field', blk)
    }
    for (const m of (body.messages as { role: string; content: unknown }[]) ?? []) {
      const content = (typeof m.content === 'string' ? [{ text: m.content }] : m.content) as {
        text: string
        cache_control?: unknown
      }[]
      for (const blk of content) push(m.role, blk)
    }
    return { text, cache, markedAt }
  }

  it('lifts only the leading system block and coerces the rest — the reason the fix is free', async () => {
    const body = (await FUNCTIONS[0][1](ANTHROPIC)()).body.json() as Record<string, unknown>
    // No message carries role 'system': that coercion is the mechanism that hid
    // the defect, and it is what makes `system` → `user` a no-op here.
    expect(roles(body as Body)).not.toContain('system')
    expect(JSON.stringify(body.system)).toContain('You are an AI agent')
  })

  it('keeps the content blocks the pre-fix render produced, in the same roles', async () => {
    const { text } = chunks(
      (await FUNCTIONS[0][1](ANTHROPIC)()).body.json() as Record<string, unknown>,
    )
    // Measured identical before and after the reorder. The CONTEXT block and
    // each attempt result are attributed to `user` in BOTH — before, because
    // Anthropic rewrote them; now, because the template says so.
    expect(text.map(([role]) => role)).toEqual([
      'system-field',
      'user', // USER INTENT
      'user', // CONTEXT
      'user', // USER REQUEST
      'assistant', // attempt 1 action
      'user', // attempt 1 result
      'assistant',
      'user',
      'assistant',
      'user', // attempt 3 result (rolling cache marker)
      'user', // closing: feedback nudge · budget · counter
    ])
    const joined = text.map(([, t]) => t).join('')
    expect(joined).toContain('CONTEXT:\nCONTEXT BLOCK')
    expect(joined).toContain('Attempt 1 result:')
    expect(joined).toContain('CRITIC FEEDBACK: not enough')
  })

  it('keeps the single #122 cache breakpoint on the same block', async () => {
    const { text, cache } = chunks(
      (await FUNCTIONS[0][1](ANTHROPIC)()).body.json() as Record<string, unknown>,
    )
    // attempt_n = 4 > 1, so ActorTaskFrame's first-call marker does not fire;
    // ActorAttemptLog's rolling marker lands on the NEWEST result only.
    expect(cache).toEqual([['user', { type: 'ephemeral' }]])
    const marked = text.findIndex(([, t]) => t?.includes('Attempt 3 result:'))
    expect(marked).toBe(text.length - 2)
  })

  it('keeps ActorTaskFrame’s call-1 breakpoint ending at USER REQUEST', async () => {
    // The other half of #122, and the half the reorder could plausibly have
    // broken: CONTEXT is now the same role as the blocks either side of it, so
    // if BAML had merged the three into one content block the cached prefix
    // would have swallowed USER REQUEST's neighbours. It does not — Anthropic
    // keeps them as separate blocks within one message, and the marker still
    // lands on the block that ENDS the run-static prefix.
    const render = () =>
      b.request.ActorController('QQ', 'i', TOOLS, [], 'CONTEXT BLOCK', FEW_SHOTS, 1, 5, null, {
        ...ANTHROPIC,
      })
    const { text, cache, markedAt } = chunks(
      (await render()).body.json() as Record<string, unknown>,
    )
    expect(cache).toEqual([['user', { type: 'ephemeral' }]])
    // Bind the breakpoint to the block, not merely to its existence: the block
    // it sits on must be the one that ENDS on USER REQUEST, and it must not
    // have absorbed USER INTENT or the volatile tail.
    const marked = text[markedAt[0]][1]
    expect(marked).toContain('USER REQUEST: QQ')
    expect(marked).not.toContain('USER INTENT')
    expect(marked).not.toContain('Respond with the next action')
    expect(markedAt[0]).toBeLessThan(text.length - 1)
  })
})
