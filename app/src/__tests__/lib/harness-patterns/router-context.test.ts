/**
 * Router — cross-turn intent (#53)
 *
 * The router's `intent` is the ONLY thing a dispatched pattern learns about the
 * conversation: `routes()` hands the child scope `data.intent`, and the BAML
 * controllers take it as their `intent` argument. So a bare back-reference
 * ("try again", "the second one") arriving as the intent leaves the downstream
 * agent blind — the failure in #53.
 *
 * The fix itself lives in the prompt (`baml_src/router.baml` INTENT FORMULATION
 * + the `RoutingResult.intent` description in `baml_src/types.baml`), so this
 * file pins the two things a prompt cannot pin for itself:
 *
 *   1. The MULTI-TURN PLUMBING the rule depends on — the prior turns actually
 *      reach `b.Router` as `history`, split off from the current message.
 *      Every pre-existing router test uses a single-turn fixture, which is
 *      exactly why the bug survived (#53 "Why it slipped through").
 *   2. That whatever intent comes back is forwarded verbatim all the way into
 *      the dispatched pattern's scope.
 *
 * Plus prompt-content guards that the rules stay on the committed templates
 * (a prompt-fidelity guard). Live multi-turn behaviour of
 * the model is checked by `router-intent-eval.test.ts` under `RUN_EVALS=1`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

// Mock server-only imports
vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const mockRouteMessageOp = vi.fn()
vi.mock('../../../lib/harness-patterns/routing.server', () => ({
  routeMessageOp: (...args: unknown[]) => mockRouteMessageOp(...args),
}))

/** The #53 repro: a web search that failed, then a bare "try again". */
const TRY_AGAIN_TURNS = [
  { type: 'user_message', content: 'search the web for Solid resources' },
  { type: 'assistant_message', content: 'Rate limited — no results.' },
  { type: 'user_message', content: 'try again' },
] as const

const SYNTHESIZED = 'search the web for SolidJS resources (retry of the previous turn)'

async function runRouterOver(turns: ReadonlyArray<{ type: string; content: string }>) {
  const { router } = await import('../../../lib/harness-patterns/patterns/router.server')
  const { createContext } = await import('../../../lib/harness-patterns/context.server')
  const { createEventView } =
    await import('../../../lib/harness-patterns/patterns/event-view.server')

  // createContext() seeds the opening user_message itself, so the first turn
  // is its input and the rest are appended — same shape as a real session.
  const [first, ...rest] = turns
  const ctx = createContext<{ route?: string; intent?: string }>(first.content)
  const t0 = ctx.events[0].ts
  rest.forEach((t, i) => {
    ctx.events.push({
      type: t.type as 'user_message' | 'assistant_message',
      ts: t0 + 1 + i,
      patternId: 'harness',
      data: { content: t.content },
    } as never)
  })

  const pattern = router({ web_search: 'Web lookups', neo4j: 'Database queries' })
  const scope = await pattern.fn(
    { id: 'router', data: ctx.data, events: [], startTime: Date.now() },
    createEventView(ctx),
  )
  // routeMessageOp(message, history, routes, collector)
  const [message, history] = mockRouteMessageOp.mock.calls[0] as [
    string,
    Array<{ role: string; content: string }>,
  ]
  return { scope, message, history }
}

describe('router — cross-turn intent (#53)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRouteMessageOp.mockResolvedValue({
      intent: SYNTHESIZED,
      tool_call_needed: true,
      tool_name: 'web_search',
      response_text: 'Looking into that...',
    })
  })

  it('sends the prior turns to the router as history, current message apart', async () => {
    const { message, history } = await runRouterOver(TRY_AGAIN_TURNS)

    expect(message).toBe('try again')
    expect(history).toEqual([
      { role: 'user', content: 'search the web for Solid resources' },
      { role: 'assistant', content: 'Rate limited — no results.' },
    ])
    // The bare follow-up is the message, never duplicated into history —
    // otherwise the model cannot tell what it is being asked to expand.
    expect(history.map((h) => h.content)).not.toContain('try again')
  })

  it('passes the whole window when the follow-up is several turns deep', async () => {
    const { message, history } = await runRouterOver([
      { type: 'user_message', content: 'find papers on graph embeddings' },
      { type: 'assistant_message', content: 'Here are three: A, B, C.' },
      { type: 'user_message', content: 'summarise the second one' },
    ])

    expect(message).toBe('summarise the second one')
    expect(history).toHaveLength(2)
    // The referent of "the second one" is only recoverable from history.
    expect(history[1].content).toContain('A, B, C')
  })

  it('forwards the synthesized intent into scope.data.intent', async () => {
    const { scope } = await runRouterOver(TRY_AGAIN_TURNS)

    expect(scope.data.intent).toBe(SYNTHESIZED)
    expect(scope.data.intent).not.toBe('try again')
  })

  it('hands the synthesized intent to the dispatched pattern, not the bare phrase', async () => {
    const { routes } = await import('../../../lib/harness-patterns/patterns/router.server')
    const { createContext } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } =
      await import('../../../lib/harness-patterns/patterns/event-view.server')

    const { scope } = await runRouterOver(TRY_AGAIN_TURNS)

    // What the child pattern sees is what the BAML controller gets as `intent`.
    let seenByChild: string | undefined
    const child = {
      name: 'web-loop',
      fn: vi.fn(async (s: { data: { intent?: string } }) => {
        seenByChild = s.data.intent
        return s
      }),
      config: { patternId: 'web_search' },
    }

    const ctx = createContext('test')
    await routes({ web_search: child } as never).fn(
      { id: 'routes', data: scope.data as never, events: [], startTime: Date.now() },
      createEventView(ctx),
    )

    expect(child.fn).toHaveBeenCalled()
    expect(seenByChild).toBe(SYNTHESIZED)
  })

  it('records the synthesized intent on the conversational route too', async () => {
    mockRouteMessageOp.mockResolvedValue({
      intent: 'thank the assistant for the SolidJS search results',
      tool_call_needed: false,
      tool_name: null,
      response_text: 'You are welcome!',
    })

    const { scope } = await runRouterOver([
      { type: 'user_message', content: 'search the web for Solid resources' },
      { type: 'assistant_message', content: 'Found 3 links.' },
      { type: 'user_message', content: 'thanks!' },
    ])

    expect(scope.data.route).toBe('user')
    expect(scope.data.intent).toContain('SolidJS')
  })
})

// ---------------------------------------------------------------------------
// Prompt-content guards. process.cwd() is the `app/` dir; baml_src is resolved
// from both sides so the check survives a repo-root layout change.
// ---------------------------------------------------------------------------

function readBamlSrc(file: string): string {
  const candidates = [
    path.resolve(process.cwd(), '..', 'baml_src', file),
    path.resolve(process.cwd(), 'baml_src', file),
  ]
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error(`baml_src/${file} not found (cwd=${process.cwd()})`)
  return readFileSync(found, 'utf8')
}

describe('router — BAML prompt guardrails (#53)', () => {
  it('Router carries the INTENT FORMULATION rules', () => {
    const src = readBamlSrc('router.baml')
    expect(src).toContain('INTENT FORMULATION')
    expect(src).toContain('self-contained')
    // The back-reference cases the bug is about.
    expect(src).toMatch(/try again/i)
    expect(src).toMatch(/the second one/i)
    // The hard prohibition, without which the model defaults to echoing.
    expect(src).toMatch(/NEVER set intent to a bare back-reference/i)
    // Expansion must not turn into answering the question.
    expect(src).toMatch(/do not answer it|widen the scope/i)
  })

  it('Router still receives the conversation history the rules refer to', () => {
    const src = readBamlSrc('router.baml')
    expect(src).toContain('CONVERSATION HISTORY')
    expect(src).toContain('{% for m in history %}')
  })

  it('RoutingResult.intent describes the self-contained contract', () => {
    const src = readBamlSrc('types.baml')
    const field = src.split('\n').find((l) => l.trim().startsWith('intent string'))
    expect(field).toBeDefined()
    expect(field).toMatch(/self-contained/i)
  })
})
