/** Pure compaction rules (#419 M3). No model, store, clock or network calls. */
import { assertServerOnImport } from './assert.server'
import { acceptCandidate, MEMORY_KINDS } from './memory-acceptance.server'
import type { MemoryCompactionRow, MemoryRetention } from './types'

assertServerOnImport()

export const DEFAULT_MEMORY_RETENTION: Readonly<Required<MemoryRetention>> = Object.freeze({
  episodic: 180,
  semantic: null,
  preference: null,
  trait: null,
}) satisfies MemoryRetention

/** Reject invalid config rather than accidentally turning it into an erasure. */
export function memoryRetention(cfg: MemoryRetention = {}): typeof DEFAULT_MEMORY_RETENTION {
  const retention = { ...DEFAULT_MEMORY_RETENTION, ...cfg }
  for (const kind of MEMORY_KINDS) {
    const days = retention[kind]
    if (days !== null && (typeof days !== 'number' || !Number.isFinite(days) || days < 0))
      throw new TypeError('memory retention must be nonnegative finite days or null')
  }
  return retention
}

export function expiredMemories(
  rows: readonly MemoryCompactionRow[],
  now: number,
  cfg?: MemoryRetention,
): MemoryCompactionRow[] {
  const retention = memoryRetention(cfg)
  return rows.filter((row) => {
    const days = retention[row.kind]
    return (
      days !== null && Number.isFinite(row.lastSeenAt) && now >= row.lastSeenAt + days * 86_400_000
    )
  })
}

/** Stable order also decides which member supplies evidence on equal dates. */
export const memoryOrder = (a: MemoryCompactionRow, b: MemoryCompactionRow): number =>
  a.lastSeenAt - b.lastSeenAt || a.id.localeCompare(b.id, 'en')

export function memoryCosine(a: readonly number[], b: readonly number[]): number {
  if (!a.length || a.length !== b.length || !a.every(Number.isFinite) || !b.every(Number.isFinite))
    return -Infinity
  // Scale first: very large finite components must not overflow into similarity.
  const sa = Math.max(...a.map(Math.abs))
  const sb = Math.max(...b.map(Math.abs))
  if (sa === 0 || sb === 0) return -Infinity
  let dot = 0,
    aa = 0,
    bb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] / sa,
      y = b[i] / sb
    dot += x * y
    aa += x * x
    bb += y * y
  }
  return dot / Math.sqrt(aa * bb)
}

/** Greedy single-link, including bridge members joining earlier clusters.
 *  Never compare tiers, kinds or embedding spaces. Invalid vectors stay single. */
export function clusterMemories(
  rows: readonly MemoryCompactionRow[],
  threshold = 0.85,
): MemoryCompactionRow[][] {
  if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1)
    throw new TypeError('memory cluster similarity must lie in [-1, 1]')
  const clusters: MemoryCompactionRow[][] = []
  for (const row of [...rows].sort(memoryOrder)) {
    const linked: number[] = []
    clusters.forEach((cluster, i) => {
      if (
        cluster.some(
          (m) =>
            m.tier === row.tier &&
            m.kind === row.kind &&
            m.embedSpace === row.embedSpace &&
            memoryCosine(m.embedding, row.embedding) >= threshold,
        )
      )
        linked.push(i)
    })
    if (!linked.length) clusters.push([row])
    else {
      const first = linked[0]
      clusters[first].push(row)
      for (const i of linked.slice(1).reverse()) clusters[first].push(...clusters.splice(i, 1)[0])
      clusters[first].sort(memoryOrder)
    }
  }
  return clusters
}

/** Evidence must be EXACTLY the newest member's span. Model output cannot pick
 *  another event id or change the kind. Acceptance reuses M2's length, entity
 *  closure and sanitizer controls against members' content AND evidence. */
export function acceptCompaction(
  value: { readonly content: string; readonly evidence: string },
  members: readonly MemoryCompactionRow[],
): boolean {
  if (members.length < 2 || !value) return false
  const ordered = [...members].sort(memoryOrder)
  const latest = ordered[ordered.length - 1]
  if (value.evidence !== latest.evidence) return false
  if (
    members.some(
      (m) => m.kind !== latest.kind || m.tier !== latest.tier || m.embedSpace !== latest.embedSpace,
    )
  )
    return false
  return acceptCandidate(
    { ...value, kind: latest.kind },
    {
      latestUser: latest.evidence,
      userMessages: members.flatMap((m) => [m.content, m.evidence]),
    },
  ).ok
}
