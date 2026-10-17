/** Once per startup, content-free and loopback-only. No BAML or GPU wake imports. */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { ensureMemoriesSchema, isMemoryAvailable } from '../db/memories.server'
import { embed, embeddingSpaceId } from '@hames-ai/harness-patterns/stash/embeddings.server'
import { memoryEmbeddingConfig } from './embedder.server'

assertServerOnImport()

const KEY = Symbol.for('hames-app.memory-boot-probe')
type BootGlobal = typeof globalThis & { [KEY]?: Promise<void> }

export function probeMemoryAtBoot(): Promise<void> {
  return ((globalThis as BootGlobal)[KEY] ??= probe())
}

async function probe(): Promise<void> {
  let schema = false
  let embedder = 'not-probed'
  let space = 'unknown'
  try {
    await ensureMemoriesSchema()
    schema = isMemoryAvailable()
  } catch {
    // No exception text: drivers can quote data or credentials.
  }
  try {
    const config = memoryEmbeddingConfig()
    space = embeddingSpaceId(config)
    const url = new URL(config.baseUrl)
    // A remote internal endpoint may itself scale to zero. Startup observes only
    // the local sidecar, never wakes that endpoint or follows a redirect to it.
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      embedder = 'not-probed-off-box'
    } else {
      const result = await embed(['wake'], {
        ...config,
        fetchImpl: (input, init) =>
          fetch(input, {
            ...init,
            redirect: 'error',
            signal: AbortSignal.timeout(1500),
          }),
      })
      if (result.vectors.length !== 1 || !result.vectors[0].every(Number.isFinite))
        throw new Error()
      space = embeddingSpaceId(result)
      embedder = 'answering'
    }
  } catch {
    embedder = 'unavailable'
  }
  // Off-box is not probed by design, and is not evidence of absence: runtime
  // memory still wakes and uses that endpoint, so it must not read as DISABLED.
  const verdict = !schema
    ? 'DISABLED'
    : embedder === 'answering'
      ? 'ENABLED'
      : embedder === 'not-probed-off-box'
        ? 'ENABLED (embedder not probed)'
        : 'DISABLED'
  console.info(
    `[memory] ${verdict}: schema/extension=${schema ? 'available' : 'unavailable'}; embedder=${embedder}; embeddingSpaceId=${space}`,
  )
}
