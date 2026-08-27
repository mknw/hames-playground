/**
 * Org-graph edge inference — pure, I/O-free, the other half of
 * `enrich-org-edges.server.ts`.
 *
 * Mirrors the `ontology.ts` / `schema.server.ts` split: the judgement calls —
 * what counts as a shared-mailbox account, how a job title becomes a team key,
 * what confidence an inferred edge carries — live here where they can be unit
 * tested against synthetic fixtures with no database and no Graph credential.
 * The `.server.ts` module only fetches rows and issues the writes these
 * functions describe.
 *
 * ## Why job titles and departments become `Team` nodes, not a new label
 * The ontology's `Team` doc comment calls it "a named group people belong to
 * (an Entra group)". A role or department grouping inferred from directory
 * text has no Entra group behind it, so this is a genuine widening of what a
 * `Team` node can mean — flagged here rather than silently reused. The
 * alternative (a new node label) would need its own uniqueness constraint and
 * its own entry in `NODE_LABELS`/`LABEL_SPECS` for a shape that is otherwise
 * identical to `Team`; reusing the label and marking the instance
 * (`inferred: true`) was judged the smaller change. Every inferred `Team`'s
 * `entraId` carries a `role:` or `dept:` prefix specifically so it can never
 * collide with a real Entra group id (a GUID, which never contains `:`), and
 * so `SHOW`-style graph queries can distinguish the two at a glance.
 *
 * ## Why no new relation type
 * `MEMBER_OF` already expresses "this member belongs to this team", which is
 * exactly the shape a role or department grouping needs — pointing at an
 * inferred `Team` rather than a real one is the only difference, and that is
 * carried entirely by the `inferred`/`basis`/`confidence` properties on the
 * `Team` node and the edge. No relation here ever joins two `Member` nodes:
 * that structural rule (`ontology.test.ts`, "declares no relation expressing
 * authority over a person") is a standing decision this module does not
 * revisit.
 */

/** The five fields `Member` carries that this module's inference reads. */
export interface MemberFields {
  entraId: string
  displayName: string
  mail: string
  jobTitle: string | null
  department: string | null
}

/** One inferred `(:Member)-[:MEMBER_OF]->(:Team)` edge, before it is written. */
export interface GroupEdge {
  memberId: string
  teamKey: string
  teamName: string
  basis: string
  confidence: number
}

const filled = (v: string | null | undefined): v is string =>
  typeof v === 'string' && v.trim().length > 0

// ============================================================================
// Basis + confidence — one constant per inference method, so a report can
// name the method without re-deriving it, and so the number is set once.
// ============================================================================

/** A member whose account shape (no title, no department, an undotted mail
 *  local-part) looks like a shared mailbox rather than a person. */
export const RESOURCE_BASIS = 'account-shape'
/** Members sharing a directory `jobTitle` value. */
export const JOB_TITLE_BASIS = 'job-title'
/** Members sharing a directory `department` value. */
export const DEPARTMENT_BASIS = 'department'

/**
 * Confidence values, as a plain fact rather than a computed score — there is
 * exactly one signal behind each basis, so a formula would only dress up the
 * same three numbers. Job title and department are read directly off a
 * directory field the tenant maintains, so both are higher than the
 * account-shape heuristic, which infers structure the directory does not
 * state at all. Department outranks job title because two people who share a
 * title are not always on the same effort (many `Project Manager`s run
 * unrelated projects), while a shared department is a stronger organisational
 * claim on this small a roster.
 */
export const RESOURCE_CONFIDENCE = 0.7
export const JOB_TITLE_CONFIDENCE = 0.8
export const DEPARTMENT_CONFIDENCE = 0.9

// ============================================================================
// Resource-account detection
// ============================================================================

/**
 * Does this member's account look like a shared mailbox rather than a person?
 *
 * Two independent signals, both required:
 *
 * 1. **No job title and no department.** A real employee with either field
 *    filled is never flagged, however the mail address is shaped — this is
 *    the guard against a false positive on a real person whose account
 *    happens to use an initials-style address (this tenant has exactly that
 *    pattern for at least one titled person, which is why signal 2 alone is
 *    not enough).
 * 2. **An undotted mail local-part.** On this directory, every personal
 *    account with no job title still follows `firstname.lastname@…` (a dot
 *    joins two name-like segments); every shared/service account observed —
 *    a product name, a distribution alias, a resource mailbox — does not.
 *    That is a property of *this* tenant's naming convention, not a law of
 *    mail addresses in general, so it is scoped to signal 1's candidate pool
 *    rather than applied to the whole roster.
 *
 * A moderate confidence ({@link RESOURCE_CONFIDENCE}) reflects that this is a
 * heuristic over account shape, not a directory fact: a brand-new hire with
 * no title yet and an initials-only address would also match.
 */
export function looksLikeResourceAccount(
  member: Pick<MemberFields, 'mail' | 'jobTitle' | 'department'>,
): boolean {
  if (filled(member.jobTitle) || filled(member.department)) return false
  const local = member.mail.split('@')[0] ?? ''
  return local.length > 0 && !local.includes('.')
}

// ============================================================================
// Slugging — turns free text into a deterministic, ASCII, MERGE-safe key
// ============================================================================

/**
 * `"Some  Role!"` → `"some-role"`. Lower-cased, every run of non-alphanumeric
 * characters collapsed to one hyphen, leading/trailing hyphens trimmed.
 * Deterministic so the same title always MERGEs onto the same `Team` node,
 * which is the whole idempotence guarantee for the grouping step: re-running
 * this module never depends on what ran before it, only on the directory's
 * current values.
 */
export function slugifyLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** The synthetic `Team.entraId` a job-title grouping MERGEs onto. The `role:`
 *  prefix can never collide with a real Entra group id (a GUID). */
export const roleTeamKey = (jobTitle: string): string => `role:${slugifyLabel(jobTitle)}`

/** The synthetic `Team.entraId` a department grouping MERGEs onto. */
export const departmentTeamKey = (department: string): string => `dept:${slugifyLabel(department)}`

// ============================================================================
// Building the edge rows
// ============================================================================

/** One `MEMBER_OF` row per member with a `jobTitle`, grouped onto a `Team`
 *  keyed by {@link roleTeamKey}. Members sharing a title MERGE onto the same
 *  node; this returns one row per member, not one per group. */
export function buildRoleGroupEdges(members: readonly MemberFields[]): GroupEdge[] {
  return members
    .filter((m) => filled(m.jobTitle))
    .map((m) => ({
      memberId: m.entraId,
      teamKey: roleTeamKey(m.jobTitle as string),
      teamName: (m.jobTitle as string).trim(),
      basis: JOB_TITLE_BASIS,
      confidence: JOB_TITLE_CONFIDENCE,
    }))
}

/** Same shape as {@link buildRoleGroupEdges}, over `department`. */
export function buildDepartmentGroupEdges(members: readonly MemberFields[]): GroupEdge[] {
  return members
    .filter((m) => filled(m.department))
    .map((m) => ({
      memberId: m.entraId,
      teamKey: departmentTeamKey(m.department as string),
      teamName: (m.department as string).trim(),
      basis: DEPARTMENT_BASIS,
      confidence: DEPARTMENT_CONFIDENCE,
    }))
}

/** Edge count by confidence value — the shape a PR can report without naming
 *  a single title or department. */
export function tallyConfidence(rows: readonly { confidence: number }[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const row of rows) {
    const key = String(row.confidence)
    out[key] = (out[key] ?? 0) + 1
  }
  return out
}
