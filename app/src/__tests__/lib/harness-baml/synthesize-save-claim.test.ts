/** tn35 (live, 2026-11-04): with memory off, a route wrote a note file and the reply
 * told the user "Ik heb je voorkeur opgeslagen" — a save claim the results carried and
 * the FIDELITY rules allowed. Synthesize runs BEFORE the store step (`settleMemory`), so
 * whether anything is kept is never known when it writes: the rule is "do not claim it
 * either way" (review of #989: a "for the rest of this conversation" clause understated a
 * preference the store keeps unasked), scoped to the tool results, and it must not limit
 * answering from a recalled memory (05 turn 2: "which release tag do you have noted").
 * Offline wire renders, no model call.
 *
 * MUTATIONS (red): delete the "Whether anything is kept…" bullet from `Synthesize` in
 * `packages/harness-baml/baml_src/compact-execution.baml` and regenerate — every client
 * goes red; drop its last sentence (the WHAT YOU REMEMBER carve-out) — the memory-on
 * case goes red; render it unconditionally — the memory-off case goes red; put back "for the rest of this conversation and say so" — red. */
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
        expect(text).toContain(
          'Whether anything is kept for later conversations is decided outside',
        )
        expect(text).toContain('so do not claim it either way')
        expect(text).toContain('Nothing in the\\n  TOOL EXECUTION results is a memory of the user')
        expect(text).toContain('a file saved to this\\n  conversation')
        // The carve-out: a stored memory the block shows may be reported as noted. It
        // renders only beside a memory block, so a memory-less prompt names no block.
        if (memory)
          expect(text).toContain(
            'This does not limit answering from the\\n  WHAT YOU REMEMBER block above.',
          )
        else expect(text).not.toContain('WHAT YOU REMEMBER')
        // Never understate retention the store step may still perform.
        expect(text).not.toContain('for the rest of this conversation')
        if (memory) expect(text).toContain(memory)
      }
    },
  )
})
