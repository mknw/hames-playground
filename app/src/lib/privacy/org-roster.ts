/**
 * The directory as a pseudonymisation roster — pure, no NER, no model, no I/O.
 *
 * `graph-roster.ts` harvests who is in a payload from the payload's own
 * labelled fields, which is why its own header calls out the limitation:
 *
 * > A person who appears only in prose and never in a labelled field is
 * > invisible to this module by design.
 *
 * That limitation exists because the payload was the only roster available. It
 * is not any more: the organisational graph holds the tenant's member roster
 * (`lib/org-graph/`), and this module turns it into the same
 * {@link RosterEntry} shape `buildTable` already consumes. **That type is the
 * seam** — nothing in `pseudonymise.ts` changes, and nothing here knows where
 * the records came from.
 *
 * ## What this closes, and what it does not
 * - **Closes limitation 1 for colleagues** (plan doc: "a person named only in
 *   free text is not replaced"). A colleague named in a body, a subject or a
 *   file name is now a known literal even when no labelled field declares them.
 *   It closes it for *directory members only*: a customer, a supplier or a
 *   private individual named in prose is still invisible, and always will be
 *   under a roster mechanism.
 * - **Closes limitation 3** (the app's own projections cost the roster
 *   information: `shapeMessages` flattens a sender to `name ?? address`, so a
 *   payload learns one half of an identity). {@link mergeRosters} supplies the
 *   other half from the directory — see its `fill` step.
 * - **Does not decide where the substitution runs.** This is a mapping source,
 *   not a hook. Where `apply` is called, whether the store holds clear or
 *   pseudonymised text, and where the (personal-data) table lives are the three
 *   open questions in `docs/plan/graph-pseudonymisation.md`, and they are owner
 *   decisions. Nothing here calls `apply`.
 *
 * ## The cost of a wide roster, stated rather than hidden
 * Passing the whole directory makes the substitution table O(directory) instead
 * of O(payload): ~6 literals per person, so a few hundred needles in one
 * alternation regex. That is cheap to *match* — one pass, longest-first — but it
 * has two real consequences a caller must know:
 *
 *  1. **The table over-claims as an audit record.** `buildTable` mints an entry
 *     per person whether or not that person occurs in the payload, and `apply`
 *     does not report which literals fired. So a 49-entry table proves what the
 *     substitution *could* have replaced, not what it did. The fix is `apply`
 *     returning a replacement count; that changes a public signature in a
 *     sensitive area and is deliberately not done here.
 *  2. **Placeholder numbering is roster-positional.** With a directory-derived
 *     roster the numbering is stable across payloads for as long as the roster
 *     order is — which is a property of the caller's query, not of this module.
 *     Anything that relies on stability (reversing one payload's table against
 *     another's output) must state where the order comes from.
 */
import type { RosterEntry } from './graph-roster'

/**
 * The subset of a directory member this module needs.
 *
 * Structurally typed on purpose: `lib/privacy/` stays free of any dependency on
 * `lib/org-graph/`, so the pure layer keeps compiling — and keeps being
 * testable — with no graph, no driver and no tenant. `org-graph`'s own
 * `MemberRecord` satisfies it without either module importing the other.
 */
export interface DirectoryPerson {
  displayName: string
  mail: string
}

/** The role recorded on directory-derived entries, so a table can be read back
 *  and the provenance of each identity named. `graph-roster.ts` uses the
 *  payload field name for this; 'directory' is the same idea for a roster that
 *  came from outside the payload. */
export const DIRECTORY_ROLE = 'directory'

const clean = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : null

/**
 * Turn directory members into roster entries, in the order given.
 *
 * Only `displayName` and `mail` are read. Deriving the given/family parts and
 * the address's local part and URL slug is `buildTable`'s job and already
 * works from these two fields, so pulling `givenName`/`surname` out of Graph
 * would add personal data to the graph for no coverage gain.
 *
 * A person with neither a usable name nor a usable address is dropped: an empty
 * roster entry contributes no needles and would only pad the table.
 * Deduplication is by address, case-insensitively, matching
 * `extractRoster`'s rule so the two sources dedupe the same way.
 */
export function rosterFromDirectory(people: readonly Partial<DirectoryPerson>[]): RosterEntry[] {
  const entries: RosterEntry[] = []
  const byAddress = new Map<string, RosterEntry>()

  for (const person of people) {
    const name = clean(person.displayName)
    const address = clean(person.mail)
    if (!name && !address) continue

    const key = address?.toLowerCase()
    const existing = key ? byAddress.get(key) : undefined
    if (existing) {
      if (name && !existing.nameVariants.some((v) => equalsFold(v, name))) {
        existing.nameVariants.push(name)
        existing.name ??= name
      }
      continue
    }

    const entry: RosterEntry = {
      name,
      address,
      nameVariants: name ? [name] : [],
      roles: [DIRECTORY_ROLE],
    }
    if (key) byAddress.set(key, entry)
    entries.push(entry)
  }

  return entries
}

const equalsFold = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/**
 * Merge a secondary roster into a primary one.
 *
 * `primary` keeps its order and its numbering, because that is what a caller
 * pseudonymising a payload cares about: the people the payload actually names
 * stay `PERSON_1`, `PERSON_2`, … and the directory's contribution lands behind
 * them. Three things happen per secondary entry:
 *
 *  - **match** — by address (case-insensitively) or by a shared name variant,
 *    the same two rules `extractRoster` uses to dedupe within one payload;
 *  - **fill** — a matched primary entry with a null `name` or `address` takes
 *    the secondary's, which is the whole of the limitation-3 fix: a payload that
 *    only ever saw `jan@…` learns the display name that its body text uses;
 *  - **append** — an unmatched secondary entry is added at the end, which is
 *    the whole of the limitation-1 fix for colleagues.
 *
 * Neither input is mutated: entries are cloned before any field is touched, so
 * a caller can hold a directory roster across payloads without it accumulating
 * one payload's variants and roles.
 */
export function mergeRosters(
  primary: readonly RosterEntry[],
  secondary: readonly RosterEntry[],
): RosterEntry[] {
  const merged = primary.map(clone)

  for (const candidate of secondary) {
    const match = merged.find((entry) => sameIdentity(entry, candidate))
    if (!match) {
      merged.push(clone(candidate))
      continue
    }
    match.name ??= candidate.name
    match.address ??= candidate.address
    for (const variant of candidate.nameVariants) {
      if (!match.nameVariants.some((v) => equalsFold(v, variant))) match.nameVariants.push(variant)
    }
    // A filled-in name that was not among the variants is still a literal worth
    // replacing, so it joins them rather than sitting only on `name`.
    if (match.name && !match.nameVariants.some((v) => equalsFold(v, match.name as string))) {
      match.nameVariants.unshift(match.name)
    }
    for (const role of candidate.roles) {
      if (!match.roles.includes(role)) match.roles.push(role)
    }
  }

  return merged
}

const clone = (entry: RosterEntry): RosterEntry => ({
  name: entry.name,
  address: entry.address,
  nameVariants: [...entry.nameVariants],
  roles: [...entry.roles],
})

/**
 * Same person? Addresses decide when both have one — two different addresses
 * are two people even if the display name matches, which is the safe reading
 * for namesakes. Otherwise a shared name variant is taken as identity, which is
 * the conflating direction and matches `extractRoster`'s own name-only merge.
 */
function sameIdentity(a: RosterEntry, b: RosterEntry): boolean {
  if (a.address && b.address) return equalsFold(a.address, b.address)
  return a.nameVariants.some((v) => b.nameVariants.some((w) => equalsFold(v, w)))
}
