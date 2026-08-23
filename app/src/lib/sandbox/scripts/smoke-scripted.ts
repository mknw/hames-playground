/**
 * LLM-free smoke test for `withSandbox(actorCritic(...))`.
 *
 * Drives a real `DockerBackend` booting a real `kg-sandbox:base` container,
 * but hand-scripts the actor + critic instead of calling BAML. Proves the
 * wrapper, ALS scope, `callTool` dispatch, and DockerBackend lifecycle work
 * end-to-end against a live container, with zero LLM cost or API key.
 *
 * Runs **twice** with a shared pool + scheduler to demonstrate the warm-pool
 * pay-off: invocation 1 boots a container; invocation 2 hits the pool and
 * reuses the same backend slot. Asserts `bootCount === 1` after both runs.
 *
 * Prerequisites:
 *   - Docker engine running (colima on macOS).
 *   - `kg-sandbox:base` image built:
 *       cd rootfs && docker build -t kg-sandbox:base .
 *     (Inside the nix shell, the flake's shellHook bridges
 *     ~/.docker/contexts. See rootfs/README.md → "Inside the nix shell".)
 *
 * Run from `app/`:
 *   pnpm dlx tsx src/lib/sandbox/scripts/smoke-scripted.ts
 *
 * Expected: each invocation writes a Python script counting words in a
 * fixed sentence, runs it via in-VM bash, and prints the count (9). After
 * the second invocation, bootCount remains 1 — proof of pool hit.
 */

import { DockerBackend } from '../docker-backend.server'
import { WarmPool } from '../warm-pool.server'
import { SandboxScheduler } from '../scheduler.server'
import { withSandbox } from '../with-sandbox.server'
import { actorCritic } from '../../harness-patterns/patterns/actorCritic.server'
import { createScope } from '../../harness-patterns/context.server'
import { createEventView } from '../../harness-patterns/patterns'
import type {
  ActorControllerFnWithLLMData,
  CriticFnWithLLMData,
} from '../../harness-patterns/baml-adapters.server'
import { printEventSummary, checkRootfsImage } from './_shared'

const SENTENCE = 'the quick brown fox jumps over the lazy dog'
const SCRIPT = `text = "${SENTENCE}"\nprint(len(text.split()))\n`

// Fresh actor/critic factory — one set of closures per invocation so counts
// don't bleed between runs.
function makeScriptedActorCritic(): {
  actor: ActorControllerFnWithLLMData
  critic: CriticFnWithLLMData
  counts: () => { actorCalls: number; criticCalls: number }
} {
  let actorCalls = 0
  let criticCalls = 0
  const actor: ActorControllerFnWithLLMData = async () => {
    actorCalls += 1
    if (actorCalls === 1) {
      return {
        action: {
          reasoning: 'Write the word-count script to /work/count.py.',
          tool_name: 'sandbox_write',
          tool_args: JSON.stringify({ path: '/work/count.py', content: SCRIPT }),
          status: 'success',
          is_final: false,
        },
      }
    }
    return {
      action: {
        reasoning: 'Run the script with python3.',
        tool_name: 'sandbox_bash',
        tool_args: JSON.stringify({ command: 'python3 /work/count.py' }),
        status: 'success',
        is_final: false,
      },
    }
  }
  const critic: CriticFnWithLLMData = async () => {
    criticCalls += 1
    return {
      result: {
        is_sufficient: criticCalls >= 2,
        explanation:
          criticCalls === 1 ? 'Script written but not yet executed.' : 'Got the word count.',
        suggested_approach: criticCalls === 1 ? 'Run it with python3.' : undefined,
      },
    }
  }
  return { actor, critic, counts: () => ({ actorCalls, criticCalls }) }
}

async function runOnce(
  label: string,
  backend: DockerBackend,
  pool: WarmPool,
  scheduler: SandboxScheduler,
): Promise<void> {
  const { actor, critic, counts } = makeScriptedActorCritic()
  const pattern = withSandbox({ backend, pool, scheduler, rootfs: 'base' })(
    actorCritic(actor, critic, [], {
      availableTools: [],
      maxRetries: 3,
      patternId: 'smoke-scripted',
      trackHistory: true,
    }),
  )

  const scope = createScope('smoke-scripted', { intent: 'count the words' })
  const view = createEventView({
    sessionId: 'smoke-scripted',
    createdAt: Date.now(),
    events: [
      {
        type: 'user_message' as const,
        ts: Date.now(),
        patternId: 'harness',
        data: { content: `count the words in: ${SENTENCE}` },
      },
    ],
    status: 'running' as const,
    data: {},
    input: `count the words in: ${SENTENCE}`,
  })

  console.log(`\n— ${label} —`)
  const t0 = Date.now()
  const out = await pattern.fn(scope, view)
  const elapsedMs = Date.now() - t0
  printEventSummary(out)
  const final = (out.data as { result?: unknown }).result
  const { actorCalls, criticCalls } = counts()
  console.log(`📦 final result: ${JSON.stringify(final)}`)
  console.log(`⏱  elapsed: ${elapsedMs}ms`)
  console.log(`👣 actor calls: ${actorCalls}, critic calls: ${criticCalls}`)
}

async function main(): Promise<void> {
  console.log('🚀 LLM-free sandbox smoke — scripted actor/critic (×2 with pool)')
  console.log(`   sentence: "${SENTENCE}"`)
  console.log(`   expected word count: ${SENTENCE.split(/\s+/).length}`)

  await checkRootfsImage()

  // Shared backend + pool + scheduler so the second invocation hits the pool.
  // Count cold boots by wrapping backend.boot.
  const backend = new DockerBackend()
  let bootCount = 0
  const realBoot = backend.boot.bind(backend)
  backend.boot = async (rootfs, runtime) => {
    bootCount += 1
    return realBoot(rootfs, runtime)
  }
  const pool = new WarmPool(backend, { caps: { base: 1 }, idleEvictMs: 60_000 })
  const scheduler = new SandboxScheduler({ globalCap: 4, perSessionCap: 4 })

  try {
    await runOnce('run 1 (cold boot expected)', backend, pool, scheduler)
    console.log(`   bootCount after run 1: ${bootCount} (expected 1)`)
    console.log(`   pool size: ${pool.size('base')} (expected 1 — VM parked)`)

    await runOnce('run 2 (pool hit expected)', backend, pool, scheduler)
    console.log(`\n   bootCount after run 2: ${bootCount} (expected 1 — pool hit)`)
    console.log(`   pool size: ${pool.size('base')} (expected 1 — VM re-parked)`)

    if (bootCount !== 1) {
      throw new Error(`pool-hit assertion failed: bootCount=${bootCount}, expected 1`)
    }
    console.log('\n✅ pool hit confirmed: single docker run across two pattern invocations')
  } finally {
    await pool.shutdown()
  }
}

main().catch((err) => {
  console.error('\n❌ smoke failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
