/** Fresh host process for N8's durable resume proof. Invoked by scenario 20. */
import { describe, expect, it } from 'vitest'
import { bootApp, eventsOfType } from '../lib/app'
import { BATCH_AGENT, registerBatchAgent } from '../lib/egress-batch-agent'
import { SEND_OUTCOME_UNKNOWN } from '@hames-ai/harness-patterns/mcp-client.server'

describe.runIf(!!process.env.E2E_N8_CHILD_SESSION)('fresh host process resumes an N8 batch', () => {
  it('uses the committed claim or result without opening its transport', async () => {
    const sent: Record<string, unknown>[] = []
    const app = await bootApp()
    await registerBatchAgent({
      id: 'fresh-process-synthetic-outside',
      ownsTool: (name) => name === 'synthetic_search',
      callTool: async (_name, args) => {
        sent.push(args)
        return { success: true, data: { hits: ['unexpected child send'] } }
      },
      listTools: async () => [
        {
          name: 'synthetic_search',
          description: 'Search a synthetic outside service',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    })
    const sessionId = process.env.E2E_N8_CHILD_SESSION!
    const expected = process.env.E2E_N8_CHILD_EXPECTED
    expect(expected === 'started' || expected === 'finished').toBe(true)
    const before = await app.readRow(sessionId)
    expect(before?.agentId).toBe(BATCH_AGENT)
    expect(before?.status).toBe('paused')
    const resumed = await app.runTurnOverSse({ sessionId, mode: 'resume' })
    expect(resumed.status).toBe(200)
    expect(sent).toEqual([])
    const after = await app.readRow(sessionId)
    const results = eventsOfType(after!.serializedContext, 'tool_result')
    if (expected === 'started') {
      expect(
        results.some((data) => (data as { error?: string }).error === SEND_OUTCOME_UNKNOWN),
      ).toBe(true)
    } else {
      expect(JSON.stringify(results)).toContain('durable-result-from-A')
      expect(JSON.stringify(results)).not.toContain('unexpected child send')
    }
  })
})
