/** tn35 (live, 2026-11-04): with memory off, a route wrote a note file and the reply
 * told the user "Ik heb je voorkeur opgeslagen" — a save claim the results carried and
 * the FIDELITY rules allowed, because nothing told the synthesizer that a file in this
 * conversation is not something remembered later. Offline wire renders, no model call.
 *
 * MUTATION (red): delete the "Nothing you write here saves anything…" bullet from
 * `Synthesize` in `packages/harness-baml/baml_src/compact-execution.baml` and
 * regenerate — every client below goes red. */
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
})
afterEach(() => vi.unstubAllEnvs())

describe('Synthesize never claims a save for later conversations', () => {
  it.each(['AnthropicSonnet5', 'AnthropicHaiku45', 'LargeQwen'])(
    '%s carries the rule on the wire, with or without a memory block',
    async (client) => {
      for (const memory of [null, '- [preference] The user likes short answers.']) {
        const request = await b.request.Synthesize(
          'Remember that I prefer answers in Dutch from now on.',
          'Remember a language preference',
          [
            {
              n: 0,
              tool_result: {
                tool: 'sandbox_write',
                result: 'Wrote /work/out/preference-dutch.md',
                success: true,
              },
            },
          ],
          false,
          null,
          memory,
          null,
          { client, env: ENV },
        )
        const text = JSON.stringify(request.body.json())
        expect(text).toContain('Nothing you write here saves anything for a later conversation')
        expect(text).toContain('a file saved to\\n  this conversation')
        expect(text).toContain('you have saved, stored, noted or will remember something')
        expect(text).toContain('beyond this conversation')
      }
    },
  )
})
