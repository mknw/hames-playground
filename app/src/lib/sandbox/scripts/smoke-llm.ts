/**
 * Real-LLM smoke test for `withSandbox(actorCritic(...))`.
 *
 * Same chain as `smoke-scripted.ts`, but the actor + critic are the real
 * BAML adapters (`createActorControllerAdapter` / `createCriticAdapter`)
 * driven by Anthropic (the default chain — see CLAUDE.md → "Client routing").
 * The actor's decisions are not fixed: it sees the `sandbox_*` tool surface
 * in its prompt (prepended by the adapter from the active ALS scope) and
 * picks how to satisfy the user's task.
 *
 * Prerequisites:
 *   - Docker engine running (colima on macOS).
 *   - `kg-sandbox:base` image built:
 *       cd rootfs && docker build -t kg-sandbox:base .
 *   - BAML client generated:
 *       pnpm baml-generate
 *   - `ANTHROPIC_API_KEY` in env — the only provider key the app needs
 *     (`ActorAnthropic` / `CriticAnthropic` &c.).
 *
 * Run from `app/`:
 *   pnpm dlx tsx src/lib/sandbox/scripts/smoke-llm.ts
 *
 * Cost: a handful of Sonnet calls (actor + critic per turn). Should be a
 * few cents at most. Look for the word count (9) in the final result; the
 * exact path the agent takes is its own choice.
 */

import { withSandbox } from '../with-sandbox.server'
import { actorCritic } from '../../harness-patterns/patterns/actorCritic.server'
import {
  createActorControllerAdapter,
  createCriticAdapter,
} from '../../harness-patterns/baml-adapters.server'
import { createScope } from '../../harness-patterns/context.server'
import { createEventView } from '../../harness-patterns/patterns'
import { printEventSummary, checkRootfsImage } from './_shared'

const SENTENCE = 'the quick brown fox jumps over the lazy dog'

function preflight(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set.\n' +
        'Export it before running:\n' +
        '  export ANTHROPIC_API_KEY=sk-ant-...',
    )
  }
}

async function main(): Promise<void> {
  console.log('🚀 Real-LLM sandbox smoke — Anthropic actor/critic')
  console.log(`   sentence: "${SENTENCE}"`)
  console.log(`   expected word count: ${SENTENCE.split(/\s+/).length}`)

  preflight()
  await checkRootfsImage()

  // Empty tool lists — the sandbox's tools are surfaced to the actor's
  // prompt via the ALS scope from inside `withSandbox`. No gateway tools
  // needed for this task.
  const actor = createActorControllerAdapter([])
  const critic = createCriticAdapter()

  const pattern = withSandbox({ rootfs: 'base' })(
    actorCritic(actor, critic, [], {
      availableTools: [],
      maxRetries: 5,
      patternId: 'smoke-llm',
      trackHistory: true,
    }),
  )

  const userMsg =
    `Count the number of words in this sentence: "${SENTENCE}". ` +
    'Use the sandbox tools (Python via sandbox_bash, files under /work) ' +
    'to compute the answer. Return just the integer count.'

  const scope = createScope('smoke-llm', { intent: 'count the words' })
  const view = createEventView({
    sessionId: 'smoke-llm',
    createdAt: Date.now(),
    events: [
      {
        type: 'user_message' as const,
        ts: Date.now(),
        patternId: 'harness',
        data: { content: userMsg },
      },
    ],
    status: 'running' as const,
    data: {},
    input: userMsg,
  })

  console.log('\n⏳ booting sandbox + running pattern (this calls Anthropic)...')
  const t0 = Date.now()
  const out = await pattern.fn(scope, view)
  const elapsedMs = Date.now() - t0

  printEventSummary(out)
  const final = (out.data as { result?: unknown }).result
  console.log(`📦 final result: ${JSON.stringify(final)}`)
  console.log(`⏱  elapsed: ${elapsedMs}ms`)
}

main().catch((err) => {
  console.error('\n❌ smoke failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
