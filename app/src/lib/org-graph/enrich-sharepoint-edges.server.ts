/**
 * SharePoint co-activity enrichment — Server Only.
 *
 * The second org-graph enrichment lane `docs/org-graph.md` §8 scoped and left
 * unimplemented: co-work edges inferred from M365 activity. §8 blocked on the
 * credential — the roster ingest's app-only token holds `User.Read.All` only,
 * and widening it to `Files.Read.All` / `Sites.Read.All` **application**
 * permissions would see every private file in the tenant, which the owner
 * explicitly does not want (2026-08-27: "the delegated file permission does
 * not allow to see private users' files (and it shouldn't)").
 *
 * ## The mechanism: the owner's own delegated token, offline
 * This module reuses the credential the `microsoft-365` agent already runs
 * on — `getUserGraphToken` / `graphFetch` in `auth/graph-token.server.ts` —
 * for the **owner's** `userId`, via the offline-token machinery `#205`
 * shipped (`docs/plan/offline-agent-auth.md` §1: an encrypted, per-user MSAL
 * cache that outlives any browser session, redeemed with
 * `acquireTokenSilent`). `Files.Read.All` and `Sites.Read.All` are already in
 * `DEFAULT_GRAPH_SCOPES` (`auth/entra-config.server.ts`) and were consented
 * at the owner's last sign-in.
 *
 * This is not a new credential pattern and nothing here touches token
 * storage, encryption or acquisition — it is Pattern C (#110), used exactly
 * as `microsoft-365.server.ts` uses it, for one specific, named user instead
 * of "whoever is signed in". The token sees precisely what the owner could
 * see by opening SharePoint themselves: their own files, and every
 * internally-shared/public site they have access to — never a colleague's
 * private OneDrive. **No app-only fallback, ever**: a `GraphAuthRequiredError`
 * here means the owner's cached credential is missing or expired, and the fix
 * is the owner signing in again — not a wider permission (see
 * `docs/plan/offline-agent-auth.md`'s "app-only fallback" rule, which this
 * module does not violate: it never acquires or falls back to an app token).
 *
 * ## What never touches the graph, or an LLM
 * File names, titles and path text are read from Graph (they are in the
 * driveItem payload) but are **never requested via `$select`**, never held
 * past the single item they came from, and never written anywhere — see
 * `sharepoint-coactivity.ts`'s `DriveItemRecord` for the reduced shape that is
 * this module's only in-memory representation of an item. No LLM call reads
 * any of this: pair extraction is the pure, deterministic function in that
 * module, so there is no `tool_result` here and no injection-guard boundary
 * to cross (SD-1 does not apply — nothing here is model-visible).
 *
 * ## Identity resolution
 * A driveItem's `createdBy`/`lastModifiedBy` carry a Graph identity, matched
 * against the roster already in Neo4j by AAD object id first
 * (`Member.entraId`), then by email (`Member.mail`, case-insensitively). An
 * identity that matches neither — an external guest, a service principal, a
 * departed member whose roster row was never deleted (see
 * `docs/org-graph.md` §5 "Upsert, not sync") — is simply dropped: this lane
 * only ever writes `Member`↔`Member` edges, so an unresolved identity
 * contributes no evidence and leaves no trace, anywhere.
 *
 * ## Rate-limit courtesy, and what "resumable/re-runnable" means here
 * Requests are sequential (never fanned out) and every collection read is
 * capped — {@link MAX_SITES}, {@link MAX_DRIVES_PER_SITE},
 * {@link MAX_PAGES_PER_DRIVE} — so a run against a large tenant degrades by
 * covering less breadth rather than by hammering Graph; a capped run reports
 * `sitesTruncated`/`drivesTruncated` rather than silently under-covering.
 * "Resumable" is satisfied the same way phase 1 satisfies it: **idempotent
 * full re-derivation**, not incremental delta-token persistence. Every run
 * clears every `COLLABORATES_WITH` edge before re-deriving from Graph's
 * current state, so an interrupted run leaves nothing half-written (nothing is
 * written until the whole pair list is computed) and a re-run reproduces the
 * same edges from the same tenant state. A true incremental resume (Graph's
 * `/delta` link persisted between runs) would need a place to store that
 * link and was judged more machinery than this first cut needs — the tenant
 * is small enough that a full re-scan is cheap; flagged here rather than
 * silently assumed.
 *
 * Not a `'use server'` export, and never should be — see `schema.server.ts`'s
 * header (SD-13): a function that reads a person's Microsoft 365 activity
 * must not be browser-reachable. Entry point is
 * `scripts/enrich-sharepoint-edges.ts`.
 */
import neo4j from 'neo4j-driver'
import { assertServerOnImport } from '../harness-patterns/assert.server'
import { getNeo4jDriver } from '../neo4j/client'
import { graphFetch, GraphAuthRequiredError } from '../auth/graph-token.server'
import { listUsers } from '../auth/users.server'
import { hasUserTokenCache } from '../auth/user-tokens.server'
import { ensureOrgGraphSchema } from './schema.server'
import {
  COACTIVITY_BASIS,
  extractCoworkPairs,
  tallyConfidenceBuckets,
  type DriveItemRecord,
  type PairEvidence,
} from './sharepoint-coactivity'

assertServerOnImport()

/** Delegated scopes this lane needs — both already in `DEFAULT_GRAPH_SCOPES`
 *  and consented at sign-in; listed explicitly so a missing consent fails
 *  with a scope name rather than a bare 403. */
export const SHAREPOINT_SCOPES = ['Sites.Read.All', 'Files.Read.All'] as const

// Courtesy caps — see the module header's "Rate-limit courtesy" section.
export const MAX_SITES = 50
/** A generous ceiling on how many `/sites?search=*` pages to walk — independent
 *  of {@link MAX_SITES} because Graph's own page size for this endpoint is not
 *  fixed, so a page-count cap derived from MAX_SITES risks stopping before a
 *  single small page fills it. Fetching stops as soon as either cap is hit. */
export const MAX_SITE_PAGES = 10
export const MAX_DRIVES_PER_SITE = 5
export const MAX_PAGES_PER_DRIVE = 20
/** Graph's own page-size default for `/delta` is small; this only bounds how
 *  many pages we walk, not the page size itself. */
export const DELTA_SELECT =
  'file,folder,createdBy,lastModifiedBy,lastModifiedDateTime,parentReference'

export interface SharePointEnrichmentReport {
  sitesCovered: number
  sitesTruncated: boolean
  drivesCovered: number
  drivesTruncated: boolean
  itemsScanned: number
  /** Items where at least one of createdBy/lastModifiedBy resolved to a
   *  roster member — the rest contributed nothing. */
  itemsWithResolvedIdentity: number
  edgesCleared: number
  pairsWritten: number
  confidenceDistribution: Record<string, number>
}

/** A page of a Graph collection. */
interface GraphPage {
  value?: unknown[]
  '@odata.nextLink'?: string
}

// ============================================================================
// Owner resolution — the offline-token machinery, consumed, not modified
// ============================================================================

/**
 * Resolve the Entra `oid` for the app's own record of the signed-in owner,
 * given their email, and confirm they have a usable offline Graph credential.
 *
 * `hasUserTokenCache` is a presence check, not a validity one — the row
 * survives an expired refresh token or a revoked account
 * (`docs/plan/offline-agent-auth.md` §4, tier 2's own caveat) — so this is
 * only the FRIENDLY pre-check that plan explicitly sanctions ("a useful cheap
 * pre-check for a friendly error"); the real validity check is the first
 * `graphFetch` call below, which throws {@link GraphAuthRequiredError} on
 * anything Entra actually refuses.
 */
export async function resolveOwnerUserId(ownerEmail: string): Promise<string> {
  const users = await listUsers()
  const match = users.find((u) => u.email.toLowerCase() === ownerEmail.trim().toLowerCase())
  if (!match) {
    throw new Error(
      `No signed-in user found for ${ownerEmail} — sign in to the app once at ` +
        `/auth/signin with that account, then re-run this script.`,
    )
  }
  const cached = await hasUserTokenCache(match.id)
  if (!cached) {
    throw new Error(
      `${ownerEmail} has never completed Microsoft sign-in on this app (no stored ` +
        `token cache) — sign in once at /auth/signin, then re-run this script.`,
    )
  }
  return match.id
}

// ============================================================================
// Graph reads — sequential, capped, delegated as the owner
// ============================================================================

async function paginate(
  ownerId: string,
  firstPath: string,
  maxPages: number,
  onPage: (rows: unknown[]) => void,
): Promise<{ pages: number; truncated: boolean }> {
  let path: string | null = firstPath
  let pages = 0
  while (path && pages < maxPages) {
    const page = (await graphFetch(ownerId, path, { scopes: SHAREPOINT_SCOPES })) as GraphPage
    pages += 1
    onPage(page.value ?? [])
    path = typeof page['@odata.nextLink'] === 'string' ? page['@odata.nextLink'] : null
  }
  return { pages, truncated: path != null }
}

/** Every SharePoint site the owner's token can see, id only. Stops as soon as
 *  either {@link MAX_SITES} or {@link MAX_SITE_PAGES} is reached, whichever
 *  comes first — not `paginate`'s single fixed page cap, because a page-count
 *  ceiling derived from MAX_SITES would be wrong for any page size Graph
 *  actually uses. */
async function fetchSiteIds(ownerId: string): Promise<{ ids: string[]; truncated: boolean }> {
  const ids: string[] = []
  let path: string | null = '/sites?search=*&$select=id'
  let pages = 0
  while (path && pages < MAX_SITE_PAGES && ids.length < MAX_SITES) {
    const result = (await graphFetch(ownerId, path, { scopes: SHAREPOINT_SCOPES })) as GraphPage
    pages += 1
    for (const row of result.value ?? []) {
      const id = (row as { id?: unknown }).id
      if (typeof id === 'string') ids.push(id)
    }
    path = typeof result['@odata.nextLink'] === 'string' ? result['@odata.nextLink'] : null
  }
  return { ids: ids.slice(0, MAX_SITES), truncated: path != null || ids.length > MAX_SITES }
}

/** Document-library drive ids for one site. */
async function fetchDriveIds(ownerId: string, siteId: string): Promise<string[]> {
  const raw = (await graphFetch(ownerId, `/sites/${siteId}/drives?$select=id`, {
    scopes: SHAREPOINT_SCOPES,
  })) as GraphPage
  const ids = (raw.value ?? [])
    .map((row) => (row as { id?: unknown }).id)
    .filter((id): id is string => typeof id === 'string')
  return ids.slice(0, MAX_DRIVES_PER_SITE)
}

/** `parentReference.path` → segment count under the drive root. Only the
 *  count survives; the path string itself is discarded in the same
 *  expression, never assigned to a variable that could outlive it. */
function folderDepthFromPath(raw: unknown): number {
  if (typeof raw !== 'string') return 0
  const marker = raw.indexOf('root:')
  const rel = (marker >= 0 ? raw.slice(marker + 'root:'.length) : raw).replace(/^\/+/, '')
  return rel.length === 0 ? 0 : rel.split('/').filter(Boolean).length
}

/** One Graph identity object (`createdBy`/`lastModifiedBy`) resolved against
 *  the roster, or `null` when it matches no `Member`. */
function resolveActor(
  identity: unknown,
  byEntraId: ReadonlySet<string>,
  byMail: ReadonlyMap<string, string>,
): string | null {
  const user = (identity as { user?: Record<string, unknown> } | undefined)?.user
  if (!user) return null
  const id = typeof user.id === 'string' ? user.id : null
  if (id && byEntraId.has(id)) return id
  const email = typeof user.email === 'string' ? user.email.toLowerCase() : null
  return email ? (byMail.get(email) ?? null) : null
}

/** Every driveItem in one drive, reduced to {@link DriveItemRecord} —
 *  identities resolved inline so no raw Graph identity payload (which can
 *  carry a display name) is ever held past this loop iteration. */
async function fetchDriveItems(
  ownerId: string,
  siteId: string,
  driveId: string,
  byEntraId: ReadonlySet<string>,
  byMail: ReadonlyMap<string, string>,
): Promise<{ items: DriveItemRecord[]; scanned: number; truncated: boolean }> {
  const items: DriveItemRecord[] = []
  let scanned = 0
  const { truncated } = await paginate(
    ownerId,
    `/drives/${driveId}/root/delta?$select=${DELTA_SELECT}`,
    MAX_PAGES_PER_DRIVE,
    (rows) => {
      for (const row of rows) {
        const it = row as Record<string, unknown>
        if (!it.file) continue // folders and deleted markers carry no file facet
        scanned += 1
        const parent = (it.parentReference ?? {}) as Record<string, unknown>
        const modified =
          typeof it.lastModifiedDateTime === 'string' ? it.lastModifiedDateTime : null
        if (!modified) continue
        items.push({
          siteId,
          folderId: typeof parent.id === 'string' ? parent.id : `root:${driveId}`,
          folderDepth: folderDepthFromPath(parent.path),
          lastModifiedDateTime: modified,
          createdByEntraId: resolveActor(it.createdBy, byEntraId, byMail),
          lastModifiedByEntraId: resolveActor(it.lastModifiedBy, byEntraId, byMail),
        })
      }
    },
  )
  return { items, scanned, truncated }
}

// ============================================================================
// Roster identity index
// ============================================================================

async function fetchRosterIdentities(): Promise<{
  byEntraId: Set<string>
  byMail: Map<string, string>
}> {
  const session = getNeo4jDriver().session({ defaultAccessMode: neo4j.session.READ })
  try {
    const result = await session.run(`MATCH (m:Member) RETURN m.entraId AS entraId, m.mail AS mail`)
    const byEntraId = new Set<string>()
    const byMail = new Map<string, string>()
    for (const record of result.records) {
      const entraId = String(record.get('entraId'))
      byEntraId.add(entraId)
      const mail = record.get('mail')
      if (typeof mail === 'string' && mail.trim()) byMail.set(mail.toLowerCase(), entraId)
    }
    return { byEntraId, byMail }
  } finally {
    await session.close()
  }
}

// ============================================================================
// Neo4j writes — delete-by-provenance, re-derive; scoped to COLLABORATES_WITH
// only, never the blanket `inferred: true` delete phase 1 uses (that module's
// own header explains why its delete is blanket-by-type; this lane must not
// clear phase 1's MEMBER_OF groupings, so it deletes its own type only)
// ============================================================================

async function clearCollaborationEdges(): Promise<number> {
  const session = getNeo4jDriver().session({ defaultAccessMode: neo4j.session.WRITE })
  try {
    const result = await session.run(
      `MATCH ()-[r:COLLABORATES_WITH]->() WHERE r.inferred = true DELETE r RETURN count(r) AS cleared`,
    )
    return toCount(result.records[0]?.get('cleared'))
  } finally {
    await session.close()
  }
}

async function writeCollaborationEdges(rows: readonly PairEvidence[]): Promise<number> {
  if (rows.length === 0) return 0
  const session = getNeo4jDriver().session({ defaultAccessMode: neo4j.session.WRITE })
  try {
    const result = await session.run(
      `UNWIND $rows AS row
       MATCH (a:Member {entraId: row.aEntraId})
       MATCH (b:Member {entraId: row.bEntraId})
       MERGE (a)-[r:COLLABORATES_WITH]->(b)
       SET r.inferred = true,
           r.basis = $basis,
           r.confidence = row.confidence,
           r.evidenceCount = row.evidenceCount,
           r.siteCount = row.siteCount,
           r.recencyBucket = row.recencyBucket,
           r.inferredAt = datetime()
       RETURN count(r) AS written`,
      { rows, basis: COACTIVITY_BASIS },
    )
    return toCount(result.records[0]?.get('written'))
  } finally {
    await session.close()
  }
}

function toCount(value: unknown): number {
  if (typeof value === 'number') return value
  if (neo4j.isInt(value)) return value.toNumber()
  return Number(value ?? 0)
}

// ============================================================================
// Entry point
// ============================================================================

/**
 * Enumerate the SharePoint sites/drives the owner's delegated token can see,
 * extract co-work evidence from drive-item metadata, and write it as
 * `COLLABORATES_WITH` edges. Safe to run repeatedly: every run clears its own
 * prior output before re-deriving.
 *
 * A {@link GraphAuthRequiredError} propagates rather than being caught — the
 * caller (the CLI script) is expected to surface it verbatim, because "sign
 * in again" is the only correct next step and swallowing it would silently
 * report zero evidence instead.
 */
export async function runSharePointCoactivityEnrichment(
  ownerEmail: string,
  now: Date,
): Promise<SharePointEnrichmentReport> {
  await ensureOrgGraphSchema()
  const ownerId = await resolveOwnerUserId(ownerEmail)
  const roster = await fetchRosterIdentities()

  const { ids: siteIds, truncated: sitesTruncated } = await fetchSiteIds(ownerId)

  const allItems: DriveItemRecord[] = []
  let itemsScanned = 0
  let drivesCovered = 0
  let drivesTruncated = false

  for (const siteId of siteIds) {
    const driveIds = await fetchDriveIds(ownerId, siteId)
    for (const driveId of driveIds) {
      const { items, scanned, truncated } = await fetchDriveItems(
        ownerId,
        siteId,
        driveId,
        roster.byEntraId,
        roster.byMail,
      )
      drivesCovered += 1
      itemsScanned += scanned
      if (truncated) drivesTruncated = true
      allItems.push(...items)
    }
  }

  const itemsWithResolvedIdentity = allItems.filter(
    (it) => it.createdByEntraId != null || it.lastModifiedByEntraId != null,
  ).length

  const pairs = extractCoworkPairs(allItems, now)

  const edgesCleared = await clearCollaborationEdges()
  const pairsWritten = await writeCollaborationEdges(pairs)

  return {
    sitesCovered: siteIds.length,
    sitesTruncated,
    drivesCovered,
    drivesTruncated,
    itemsScanned,
    itemsWithResolvedIdentity,
    edgesCleared,
    pairsWritten,
    confidenceDistribution: tallyConfidenceBuckets(pairs),
  }
}

export { GraphAuthRequiredError }
