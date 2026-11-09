/** rv-1033 review evidence (proposed test edit for #1032): the Synthesize trace
 * rule must render only beside a decisionLoop route trace. A thread-mode turn
 * whose tool result is an ordinary object with a `route` key (any tool's JSON)
 * is not a trace, so its prompt must stay byte-identical. Red at e4e17bfc:
 * the template tests `'{"route":' in result`, a substring, not "opens with". */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { b } from '@hames-ai/harness-baml/baml_client'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

const ENV = {
  ANTHROPIC_API_KEY: 'offline-render-test',
  LARGE_LLM_BASE_URL: 'https://example.invalid/v1',
  LARGE_LLM_API_KEY: 'offline-render-test',
}

beforeEach(() => {
  vi.stubEnv('USE_SELF_DEPLOYED_INFERENCE', '')
  vi.stubEnv('INFERENCE_TIERS', '')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const render = (result: unknown) =>
  b.request.Synthesize(
    'q',
    'q',
    [{ n: 0, tool_result: { tool: 't', result: JSON.stringify(result), success: true } }],
    false,
    null,
    null,
    null,
    null,
    null,
    { client: 'LargeQwen', env: ENV },
  )

describe('Synthesize: a tool result with a `route` key is not a route trace', () => {
  it('renders no trace rule for a transit-style object or a nested one', async () => {
    for (const result of [
      { route: 'A12', departs: '09:10' },
      { items: [{ route: 'north', stops: 4 }] },
    ]) {
      const text = (await render(result)).body.text()
      expect(text, JSON.stringify(result)).not.toContain('could not do its lookup')
    }
  })
})
