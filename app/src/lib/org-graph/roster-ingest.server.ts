/**
 * Directory roster ingest — Server Only.
 *
 * Reads the tenant's member roster from Microsoft Graph with the **app-only**
 * credential (`auth/graph-token.server.ts` → `graphAppFetch`) and upserts it as
 * `Member` nodes. This is the one read in the app that cannot be delegated: the
 * roster is the whole tenant, so there is no user whose per-user view of it
 * would be the right one.
 *
 * Not a `'use server'` module — see the header of `schema.server.ts` for why
 * (SD-13). Entry points are the CLI scripts under `scripts/`.
 *
 * ## What leaves this module
 * `MemberRecord`s (personal data) go to Neo4j. Everything **returned** to a
 * caller is an {@link IngestReport}: counts, property names and reason codes,
 * never a name or an address. That is deliberate — the report is what gets
 * printed to a terminal, pasted into a PR and read by a coordinator, and a
 * report that carries identities is a report you cannot show anyone.
 *
 * ## Idempotence, and the thing it is not
 * Every write is a `MERGE` on the ontology's unique key, so running the ingest
 * twice changes nothing but `syncedAt`. It is an **upsert, not a sync**: a
 * member who has left the tenant is not deleted, because "what happens to a
 * departed employee's node" is a retention decision (SD-11 — the graph is not
 * covered by any erasure path today) and not one an ingest should make
 * silently. The report counts them as `stale` so the decision is visible.
 */
import neo4j from 'neo4j-driver'
import { assertServerOnImport } from '../harness-patterns/assert.server'
import { getNeo4jDriver } from '../neo4j/client'
import { graphAppFetch, GraphAppPermissionError } from '../auth/graph-token.server'
import { ensureOrgGraphSchema } from './schema.server'
import { validateMember, type MemberRecord, type Violation } from './ontology'

assertServerOnImport()

/**
 * Server-side `$filter` for the directory read.
 *
 * - `accountEnabled eq true` drops deactivated accounts.
 * - `userType eq 'Member'` drops guests (B2B invitees from other tenants), who
 *   are people but not *this* organisation's structure.
 *
 * Both are filterable on `/users` without `ConsistencyLevel: eventual`, so this
 * stays one ordinary paged read. What it cannot express is "is a person rather
 * than a service or a room": Graph has no such flag on `/users`. The app-side
 * `mail` requirement below is the practical proxy — see {@link fetchDirectoryMembers}.
 */
export const DIRECTORY_FILTER = "accountEnabled eq true and userType eq 'Member'"

/** The five ontology properties plus the two the filter is expressed over.
 *  `$select` is not an optimisation here: without it Graph returns the full
 *  user resource, which is far more personal data than this graph holds. */
export const DIRECTORY_SELECT = 'id,displayName,mail,department,jobTitle,accountEnabled,userType'

/** Graph's maximum page size for `/users`. */
const PAGE_SIZE = 999

/** A page of a Graph collection. */
interface GraphPage {
  value?: unknown[]
  '@odata.nextLink'?: string
}

/** Raw `/users` row, before validation. */
interface RawUser {
  id?: unknown
  displayName?: unknown
  mail?: unknown
  department?: unknown
  jobTitle?: unknown
}

/** Counts keyed by a property or reason name. Never holds an identity. */
export type CountsByReason = Record<string, number>

export interface IngestReport {
  /** Rows Graph returned after the server-side filter. */
  fetched: number
  /** Rows that passed hard validation and were written. */
  written: number
  /** Rows dropped for a hard violation. `fetched === written + rejectedRows`. */
  rejectedRows: number
  /** Hard violations, by property. One rejected row can appear under two
   *  properties, so these do NOT sum to `rejectedRows` — that is the point of
   *  keeping both numbers. */
  rejected: CountsByReason
  /** Soft violations, by property — these rows were written incomplete. */
  incomplete: CountsByReason
  /** Pages the paged read walked. */
  pages: number
  /** `Member` nodes older than this run, i.e. not seen in the directory. */
  stale: number
  /** Team/membership outcome; see {@link MembershipReport}. */
  memberships: MembershipReport
}

export interface MembershipReport {
  /** Whether group reads were attempted at all. */
  attempted: boolean
  /** Why not, or why they produced nothing. Empty when edges were written. */
  blockedReason: string | null
  /** `Team` nodes written. */
  teams: number
  /** `MEMBER_OF` edges written. */
  edges: number
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : null

const bump = (counts: CountsByReason, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1
}

/**
 * Walk `/users` and return the rows that satisfy the ontology's hard
 * properties, plus the violation tallies.
 *
 * Two exclusions happen here rather than in `$filter`, because Graph cannot
 * express either:
 *
 * - **No `mail`.** A user object with no primary SMTP address is not somebody
 *   this graph can be about: `mail` is a hard property, it is the join key the
 *   pseudonymisation roster needs, and in practice unlicensed service
 *   principals-as-users and never-provisioned accounts are exactly the rows
 *   that lack it. This is a proxy, not a classification — a *licensed* service
 *   account with a mailbox still gets through, and there is no Graph field that
 *   would separate it from a person. Named as a limitation in
 *   `docs/org-graph.md` rather than papered over with a name heuristic.
 * - **Room and equipment mailboxes.** These are `/places` resources. Where the
 *   tenant also materialises them as user objects they are normally
 *   `accountEnabled: false` and dropped by the filter; a licensed, enabled one
 *   would survive. Cross-checking `/places` needs `Place.Read.All`, which this
 *   app registration does not have.
 */
export async function fetchDirectoryMembers(): Promise<{
  members: MemberRecord[]
  fetched: number
  pages: number
  rejectedRows: number
  rejected: CountsByReason
  incomplete: CountsByReason
}> {
  const members: MemberRecord[] = []
  const rejected: CountsByReason = {}
  const incomplete: CountsByReason = {}
  let fetched = 0
  let pages = 0
  let rejectedRows = 0

  let path: string | null =
    `/users?$select=${DIRECTORY_SELECT}` +
    `&$filter=${encodeURIComponent(DIRECTORY_FILTER)}` +
    `&$top=${PAGE_SIZE}`

  while (path) {
    const page = (await graphAppFetch(path)) as GraphPage
    pages += 1
    for (const row of page.value ?? []) {
      fetched += 1
      const candidate = toCandidate(row as RawUser)
      const { ok, violations } = validateMember(candidate)
      tally(violations, ok ? incomplete : rejected, ok)
      if (ok) members.push(candidate as MemberRecord)
      else rejectedRows += 1
    }
    // `@odata.nextLink` is an absolute URL and carries its own skip token;
    // `graphAppFetch` passes an absolute path through unchanged.
    path = str(page['@odata.nextLink'])
  }

  return { members, fetched, pages, rejectedRows, rejected, incomplete }
}

function toCandidate(row: RawUser): Partial<MemberRecord> {
  return {
    entraId: str(row.id) ?? undefined,
    displayName: str(row.displayName) ?? undefined,
    mail: str(row.mail) ?? undefined,
    department: str(row.department),
    jobTitle: str(row.jobTitle),
  }
}

/**
 * Record violations, by property. A rejected row's soft violations are NOT also
 * counted as incomplete: it was never written, so "written incomplete" would be
 * false of it. Row arithmetic is `rejectedRows`, not the sum of these tallies —
 * one row missing both `displayName` and `mail` appears twice here.
 */
function tally(violations: Violation[], counts: CountsByReason, ok: boolean): void {
  for (const v of violations) {
    if (ok ? v.tier === 'soft' : v.tier === 'hard') bump(counts, v.property)
  }
}

/**
 * Upsert members and return how many rows were written.
 *
 * One `UNWIND` + `MERGE` in a single transaction: the whole roster is a few
 * dozen rows, and a per-row round trip would be slower and non-atomic for no
 * gain. `syncedAt` is stamped with `datetime()`, so it is on the **database**
 * clock; {@link databaseNow} is what keeps the staleness threshold on that same
 * clock. Stamping here and thresholding from `new Date()` compares two clocks
 * and is the bug that reading is meant to prevent — not, as this comment used
 * to claim, a defence against drift that `datetime()` provides on its own.
 */
export async function upsertMembers(members: MemberRecord[]): Promise<number> {
  if (members.length === 0) return 0
  const session = getNeo4jDriver().session({ defaultAccessMode: neo4j.session.WRITE })
  try {
    const result = await session.run(
      `UNWIND $rows AS row
       MERGE (m:Member {entraId: row.entraId})
       SET m.displayName = row.displayName,
           m.mail        = row.mail,
           m.department  = row.department,
           m.jobTitle    = row.jobTitle,
           m.syncedAt    = datetime()
       RETURN count(m) AS written`,
      { rows: members },
    )
    return toCount(result.records[0]?.get('written'))
  } finally {
    await session.close()
  }
}

/**
 * The database's own clock, as the ISO string `datetime()` renders.
 *
 * One round trip, and the only reason it exists: `syncedAt` is stamped by the
 * server, so a threshold compared against it has to come from the server too.
 * Taking it from `new Date()` in this process compares the app container's
 * clock to the database container's, and the skew is not hypothetical — a
 * database clock running behind the host by more than the directory fetch
 * takes makes **every member just written** count as stale.
 *
 * It stays a string rather than becoming a `Date`: `datetime()` renders
 * nanoseconds, `Date` holds milliseconds, and the round trip through a JS
 * `Date` would round the threshold — possibly *forwards*, which is the one
 * direction that reintroduces the false positive. Cypher parses it back with
 * full fidelity on the other side.
 *
 * **Fails closed.** A clock that cannot be read throws rather than falling back
 * to `new Date()`: the fallback would be the defect, silently, on exactly the
 * runs where something is already wrong.
 */
export async function databaseNow(): Promise<string> {
  const session = getNeo4jDriver().session({ defaultAccessMode: neo4j.session.READ })
  try {
    const result = await session.run('RETURN toString(datetime()) AS now')
    const now = result.records[0]?.get('now')
    if (typeof now !== 'string' || now === '') {
      throw new Error('could not read the database clock: datetime() returned no value')
    }
    return now
  } finally {
    await session.close()
  }
}

/**
 * `Member` nodes whose `syncedAt` is older than `since` — people the directory
 * no longer returns, or who never had a `syncedAt` at all.
 *
 * `since` is a database timestamp from {@link databaseNow}, never a value this
 * process minted. Counted, not deleted — see the module header.
 */
export async function countStaleMembers(since: string): Promise<number> {
  const session = getNeo4jDriver().session({ defaultAccessMode: neo4j.session.READ })
  try {
    const result = await session.run(
      `MATCH (m:Member)
       WHERE m.syncedAt IS NULL OR m.syncedAt < datetime($since)
       RETURN count(m) AS stale`,
      { since },
    )
    return toCount(result.records[0]?.get('stale'))
  } finally {
    await session.close()
  }
}

// ============================================================================
// Teams — implemented, and blocked on a tenant permission
// ============================================================================

/**
 * Can this credential read group objects?
 *
 * One request, and it is decisive. `User.Read.All` alone is enough to *list* a
 * user's `memberOf` — the ids come back — but every group property is withheld:
 * `displayName` is absent and `groupTypes` / `mailEnabled` / `securityEnabled`
 * are null, while `/groups` answers **403 Authorization_RequestDenied**. A
 * `Team` node whose `name` is unknowable violates the ontology's hard
 * properties, so id-only memberships are worse than none: they would fill the
 * graph with opaque GUIDs that no query could ever resolve.
 *
 * Hence the probe rather than an attempt-and-degrade: the failure is a stable
 * property of the app registration, not a transient error, and one request
 * answers it before N per-user requests are spent.
 */
export async function probeGroupReadAccess(): Promise<{ ok: boolean; reason: string | null }> {
  try {
    const page = (await graphAppFetch('/groups?$select=id,displayName&$top=1')) as GraphPage
    const first = (page.value ?? [])[0] as { displayName?: unknown } | undefined
    if (page.value && page.value.length > 0 && !str(first?.displayName)) {
      return {
        ok: false,
        reason:
          'group objects come back without displayName — the credential can see that groups exist but not what they are',
      }
    }
    return { ok: true, reason: null }
  } catch (err) {
    if (err instanceof GraphAppPermissionError) {
      return {
        ok: false,
        reason: `Graph denied /groups (${err.status}) — the app registration lacks Group.Read.All (application)`,
      }
    }
    throw err
  }
}

/** One group, as the ontology's `Team` needs it. */
interface TeamRow {
  entraId: string
  name: string
}

/**
 * Fetch each member's groups and write `Team` nodes + `MEMBER_OF` edges.
 *
 * Cost is one request per member (`/users/{id}/memberOf/microsoft.graph.group`),
 * which is the cheap shape only because this directory is a few dozen people;
 * the OData cast is what keeps directory roles and administrative units out of
 * the result. Runs only when {@link probeGroupReadAccess} says the credential
 * can actually name a group.
 */
export async function ingestMemberships(members: MemberRecord[]): Promise<MembershipReport> {
  const probe = await probeGroupReadAccess()
  if (!probe.ok) {
    return { attempted: false, blockedReason: probe.reason, teams: 0, edges: 0 }
  }

  const teams = new Map<string, TeamRow>()
  const edges: { memberId: string; teamId: string }[] = []

  for (const member of members) {
    const page = (await graphAppFetch(
      `/users/${encodeURIComponent(member.entraId)}/memberOf/microsoft.graph.group` +
        `?$select=id,displayName&$top=${PAGE_SIZE}`,
    )) as GraphPage
    for (const row of page.value ?? []) {
      const group = row as { id?: unknown; displayName?: unknown }
      const entraId = str(group.id)
      const name = str(group.displayName)
      // A group whose name is withheld cannot satisfy Team's hard properties.
      if (!entraId || !name) continue
      teams.set(entraId, { entraId, name })
      edges.push({ memberId: member.entraId, teamId: entraId })
    }
  }

  if (teams.size === 0) {
    return {
      attempted: true,
      blockedReason: 'no named groups returned for any member',
      teams: 0,
      edges: 0,
    }
  }

  const session = getNeo4jDriver().session({ defaultAccessMode: neo4j.session.WRITE })
  try {
    await session.run(
      `UNWIND $rows AS row
       MERGE (t:Team {entraId: row.entraId})
       SET t.name = row.name, t.syncedAt = datetime()`,
      { rows: [...teams.values()] },
    )
    const linked = await session.run(
      `UNWIND $rows AS row
       MATCH (m:Member {entraId: row.memberId})
       MATCH (t:Team {entraId: row.teamId})
       MERGE (m)-[:MEMBER_OF]->(t)
       RETURN count(*) AS edges`,
      { rows: edges },
    )
    return {
      attempted: true,
      blockedReason: null,
      teams: teams.size,
      edges: toCount(linked.records[0]?.get('edges')),
    }
  } finally {
    await session.close()
  }
}

// ============================================================================
// The whole thing
// ============================================================================

export interface IngestOptions {
  /** Attempt the per-member group reads. Default true; the probe still gates
   *  whether any request is actually spent. */
  includeMemberships?: boolean
}

/**
 * Apply the schema, read the directory, upsert it. Returns counts only.
 *
 * The schema apply comes first and is not optional: writing members into a
 * graph without the uniqueness constraints would let a re-run with a changed
 * `mail` silently produce two nodes for one person, and the constraint is the
 * only part of the ontology the database itself holds.
 */
export async function ingestRoster(options: IngestOptions = {}): Promise<IngestReport> {
  await ensureOrgGraphSchema()

  // Taken before the write, and from the database, so a member written by this
  // run can never count as stale: its `syncedAt` comes from the same clock and
  // is necessarily later.
  const startedAt = await databaseNow()

  const { members, fetched, pages, rejectedRows, rejected, incomplete } =
    await fetchDirectoryMembers()
  const written = await upsertMembers(members)
  const memberships =
    options.includeMemberships === false
      ? { attempted: false, blockedReason: 'disabled by caller', teams: 0, edges: 0 }
      : await ingestMemberships(members)
  const stale = await countStaleMembers(startedAt)

  return { fetched, written, rejectedRows, rejected, incomplete, pages, stale, memberships }
}

function toCount(value: unknown): number {
  if (typeof value === 'number') return value
  if (neo4j.isInt(value)) return value.toNumber()
  return Number(value ?? 0)
}
