/**
 * Synthetic per-user memory for the general-next Eval: an in-memory, owner-scoped store
 * behind the same `MemoryStore & MemoryWriteStore` seam the host binds to its encrypted
 * per-user table, holding rows for two invented owners. Recall reads it, the store step
 * (`settleMemory`) previews into it, and an approved proposal (`applyMemoryProposal`)
 * writes it — the same core code the app runs, against this store instead of Postgres.
 *
 * Owner scoping is the double's own: every method resolves the owner on EACH call and
 * touches only that owner's rows, so a recall or a write that reached another owner
 * shows up as that owner's content. It does not prove the host's scoping; the pin for
 * that is `src/__tests__/lib/db/memories-db-store.test.ts`.
 *
 * A transaction snapshots the rows and provenance and restores them when its body
 * throws, which is the rollback the seam requires (F9): core's stale refusal and its
 * provenance-conflict no-op both depend on it.
 *
 * The embedder here is for HERMETIC runs: a deterministic bag of stemmed content words,
 * plus one small axis every text shares, so two texts with a couple of content words in
 * common land near the production embedder's scores (a content question vs. its memory:
 * 0.57 here, 0.55 measured). The axis must stay too small to carry a question that names
 * no content: "what do you remember about me" scores 0.27 here and 0.14 on the production
 * embedder, under the 0.5 floor in both (#982). A live run passes the production embedder
 * instead. Every similarity a scenario relies on is pinned in `synthetic-memory.test.ts`.
 * Synthetic data only.
 */
import type { MemoryConfig } from '@hames-ai/harness-patterns'
import type {
  MemoryCandidate,
  MemoryEmbedder,
  MemoryInsertRow,
  MemoryKind,
  MemorySourceRow,
  MemoryStore,
  MemoryWriteStore,
  MemoryWriteTx,
} from '@hames-ai/harness-patterns/types'
import type { MemoryOwnerId, MemoryRowSnapshot, SeedName } from './memory-scenario'

export const EVAL_OWNER: MemoryOwnerId = 'eval-user'
export const EVAL_OTHER_OWNER: MemoryOwnerId = 'eval-other-user'
export const EVAL_MEMORY_TIER = 'self_deployed'

interface Seed {
  readonly owner: MemoryOwnerId
  readonly id: string
  readonly kind: MemoryKind
  readonly content: string
  readonly evidence: string
}

/** What each owner confirmed in earlier conversations. Synthetic. */
export const SEED_MEMORIES: Readonly<Record<SeedName, Seed>> = {
  lantern: {
    owner: EVAL_OWNER,
    id: 'mem-own-1',
    kind: 'semantic',
    content: 'Works on the Lantern project; its release tag is LANTERN-2.',
    evidence: 'I work on the Lantern project',
  },
  kestrel: {
    owner: EVAL_OTHER_OWNER,
    id: 'mem-other-1',
    kind: 'semantic',
    content: 'Works on the Kestrel project; its release tag is KESTREL-5.',
    evidence: 'I work on the Kestrel project',
  },
  notes: {
    owner: EVAL_OWNER,
    id: 'mem-own-2',
    kind: 'preference',
    content: 'The user likes meeting notes as short bullet points.',
    evidence: 'I like my meeting notes as short bullet points',
  },
}

// ---------------------------------------------------------------------------
// The hermetic embedder
// ---------------------------------------------------------------------------

const DIMENSIONS = 1024
/** The shared axis; its square (1) is every pair's baseline overlap. Kept small enough
 *  that it never lifts a content-free question over the semantic floor (#982). */
const USER_AXIS = 1
const STOPWORDS = new Set(
  (
    'a an the and or but if of to in on for at by with from as is are was were be been am ' +
    'do does did i me my you your it its this that these those what which who how when ' +
    'where why have has had will would can could should not no yes so just also about ' +
    'please now instead than then there their they them we our us he she his her user'
  ).split(' '),
)

/** Lower-cased, NFKC, stopwords out, a trailing plural `s` off; hyphenated ids whole. */
export function memoryTokens(text: string): string[] {
  const words = text
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu)
  const out = new Set<string>()
  for (const word of words ?? []) {
    if (STOPWORDS.has(word)) continue
    out.add(
      word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word,
    )
  }
  return [...out]
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (const ch of text) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

export function syntheticVector(text: string): number[] {
  const v = new Array<number>(DIMENSIONS).fill(0)
  v[0] = USER_AXIS
  for (const token of memoryTokens(text)) v[1 + (fnv1a(token) % (DIMENSIONS - 1))] += 1
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return v.map((x) => x / norm)
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

export const SYNTHETIC_EMBED_SPACE = 'eval-synthetic/bag-of-words-1'

export function createSyntheticEmbedder(): MemoryEmbedder {
  return {
    spaceId: SYNTHETIC_EMBED_SPACE,
    query: async (text) => syntheticVector(text),
    documents: async (texts) => texts.map(syntheticVector),
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

interface Row extends MemoryInsertRow {
  readonly owner: MemoryOwnerId
  evidenceCount: number
  lastSeenAt: number
}

interface Source extends MemorySourceRow {
  readonly owner: MemoryOwnerId
}

export interface SyntheticMemoryStore extends MemoryStore, MemoryWriteStore {
  /** Every owner's rows, for the graders. Not part of the seam. */
  snapshot(): MemoryRowSnapshot[]
  /** Another writer replaces a memory's text (the stale-preview case). Not part of the seam. */
  replaceContent(id: string, content: string): Promise<void>
}

/**
 * The store, bound to `owner` (resolved on every call, like the host's). `embed` is
 * the embedder the turn runs with: seeds are embedded with its document side, so a
 * live run's seeds sit in the production embedding space.
 */
export async function createSyntheticMemoryStore(
  owner: () => string | null,
  embed: MemoryEmbedder,
  seed: readonly SeedName[],
): Promise<SyntheticMemoryStore> {
  const seeds = seed.map((name) => SEED_MEMORIES[name])
  const vectors = seeds.length ? await embed.documents(seeds.map((s) => s.content)) : []
  let rows: Row[] = seeds.map((s, i) => ({
    ...s,
    tier: EVAL_MEMORY_TIER,
    evidenceEventId: `seed-${s.id}`,
    embedding: vectors[i],
    embedSpace: embed.spaceId,
    evidenceCount: 1,
    lastSeenAt: Date.UTC(2026, 9, 1),
  }))
  let sources: Source[] = []
  let clock = Date.UTC(2026, 10, 1)

  const me = (): MemoryOwnerId => {
    const id = owner()
    if (id !== EVAL_OWNER && id !== EVAL_OTHER_OWNER) throw new Error('Memory requires an owner')
    return id
  }
  const mine = (tiers?: readonly string[]) => {
    const id = me()
    return rows.filter((r) => r.owner === id && (!tiers || tiers.includes(r.tier)))
  }
  const own = (id: string): Row => {
    const row = mine().find((r) => r.id === id)
    if (!row) throw new Error('No such memory for this owner')
    return row
  }

  const tx: MemoryWriteTx = {
    nearest: async ({ embedding, embedSpace, tier }) => {
      let best: { id: string; kind: MemoryKind; content: string; similarity: number } | null = null
      for (const r of mine([tier])) {
        if (r.embedSpace !== embedSpace) continue
        const similarity = cosine(embedding, r.embedding)
        if (!best || similarity > best.similarity)
          best = { id: r.id, kind: r.kind, content: r.content, similarity }
      }
      return best
    },
    insert: async (row) => {
      const id = me()
      if (rows.some((r) => r.id === row.id)) throw new Error('Duplicate memory id')
      rows.push({ ...row, owner: id, evidenceCount: 1, lastSeenAt: ++clock })
    },
    reinforce: async (id) => {
      const row = own(id)
      row.evidenceCount++
      row.lastSeenAt = ++clock
    },
    update: async (id, next) => {
      const row = own(id)
      rows = rows.map((r) =>
        r === row ? { ...r, ...next, evidenceCount: r.evidenceCount + 1, lastSeenAt: ++clock } : r,
      )
    },
    addSource: async (src) => {
      const id = me()
      const existing = sources.find(
        (s) => s.owner === id && s.eventId === src.eventId && s.ordinal === src.ordinal,
      )
      if (existing) return { inserted: false, memoryId: existing.memoryId }
      sources.push({ ...src, owner: id })
      return { inserted: true }
    },
    read: async (id) => {
      const row = mine().find((r) => r.id === id)
      return row ? { kind: row.kind, content: row.content } : null
    },
    count: async () => mine().length,
  }

  return {
    count: async (tiers) => mine(tiers).length,
    candidates: async ({ embedding, tiers }): Promise<MemoryCandidate[]> =>
      mine(tiers).map((r) => ({
        id: r.id,
        kind: r.kind,
        tier: r.tier,
        content: r.content,
        embedSpace: r.embedSpace,
        distance: 1 - cosine(embedding, r.embedding),
        lastSeenAt: r.lastSeenAt,
      })),
    transaction: async (fn) => {
      me()
      const saved = { rows: rows.map((r) => ({ ...r })), sources: [...sources] }
      try {
        return await fn(tx)
      } catch (err) {
        rows = saved.rows
        sources = saved.sources
        throw err
      }
    },
    snapshot: () =>
      rows.map((r) => ({
        id: r.id,
        owner: r.owner,
        kind: r.kind,
        content: r.content,
        evidence: r.evidence,
        evidenceCount: r.evidenceCount,
      })),
    replaceContent: async (id, content) => {
      const [embedding] = await embed.documents([content])
      rows = rows.map((r) => (r.id === id ? { ...r, content, embedding } : r))
    },
  }
}

/**
 * The `MemoryConfig` the agent runs with: the production seams where a scenario's
 * claim rides on them (the decide, decide-all and extract adapters, passed in), the
 * synthetic store, and the scenario's switch. `settle.routineKinds` is EMPTY, so every
 * personal memory is proposed for confirmation rather than written unasked: the
 * production default lets a plainly volunteered episodic, semantic or preference
 * memory skip the question, and the Eval's confirm-flow rows must not depend on what
 * the gate's `confirm` field happened to say. That default path is not exercised here.
 */
export function syntheticMemoryConfig(seams: {
  readonly owner: () => string | null
  readonly store: SyntheticMemoryStore
  readonly embed: MemoryEmbedder
  readonly enabled: boolean
  readonly decide: MemoryConfig['decide']
  readonly decideAll?: MemoryConfig['decideAll']
  readonly extract: MemoryConfig['extract']
  readonly confirm: NonNullable<MemoryConfig['confirm']>
}): MemoryConfig {
  return {
    owner: seams.owner,
    store: seams.store,
    decide: seams.decide,
    ...(seams.decideAll ? { decideAll: seams.decideAll } : {}),
    extract: seams.extract,
    embed: seams.embed,
    visibleTiers: (tier) => (tier === EVAL_MEMORY_TIER ? [EVAL_MEMORY_TIER] : []),
    enabled: () => seams.enabled,
    confirm: seams.confirm,
    settle: { routineKinds: [] },
  }
}
