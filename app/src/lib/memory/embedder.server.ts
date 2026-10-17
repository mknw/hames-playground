/** Memory always uses the company-run embedding seam, never the stash provider default. */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import type { MemoryEmbedder } from '@hames-ai/harness-patterns'
import { embed, embeddingSpaceId } from '@hames-ai/harness-patterns/stash/embeddings.server'

assertServerOnImport()

export function memoryEmbeddingConfig() {
  return {
    provider: 'local' as const,
    model: process.env.EMBEDDINGS_LOCAL_MODEL ?? 'Qwen3-Embedding-0.6B',
    baseUrl: process.env.EMBEDDINGS_LOCAL_URL ?? 'http://localhost:8090/v1',
    dimensions: 1024,
  }
}

export function createMemoryEmbedder(): MemoryEmbedder {
  // Fix the space and endpoint together for this config's life.
  const config = memoryEmbeddingConfig()
  return {
    spaceId: embeddingSpaceId(config),
    query: async (text) =>
      (await embed([`Instruct: Retrieve relevant memories about the user\nQuery: ${text}`], config))
        .vectors[0],
    documents: async (texts) => (await embed(texts, config)).vectors,
  }
}
