/**
 * Live smoke test for the memory embedder (`EMBEDDINGS_LOCAL_URL`) — the
 * `embedder` compose service, or any OpenAI-compatible endpoint standing in for
 * it (#419 M8).
 *
 * The hermetic half is `compose-embedder.test.ts` (the service's shape, and that
 * the URL the app is given is the one the memory wake probes) and
 * `smoke-embed.test.ts` (the verdicts below, against hand-made responses). This
 * is the other half: that the weights behind the URL are loaded and answer in
 * the vector space the `memories` column is declared for.
 *
 * It goes through the SAME `embed()` the app calls, pinned `provider: 'local'`
 * (never `openrouter`: memory text must not leave the company's boxes, SD-12),
 * so a URL that works here is a URL the pipeline works on. Three checks:
 *
 *   1. one request, two texts — both come back, 1024-dim (`vector(1024)`), and
 *      the model is the one `embedderWakeModel()` names, which is what the
 *      joint wake's probe sends;
 *   2. the vectors are finite and not all zero — a server that loaded nothing
 *      still answers 200 with a vector in some failure modes;
 *   3. the two texts embed DIFFERENTLY — a constant vector would make every
 *      memory recall at the same distance, silently.
 *
 * Run from `app/`. From the host loop, against `make embed`:
 *
 *   pnpm dlx tsx --env-file=.env src/lib/inference/scripts/smoke-embed.ts
 *
 * The compose `embedder` publishes no port, so from the host reach it the way
 * the app does — from inside the compose network:
 *
 *   docker compose --profile app run --rm --no-deps -v "$PWD:/w:ro" -w /w/app \
 *     -e EMBEDDINGS_LOCAL_URL=http://embedder:8090/v1 node:22 \
 *     npx tsx src/lib/inference/scripts/smoke-embed.ts
 *
 * SCALE-TO-ZERO: a box that sleeps pays its cold start on the first call, so
 * this makes one request, not a loop; the first real wake reading is owed to
 * this script and layer 4's wake scenario (`memory-wake.server.ts`).
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { embed, type EmbeddingResult } from '@hames-ai/harness-patterns/stash/embeddings.server'
import { embedderWakeModel } from '../memory-wake.server'

/** `vector(1024)`: the width the memories column is declared with. */
export const MEMORY_EMBEDDING_DIMENSIONS = 1024

export const SMOKE_TEXTS: readonly [string, string] = [
  'Prefers answers as short bullet lists.',
  'Works in the Brussels office on the finance team.',
]

/** Verdicts on one response, as plain strings; empty means the embedder is good. */
export function embeddingProblems(result: EmbeddingResult, expectedModel: string): string[] {
  const problems: string[] = []
  if (result.provider !== 'local') problems.push(`provider is ${result.provider}, expected local`)
  if (result.model !== expectedModel) {
    problems.push(`model is ${result.model}, the wake probe sends ${expectedModel}`)
  }
  if (result.vectors.length !== SMOKE_TEXTS.length) {
    problems.push(`${result.vectors.length} vectors for ${SMOKE_TEXTS.length} texts`)
  }
  for (const [i, v] of result.vectors.entries()) {
    if (v.length !== MEMORY_EMBEDDING_DIMENSIONS) {
      problems.push(
        `vector ${i} has ${v.length} dimensions, the column is vector(${MEMORY_EMBEDDING_DIMENSIONS})`,
      )
    }
    if (!v.every(Number.isFinite)) problems.push(`vector ${i} has a non-finite component`)
    if (v.every((x) => x === 0)) problems.push(`vector ${i} is all zeros`)
  }
  const [a, b] = result.vectors
  if (a && b && a.length === b.length && a.every((x, i) => x === b[i])) {
    problems.push('the two texts embedded identically')
  }
  return problems
}

async function main(): Promise<void> {
  const url = process.env.EMBEDDINGS_LOCAL_URL
  if (!url) throw new Error('EMBEDDINGS_LOCAL_URL is not set (include the /v1 suffix)')
  const started = Date.now()
  const result = await embed([...SMOKE_TEXTS], {
    provider: 'local',
    dimensions: MEMORY_EMBEDDING_DIMENSIONS,
  })
  const ms = Date.now() - started
  const problems = embeddingProblems(result, embedderWakeModel())
  if (problems.length > 0) throw new Error(problems.join('; '))
  console.log(`✅ ${url}: ${result.model}, ${result.dimensions}-dim, 2 texts in ${ms}ms`)
}

// Same entry-point guard as smoke-verda.ts: a test can import the verdicts
// without sending a request.
const entryPoint = process.argv[1]
if (!entryPoint || path.resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('\n❌ smoke failed:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
