/** S3's opt-in local spike. Start an owned llama-server with Makefile's
 * llm-small flags on 18095 first, and kill that PID afterwards. Run from app/:
 * pnpm dlx tsx scripts/spike-score-noul.ts
 * No env file is loaded; every inference call goes to the loopback 4B.
 */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import type { Collector } from '@boundaryml/baml'

process.env.USE_VERDA_INFERENCE = '0'
process.env.SMALL_LLM_BASE_URL = 'http://127.0.0.1:18095/v1'
process.env.SMALL_LLM_API_KEY = 'local'
process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/v1'
process.env.VERDA_INFERENCE_API_KEY = 'unused'

async function main() {
  await import('../src/lib/inference/config.server')
  const { b } = await import('@hames-ai/harness-baml/baml_client')
  const { createDecideAdapter, topLogprobsOf } =
    await import('@hames-ai/harness-baml/baml-adapters.server')
  const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
  const { defineScore, defineNoul, sumLabelMass, scoreScoreDecision, scoreNoulDecision } =
    await import('@hames-ai/harness-patterns/patterns/typedDecision.server')
  const { configureDecisionCalibration } = await import('@hames-ai/harness-baml/clients.server')
  configureDecisionCalibration({})

  let recorded: { request: Record<string, unknown>; response: unknown } | undefined
  const original = b.Decide.bind(b)
  b.Decide = async (...args) => {
    const result = await original(...args)
    const collector = args[3]?.collector as Collector
    const calls = collector.last?.calls ?? []
    const call = calls.find((c) => c.selected) ?? calls[calls.length - 1]
    assert(call?.httpRequest && call.httpResponse)
    recorded = {
      request: call.httpRequest.body.json() as Record<string, unknown>,
      response: call.httpResponse.body.json(),
    }
    assert.equal(recorded.request.max_tokens, 2)
    assert.equal(recorded.request.logprobs, true)
    assert.equal(recorded.request.top_logprobs, 20)
    return result
  }
  const score = defineScore({
    key: 'spike.score',
    question: 'How urgent is the requested reply?',
    levels: [
      { id: 'none', description: 'No reply is requested.' },
      { id: 'later', description: 'A reply next month is fine.' },
      { id: 'week', description: 'A reply next week is fine.' },
      { id: 'today', description: 'A reply is needed today, but work can continue.' },
      { id: 'now', description: 'Work is blocked until an immediate reply arrives.' },
    ],
  })
  const noul = defineNoul({
    key: 'spike.noul',
    question: 'The message asks to speak to a person.',
    criteria: { true: 'They ask to speak to a human.', false: 'They do not ask for a human.' },
  })
  const decide = createDecideAdapter()
  try {
    await withRunFrame({ inference: { tier: 'verda' } }, async () => {
      for (const spec of [score, noul]) {
        const state =
          spec.type === 'score'
            ? 'I cannot continue my work until you reply. Please reply immediately.'
            : 'Please let me speak to a human.'
        // Repeat the identical prompt at max_tokens 2 (T3's crash backstop).
        for (let repeat = 0; repeat < 2; repeat++) {
          const result = await decide<string>({ spec, state })
          assert.equal(result.llmCall?.clientName, 'LocalQwenSmallDecide')
          assert.equal(result.calibrated, false)
          assert(recorded)
          const letters = spec.type === 'score' ? ['A', 'B', 'C', 'D', 'E'] : ['A', 'B']
          const top = topLogprobsOf(recorded.response)
          assert(top)
          const read = sumLabelMass(top, letters)
          const parsed =
            spec.type === 'score'
              ? scoreScoreDecision({ spec, state, result, policy: { fallback: 'none' } }).decision
              : scoreNoulDecision({
                  spec,
                  state,
                  result: {
                    ...result,
                    probs: { true: result.probs.true, false: result.probs.false },
                  },
                  policy: { fallback: false },
                }).decision
          assert.equal(parsed.abstained, false)
          console.log(
            JSON.stringify({
              type: spec.type,
              repeat,
              letters: read.mass,
              coverage: read.coverage,
              parsed,
            }),
          )
          if (repeat === 0) {
            writeFileSync(
              `src/__tests__/fixtures/decide/llamacpp-${spec.type}.json`,
              JSON.stringify(
                {
                  server:
                    'Real local llama-server; Qwen3.5-4B-Instruct-Q8_0.gguf; Makefile llm-small flags, port 18095; S3 spike',
                  ...recorded,
                },
                null,
                2,
              ) + '\n',
            )
          }
        }
      }
    })
  } finally {
    b.Decide = original
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
