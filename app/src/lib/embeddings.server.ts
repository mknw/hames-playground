/**
 * Embeddings — Server Only (Issue #8)
 *
 * Provider-pluggable text embedding for the ingestion pipeline. Turns chunk
 * text (#9) into vectors that get stored in Redis for similarity search (#6).
 *
 * ── Comparability is the whole point ──────────────────────────────────────
 * Vectors are only comparable when produced by the *same* model. Cosine
 * similarity between a vector from Qwen3-Embedding-0.6B and one from a Nemotron
 * model is meaningless — different vector spaces, often different dimensions.
 *
 * Therefore this module does **NOT** do the BAML-style silent runtime fallback
 * across providers. The provider+model is a deliberate, configured property of
 * an *embedding space* (and thus of a whole vector index / corpus). If the
 * chosen provider fails, we throw — we never quietly re-embed with a different
 * model that would poison the index. Use {@link assertSameSpace} to enforce
 * that a query embedding matches the index it searches.
 *
 * ── Providers ─────────────────────────────────────────────────────────────
 *   - `local`      (dev default) — `llama-server --embedding` on :8090 serving
 *                  Qwen3-Embedding-0.6B over the OpenAI-compatible
 *                  `POST /v1/embeddings`. (Distinct from `pnpm dev:llama`, which
 *                  serves a *chat* model on :8080.)
 *   - `openrouter` (prod / fallback you opt into) — OpenRouter's
 *                  `/v1/embeddings`. Requires `OPENROUTER_API_KEY`.
 *
 * Both speak the OpenAI embeddings wire format, so one client handles both.
 * `embed()` returns the vectors *with* their `{ provider, model, dimensions }`
 * so callers can tag the index and detect mismatches — that metadata travelling
 * with the vectors is what makes the comparability guard enforceable.
 */

import { assertServerOnImport } from './harness-patterns/assert.server'

assertServerOnImport()

// ============================================================================
// Types
// ============================================================================

export type EmbeddingProvider = 'local' | 'openrouter'

export interface EmbeddingConfig {
  /** Provider; defaults to `EMBEDDINGS_PROVIDER` env or `'local'`. */
  provider?: EmbeddingProvider
  /** Model id override. */
  model?: string
  /** OpenAI-compatible base URL (no trailing `/embeddings`). */
  baseUrl?: string
  /** API key; defaults from env per provider (none needed for local). */
  apiKey?: string
  /** Requested output dimensions (only honoured by models that support it). */
  dimensions?: number
  /** Max texts per HTTP request (server batch-size guard). Default 64. */
  batchSize?: number
  /** Injectable fetch for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
}

/** The identity of an embedding space — what makes two vectors comparable. */
export interface EmbeddingSpace {
  provider: EmbeddingProvider
  model: string
  dimensions: number
}

/** Vectors plus the space they belong to. */
export interface EmbeddingResult extends EmbeddingSpace {
  vectors: number[][]
}

/** A single embedding plus its space. */
export interface SingleEmbeddingResult extends EmbeddingSpace {
  vector: number[]
}

interface ResolvedConfig {
  provider: EmbeddingProvider
  baseUrl: string
  model: string
  apiKey?: string
  dimensions?: number
  batchSize: number
  fetchImpl: typeof fetch
}

// ============================================================================
// Defaults
// ============================================================================

const LOCAL_DEFAULT_URL = 'http://localhost:8090/v1'
const LOCAL_DEFAULT_MODEL = 'Qwen3-Embedding-0.6B'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1'
const OPENROUTER_DEFAULT_MODEL = 'nvidia/llama-nemotron-embed-vl-1b-v2:free'
const DEFAULT_BATCH_SIZE = 64

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

// ============================================================================
// Config resolution — provider chosen explicitly, never as a silent fallback
// ============================================================================

function resolveConfig(config?: EmbeddingConfig): ResolvedConfig {
  const provider =
    config?.provider ??
    (process.env.EMBEDDINGS_PROVIDER as EmbeddingProvider | undefined) ??
    'local'

  if (provider !== 'local' && provider !== 'openrouter') {
    throw new Error(`Unknown embedding provider: ${String(provider)}`)
  }

  const common = {
    dimensions: config?.dimensions,
    batchSize: Math.max(1, config?.batchSize ?? DEFAULT_BATCH_SIZE),
    fetchImpl: config?.fetchImpl ?? fetch,
  }

  if (provider === 'local') {
    return {
      provider,
      baseUrl: stripTrailingSlash(
        config?.baseUrl ?? process.env.EMBEDDINGS_LOCAL_URL ?? LOCAL_DEFAULT_URL,
      ),
      model: config?.model ?? process.env.EMBEDDINGS_LOCAL_MODEL ?? LOCAL_DEFAULT_MODEL,
      apiKey: config?.apiKey, // llama-server needs none
      ...common,
    }
  }

  // openrouter
  const apiKey = config?.apiKey ?? process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY is required for the openrouter embedding provider',
    )
  }
  return {
    provider,
    baseUrl: stripTrailingSlash(config?.baseUrl ?? OPENROUTER_URL),
    model: config?.model ?? OPENROUTER_DEFAULT_MODEL,
    apiKey,
    ...common,
  }
}

// ============================================================================
// Embedding
// ============================================================================

/**
 * Embed an array of texts. Batches large inputs to respect server limits.
 * Returns vectors tagged with their `{ provider, model, dimensions }`.
 *
 * @throws if the provider/config is invalid, the HTTP request fails, the
 *         response is malformed, or the returned vectors are inconsistent in
 *         dimensionality (which would silently break similarity search).
 */
export async function embed(
  texts: string[],
  config?: EmbeddingConfig,
): Promise<EmbeddingResult> {
  const cfg = resolveConfig(config)
  if (texts.length === 0) {
    return { provider: cfg.provider, model: cfg.model, dimensions: cfg.dimensions ?? 0, vectors: [] }
  }

  const vectors: number[][] = []
  for (let i = 0; i < texts.length; i += cfg.batchSize) {
    const batch = texts.slice(i, i + cfg.batchSize)
    vectors.push(...(await requestEmbeddings(cfg, batch)))
  }

  const dimensions = vectors[0]?.length ?? 0
  for (const v of vectors) {
    if (v.length !== dimensions) {
      throw new Error(
        `Inconsistent embedding dimensions from ${cfg.model}: got ${v.length}, expected ${dimensions}`,
      )
    }
  }
  if (cfg.dimensions != null && dimensions !== cfg.dimensions) {
    throw new Error(
      `Model ${cfg.model} returned ${dimensions}-dim vectors but ${cfg.dimensions} were requested`,
    )
  }

  return { provider: cfg.provider, model: cfg.model, dimensions, vectors }
}

/** Convenience: embed a single text and return its vector + space. */
export async function embedOne(
  text: string,
  config?: EmbeddingConfig,
): Promise<SingleEmbeddingResult> {
  const res = await embed([text], config)
  return {
    provider: res.provider,
    model: res.model,
    dimensions: res.dimensions,
    vector: res.vectors[0],
  }
}

async function requestEmbeddings(cfg: ResolvedConfig, batch: string[]): Promise<number[][]> {
  let res: Response
  try {
    res = await cfg.fetchImpl(`${cfg.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        input: batch,
        ...(cfg.dimensions ? { dimensions: cfg.dimensions } : {}),
      }),
    })
  } catch (err) {
    const hint =
      cfg.provider === 'local'
        ? ` (is llama-server --embedding running at ${cfg.baseUrl}?)`
        : ''
    throw new Error(
      `Embedding request to ${cfg.provider} failed: ${err instanceof Error ? err.message : String(err)}${hint}`,
    )
  }

  if (!res.ok) {
    throw new Error(
      `Embedding request to ${cfg.provider} failed: ${res.status} ${await safeText(res)}`,
    )
  }

  const json = (await res.json()) as { data?: Array<{ embedding?: number[]; index?: number }> }
  if (!json || !Array.isArray(json.data)) {
    throw new Error(`Unexpected embeddings response shape from ${cfg.provider}`)
  }
  // Preserve input order (OpenAI returns `index`; sort defensively).
  return json.data
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((d) => {
      if (!Array.isArray(d.embedding)) {
        throw new Error(`Embedding item missing an "embedding" array (${cfg.provider})`)
      }
      return d.embedding
    })
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500)
  } catch {
    return '<no body>'
  }
}

// ============================================================================
// Comparability guard — the same-model-per-corpus invariant
// ============================================================================

/** Stable id for an embedding space; equal ids ⇒ comparable vectors. */
export function embeddingSpaceId(space: EmbeddingSpace): string {
  return `${space.provider}:${space.model}:${space.dimensions}`
}

/**
 * Throw unless `actual` belongs to the same embedding space as `expected`.
 * Use when inserting into or querying a vector index that was built with a
 * known space — mixing models silently returns garbage rankings.
 */
export function assertSameSpace(expected: EmbeddingSpace, actual: EmbeddingSpace): void {
  if (embeddingSpaceId(expected) !== embeddingSpaceId(actual)) {
    throw new Error(
      `Embedding space mismatch: this corpus was built with ` +
        `${embeddingSpaceId(expected)}, but the new embedding is ` +
        `${embeddingSpaceId(actual)}. Vectors from different models are not ` +
        `comparable — re-embed the corpus with one model, or query with the ` +
        `model the index was built with.`,
    )
  }
}
