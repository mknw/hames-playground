/**
 * SharePoint co-activity evidence — pure, I/O-free, the other half of
 * `enrich-sharepoint-edges.server.ts`.
 *
 * Mirrors the `edge-inference.ts` / `enrich-org-edges.server.ts` split: the
 * judgement calls — what counts as evidence, how much a shared folder is
 * worth versus a shared site, how recency decays it, what confidence a pair
 * ends up with — live here where they are unit-testable against synthetic
 * fixtures with no database and no Graph credential. The `.server.ts` module
 * only turns Graph pages into {@link DriveItemRecord}s and issues the writes
 * these functions describe.
 *
 * ## Why this exists at all
 * `docs/org-graph.md` §8 scoped a second enrichment lane — co-work edges from
 * M365 activity — and left it unimplemented because the credential in front
 * of it (an app-only token, or a delegated token scoped to one arbitrary
 * user) could not reach "this activity, for the roster" without either a new
 * application permission the owner did not want (`Files.Read.All` /
 * `Sites.Read.All` app-wide would see every private file in the tenant) or a
 * scope gap. The resolution: use the OWNER's own **delegated** token — the
 * same credential the `microsoft-365` agent already runs on, already
 * consented at sign-in — via the offline-token machinery `#205` shipped.
 * That token sees exactly what the owner could see by hand: internally
 * public SharePoint activity, and never a colleague's private file. See
 * `enrich-sharepoint-edges.server.ts`'s header for the mechanism.
 *
 * ## The input shape, and what it deliberately omits
 * A {@link DriveItemRecord} carries no title and no path text — see that
 * type's own doc comment. Everything downstream of Graph decoding operates on
 * opaque ids and small integers, which is what makes it safe to unit-test
 * with realistic-looking fixtures and safe to log without redaction.
 *
 * ## Why folder co-occurrence, not edit history
 * Graph's driveItem resource carries exactly two identities — `createdBy` and
 * `lastModifiedBy` — never a full edit history. So "two people worked
 * together" cannot be read off one item; it is inferred from **two different
 * items landing in the same folder**, on the premise that people who put
 * files in the same place are more likely coordinating than two people who
 * merely have accounts in the same tenant. A shared **site** (but no shared
 * folder) is kept as a second, much weaker signal for the same reason
 * `docs/org-graph.md` already applies to job title vs department: a directory
 * fact everyone in a large group shares is weaker evidence than one only a
 * few people share.
 *
 * ## The confidence formula, stated once
 * Every folder (or site) where two roster members' identities both appear —
 * as author or last editor of *some* item there — contributes one evidence
 * event, weighted by {@link recencyWeight} (how long ago the more recent of
 * the two touches happened) and, for folder events only, {@link depthWeight}
 * (how deep the folder sits — a deep, specific folder is stronger evidence
 * than a site's document-library root). A pair's confidence is the sum of its
 * event weights, capped at {@link MAX_CONFIDENCE} — never 1.0, because this is
 * always an inference over metadata, never an ingested fact — and pairs whose
 * summed weight does not clear {@link MIN_CONFIDENCE} are dropped rather than
 * written as noise.
 */

/**
 * One Graph driveItem, reduced to exactly what evidence extraction needs.
 *
 * Deliberately carries no title, no file name and no path text: those are
 * evidence the lane may READ from Graph but must never persist, because a
 * title can carry sensitive content verbatim. `folderId` is Graph's own
 * opaque `parentReference.id` (a driveItem id, not a path), and `folderDepth`
 * is a small integer the caller computes once from `parentReference.path`'s
 * segment count — the number survives, the path string that produced it does
 * not.
 */
export interface DriveItemRecord {
  /** Graph site id (`parentReference.siteId`) — opaque, not a title. */
  siteId: string
  /** Graph folder id (`parentReference.id`) — opaque, not a path. Items sitting
   *  directly at a drive's root share one caller-chosen sentinel value. */
  folderId: string
  /** Path segments under the drive root (0 = the root itself). */
  folderDepth: number
  /** ISO 8601 `lastModifiedDateTime`. */
  lastModifiedDateTime: string
  /** Roster `Member.entraId` of the item's creator, already resolved by the
   *  caller — `null` when the identity did not match any roster member
   *  (external, a service principal, or a field Graph omitted). */
  createdByEntraId: string | null
  /** Same, for the item's last editor. */
  lastModifiedByEntraId: string | null
}

/** One inferred `(:Member)-[:COLLABORATES_WITH]-(:Member)` edge, before it is
 *  written. Undirected in meaning — `aEntraId < bEntraId` is the only ordering
 *  applied, purely so the same pair always MERGEs onto the same relationship
 *  instead of creating both directions. */
export interface PairEvidence {
  aEntraId: string
  bEntraId: string
  confidence: number
  /** Number of distinct folder/site co-occurrence events summed into
   *  {@link confidence} — the "evidence counts" a re-run can reproduce. */
  evidenceCount: number
  /** Distinct sites that contributed at least one event. */
  siteCount: number
  /** How recent the most recent contributing event was. */
  recencyBucket: 'recent' | 'moderate' | 'stale'
}

export const COACTIVITY_BASIS = 'sharepoint-coactivity'

// ============================================================================
// Weights — one constant per judgement call, so a report can name the method
// without re-deriving it, and so each number is set exactly once.
// ============================================================================

/** Base weight of one shared-folder event, before recency/depth scaling. */
export const FOLDER_BASE_WEIGHT = 0.5
/** Base weight of one shared-site-only event (no shared folder). Deliberately
 *  well under {@link FOLDER_BASE_WEIGHT}: a site is often the whole
 *  department's document library, so sharing one proves much less than
 *  sharing a folder inside it. */
export const SITE_BASE_WEIGHT = 0.15

/** A pair's confidence is a sum of event weights, capped here — never 1.0,
 *  because this is always an inference over metadata. */
export const MAX_CONFIDENCE = 0.95
/** Pairs summing to less than this are dropped as noise rather than written —
 *  the "no full-tenant crawl" courtesy applied to the OUTPUT side: a giant
 *  site with hundreds of unrelated editors should not mint hundreds of
 *  near-zero edges. */
export const MIN_CONFIDENCE = 0.15

/**
 * How much a folder's depth under the drive root strengthens an event. Root
 * level (a document library's top) is where every department dumps files
 * regardless of who works with whom; several levels down is a
 * project/topic-specific folder, which is much more specific evidence.
 */
export function depthWeight(folderDepth: number): number {
  if (folderDepth <= 0) return 0.4
  if (folderDepth <= 2) return 0.7
  return 1.0
}

/**
 * How much recency strengthens an event, from the number of days between the
 * event's most recent touch and `now`. Thresholds are calendar-rough by
 * design (30/90/365 days) — this is a courtesy heuristic over metadata, not a
 * measurement precise enough to justify finer buckets.
 */
export function recencyWeight(daysSince: number): number {
  if (daysSince <= 30) return 1.0
  if (daysSince <= 90) return 0.6
  if (daysSince <= 365) return 0.3
  return 0.1
}

/** The same day thresholds as {@link recencyWeight}, restated as the bucket an
 *  edge's `recencyBucket` property reports — the human-readable half of the
 *  same judgement call. */
export function recencyBucket(daysSince: number): PairEvidence['recencyBucket'] {
  if (daysSince <= 30) return 'recent'
  if (daysSince <= 180) return 'moderate'
  return 'stale'
}

function daysBetween(iso: string, now: Date): number {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY
  return Math.max(0, (now.getTime() - then) / 86_400_000)
}

/** Canonical, order-independent key for an unordered pair — sorted so the
 *  same two people always produce the same key regardless of which one is
 *  `a` and which is `b` in the caller's data. */
function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

interface Accumulator {
  weight: number
  events: number
  sites: Set<string>
  mostRecentDaysSince: number
}

function accumulate(
  acc: Map<string, Accumulator>,
  a: string,
  b: string,
  weight: number,
  siteId: string,
  daysSince: number,
): void {
  if (a === b) return // one person touching their own work is not co-work
  const [x, y] = pairKey(a, b)
  const key = `${x} ${y}`
  const entry = acc.get(key) ?? {
    weight: 0,
    events: 0,
    sites: new Set<string>(),
    mostRecentDaysSince: Number.POSITIVE_INFINITY,
  }
  entry.weight += weight
  entry.events += 1
  entry.sites.add(siteId)
  entry.mostRecentDaysSince = Math.min(entry.mostRecentDaysSince, daysSince)
  acc.set(key, entry)
}

/** The distinct roster identities an item names — `createdBy`/`lastModifiedBy`
 *  collapsed to a de-duplicated list, dropping unresolved (`null`) ones. */
function actorsOf(item: DriveItemRecord): string[] {
  const ids = [item.createdByEntraId, item.lastModifiedByEntraId].filter(
    (id): id is string => id != null,
  )
  return [...new Set(ids)]
}

/**
 * Every unordered pair drawn from a list of distinct actors. Pure combinatoric
 * helper — the evidence weighting lives in the caller, not here.
 */
function pairsOf(actors: readonly string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (let i = 0; i < actors.length; i++) {
    for (let j = i + 1; j < actors.length; j++) pairs.push([actors[i], actors[j]])
  }
  return pairs
}

/**
 * Turn a batch of {@link DriveItemRecord}s into {@link PairEvidence} rows.
 *
 * Deterministic and re-runnable: the same items (in any order) always produce
 * the same pairs with the same confidence, because grouping is by opaque id
 * (never by insertion order) and every weight is a pure function of
 * (depth, daysSince). `now` is a parameter rather than `Date.now()` for
 * exactly that reason — see this repo's workflow-script convention.
 */
export function extractCoworkPairs(items: readonly DriveItemRecord[], now: Date): PairEvidence[] {
  const folders = new Map<
    string,
    { siteId: string; folderDepth: number; actors: Set<string>; mostRecentIso: string }
  >()
  const sites = new Map<string, { actors: Set<string>; mostRecentIso: string }>()

  for (const item of items) {
    const actors = actorsOf(item)
    if (actors.length === 0) continue

    const folderKey = `${item.siteId} ${item.folderId}`
    const folder = folders.get(folderKey) ?? {
      siteId: item.siteId,
      folderDepth: item.folderDepth,
      actors: new Set<string>(),
      mostRecentIso: item.lastModifiedDateTime,
    }
    for (const a of actors) folder.actors.add(a)
    if (new Date(item.lastModifiedDateTime) > new Date(folder.mostRecentIso)) {
      folder.mostRecentIso = item.lastModifiedDateTime
    }
    folders.set(folderKey, folder)

    const site = sites.get(item.siteId) ?? {
      actors: new Set<string>(),
      mostRecentIso: item.lastModifiedDateTime,
    }
    for (const a of actors) site.actors.add(a)
    if (new Date(item.lastModifiedDateTime) > new Date(site.mostRecentIso)) {
      site.mostRecentIso = item.lastModifiedDateTime
    }
    sites.set(item.siteId, site)
  }

  const acc = new Map<string, Accumulator>()

  for (const folder of folders.values()) {
    const daysSince = daysBetween(folder.mostRecentIso, now)
    const weight = FOLDER_BASE_WEIGHT * recencyWeight(daysSince) * depthWeight(folder.folderDepth)
    for (const [a, b] of pairsOf([...folder.actors])) {
      accumulate(acc, a, b, weight, folder.siteId, daysSince)
    }
  }

  for (const [siteId, site] of sites) {
    const daysSince = daysBetween(site.mostRecentIso, now)
    const weight = SITE_BASE_WEIGHT * recencyWeight(daysSince)
    for (const [a, b] of pairsOf([...site.actors])) {
      accumulate(acc, a, b, weight, siteId, daysSince)
    }
  }

  const rows: PairEvidence[] = []
  for (const [key, entry] of acc) {
    const confidence = Math.min(MAX_CONFIDENCE, Math.round(entry.weight * 100) / 100)
    if (confidence < MIN_CONFIDENCE) continue
    const [aEntraId, bEntraId] = key.split(' ')
    rows.push({
      aEntraId,
      bEntraId,
      confidence,
      evidenceCount: entry.events,
      siteCount: entry.sites.size,
      recencyBucket: recencyBucket(entry.mostRecentDaysSince),
    })
  }
  // Deterministic order: by pair key, not by Map insertion/iteration order —
  // `Map` iteration is insertion order in practice, but the ontology promises
  // nothing about the order Graph pages arrive in across a re-run.
  rows.sort((r1, r2) => (r1.aEntraId + r1.bEntraId).localeCompare(r2.aEntraId + r2.bEntraId))
  return rows
}

/** Edge count by confidence bucket (rounded to one decimal), for a report that
 *  can be pasted into a PR without naming a single pair. Mirrors
 *  `edge-inference.ts`'s `tallyConfidence`, bucketed rather than exact because
 *  this module's confidence is a continuous sum, not one of three fixed
 *  constants. */
export function tallyConfidenceBuckets(
  rows: readonly { confidence: number }[],
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const row of rows) {
    const bucket = (Math.round(row.confidence * 10) / 10).toFixed(1)
    out[bucket] = (out[bucket] ?? 0) + 1
  }
  return out
}
