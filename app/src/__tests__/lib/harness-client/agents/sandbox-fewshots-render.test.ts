/** Owner directive 2026-10-25 (#606 gate, runs 3-4): the sandbox agent's
 * SANDBOX_FEW_SHOTS gained an expressive multi-step example (explore → inspect
 * → transform-and-deliver per WORKSPACE_NOTE) and a contrastive envelope
 * negative (native tool-call syntax labeled WRONG, corrected JSON beside it).
 * This file renders the REAL ActorController prompt offline (`b.request`, no
 * socket, no DB) through the real adapter seam and pins both shots' presence,
 * shape, determinism and the overfitting guard. Pattern:
 * general-next-actor-prompt.test.ts. */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mcpNamespace } from '@hames-ai/connectors/mcp-catalog'
import { b } from '@hames-ai/harness-baml/baml_client'
import { harness, withRunFrame, type ConfiguredPattern } from '@hames-ai/harness-patterns'
import type { AgentData, AgentDeps } from '@hames-ai/agents'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

const deps: AgentDeps = {
  toolNamespaces: mcpNamespace,
  withSandbox: () => (pattern) => pattern,
}
const walk = (ps: ConfiguredPattern<AgentData>[]): ConfiguredPattern<AgentData>[] =>
  ps.flatMap((p) => [p, ...walk(p.children ?? [])])

const ENV = {
  ANTHROPIC_API_KEY: 'offline-render-test',
  LARGE_LLM_BASE_URL: 'https://example.invalid/v1',
  LARGE_LLM_API_KEY: 'offline-render-test',
}

const rendered: string[] = []
let renderArgs: unknown[] = []
const actions = (prompt: string) =>
  prompt
    .split('\n')
    .filter((line) => line.trim().startsWith('{"reasoning":'))
    .map((line) => JSON.parse(line))
const blocks = (prompt: string) => prompt.split('\n- User: ')

beforeAll(async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'offline-render-test')
  vi.stubEnv('USE_SELF_DEPLOYED_INFERENCE', '0')
  // Render what the adapter would send (its first nine arguments; the tenth is
  // the options bag), on both wire formats, then end the loop.
  vi.spyOn(b, 'ActorController').mockImplementation((async (...args: unknown[]) => {
    renderArgs = args.slice(0, 9)
    for (const client of ['AnthropicSonnet5', 'LargeQwen']) {
      const request = await b.request.ActorController(
        ...([...renderArgs, { client, env: ENV }] as unknown as Parameters<
          typeof b.request.ActorController
        >),
      )
      const body = request.body.json() as {
        system?: { text: string }[]
        messages: { content: string | { text: string }[] }[]
      }
      const head = body.system ?? body.messages[0].content
      rendered.push(typeof head === 'string' ? head : head.map((p) => p.text).join('\n'))
    }
    return {
      reasoning: 'r',
      tool_name: 'sandbox_bash',
      tool_args: '{}',
      status: 'success',
      is_final: true,
    }
  }) as never)
  vi.spyOn(b, 'Critic').mockImplementation((async () => ({
    is_sufficient: true,
    explanation: 'ok',
  })) as never)
  const { sandboxAgent } = await import('@hames-ai/agents/agents/sandbox.server')
  const patterns = await sandboxAgent.createPatterns('render-session', deps)
  const actor = walk(patterns).find((p) => p.name === 'actorCritic')!
  await withRunFrame({ inference: { tier: 'anthropic' } }, () => harness(actor)('synthetic task'))
})

describe.each([0, 1])('sandbox few-shots in the rendered actor prompt (wire %i)', (wire) => {
  it('carries the expressive multi-step example (explore, inspect, deliver, report path)', () => {
    const prompt = rendered[wire]
    expect(prompt).toContain('EXAMPLES (illustrative')
    const expressive = blocks(prompt).find((block) => block.includes('server.log'))!
    expect(expressive).toContain('Multi-step session')
    expect(expressive).toContain('first list /work/in to see what arrived')
    // tojson escapes < > ' inside tool_args on the wire, so the heredoc itself
    // is asserted through the parsed envelope, like the office test does.
    const action = actions(prompt).find((a) => a.tool_args.includes('server.log'))!
    expect(action.tool_name).toBe('sandbox_bash')
    const { command } = JSON.parse(action.tool_args)
    expect(command).toContain("python3 - <<'PY'\n")
    expect(command).toContain("Path('/work/in/server.log').read_text().splitlines()")
    expect(command).toContain("Path('/work/out/timeouts.txt').write_text(")
    expect(command).toContain("print('/work/out/timeouts.txt')")
    // Envelope discipline: tool_args a STRING whose content is a JSON object.
    expect(typeof action.tool_args).toBe('string')
    expect(JSON.parse(action.tool_args)).toBeTypeOf('object')
    expect(action.is_final).toBe(false)
  })

  // MUTATION: delete ENVELOPE_NEGATIVE_SHOT from SANDBOX_FEW_SHOTS → red on
  // both wires; restore → green.
  it('carries the contrastive envelope negative beside its corrected call', () => {
    const prompt = rendered[wire]
    const wrong = blocks(prompt).find((block) => block.includes('WRONG FORMAT'))!
    // Run 4's captured native syntax, verbatim and labeled.
    expect(wrong).toContain(
      '<function=sandbox_bash><parameter=command>ls /work/in</parameter></function>',
    )
    expect(wrong).toContain('the harness parses the JSON envelope only')
    expect(wrong).toContain('native tool-call syntax is never valid here')
    // The same call, immediately corrected in the record's own envelope.
    const action = actions(prompt).find((a) =>
      a.reasoning.includes('only form the harness parses'),
    )!
    expect(JSON.parse(action.tool_args)).toEqual({ command: 'ls /work/in' })
    expect(b.parse.ActorController(JSON.stringify(action))).toMatchObject(action)
  })

  // Overfitting guard (owner rule): the expressive example must not mirror the
  // eval scenarios' fixtures — a different domain entirely, no scenario
  // wording. MUTATION: rename the shot's domain onto a fixture name → red.
  it('keeps the expressive example clear of the eval fixtures (overfitting guard)', () => {
    const expressive = blocks(rendered[wire]).find((block) => block.includes('server.log'))!
    for (const banned of ['lantern', 'sales', 'total', 'upload', 'summary']) {
      expect(expressive.toLowerCase()).not.toContain(banned)
    }
  })

  it('every demonstrated envelope still parses as the actor output format', () => {
    for (const action of actions(rendered[wire])) {
      expect(typeof action.tool_args).toBe('string')
      expect(JSON.parse(action.tool_args)).toBeTypeOf('object')
      expect(b.parse.ActorController(JSON.stringify(action))).toMatchObject(action)
    }
  })
})

// MUTATION: make rendering nondeterministic → red. The mutation must reach
// the per-call render (e.g. append a fresh counter or Date.now() to the
// rendered prompt on each request) — a Date.now IN a shot cannot: the shot
// strings are fixed at module import, so every render sees the same value.
it('renders the same prompt bytes twice (determinism pin)', async () => {
  for (const client of ['AnthropicSonnet5', 'LargeQwen']) {
    const callArgs = [...renderArgs, { client, env: ENV }] as unknown as Parameters<
      typeof b.request.ActorController
    >
    const first = await b.request.ActorController(...callArgs)
    const second = await b.request.ActorController(...callArgs)
    expect(second.body.text()).toBe(first.body.text())
    expect(first.body.text().length).toBeGreaterThan(0)
  }
})
