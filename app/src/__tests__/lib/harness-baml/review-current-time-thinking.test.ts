// @vitest-environment node
/** Independent #1030 evidence: real thinking adapters must send the same clock,
 * including the private wire's thinking setting and absent cache metadata. */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, vi } from 'vitest'
import {
  createCriticAdapter,
  createLoopControllerAdapter,
  createPlannerAdapter,
} from '@hames-ai/harness-baml/baml-adapters.server'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import { formatTimeBlock } from '@hames-ai/harness-patterns/clock'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

it('thinking adapters send the fixed turn clock after wall time advances', async () => {
  const clock = { instant: Date.parse('2026-11-04T23:30:12Z'), timeZone: 'Europe/Brussels' }
  const bodies: Array<{ messages: unknown[]; chat_template_kwargs: unknown }> = []
  const answers = [
    { tool_name: 'Return', tool_args: 'done', is_final: true },
    { plan: 'Read the records', n_steps: 1 },
    { is_sufficient: true, explanation: 'The requested records are present.' },
  ]
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    bodies.push(JSON.parse(raw))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'clock-test',
        object: 'chat.completion',
        created: 0,
        model: 'synthetic',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify(answers.shift()),
              reasoning_content: 'Synthetic reasoning trace.',
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  const wall = vi.spyOn(Date, 'now').mockReturnValue(clock.instant)
  try {
    vi.stubEnv('PRIVATE_REASONING_ROLES', 'controller,planner,critic')
    vi.stubEnv('LARGE_LLM_BASE_URL', endpoint)
    vi.stubEnv('LARGE_LLM_API_KEY', 'synthetic')
    vi.stubEnv('SMALL_LLM_BASE_URL', endpoint)
    vi.stubEnv('SMALL_LLM_API_KEY', 'synthetic')
    vi.stubEnv('SMALL_LLM_DECISIONS_URL', `${endpoint}/systemone`)
    await withRunFrame(
      {
        clock,
        inference: {
          tier: 'self_deployed',
          clientOverride: () => ({ client: 'LargeQwenThink' }),
        },
      },
      async () => {
        await createLoopControllerAdapter()({
          userMessage: 'Find records from yesterday',
          intent: 'Find records from yesterday',
          tools: [],
          turns: [],
          turn: 0,
        })
        wall.mockReturnValue(clock.instant + 86_400_000)
        await createPlannerAdapter([])('Find records', 'Find records from yesterday')
        await createCriticAdapter()('Find records from yesterday', [])
      },
    )
    expect(bodies).toHaveLength(3)
    for (const body of bodies) {
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: true })
      expect(JSON.stringify(body)).not.toContain('cache_control')
      const messages = JSON.stringify(body.messages)
      expect(messages).toContain(formatTimeBlock(clock).split('\n')[1])
      expect(messages.match(/CURRENT TIME \(/g)).toHaveLength(1)
    }
  } finally {
    wall.mockRestore()
    vi.unstubAllEnvs()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    )
  }
})
