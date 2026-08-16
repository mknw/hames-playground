/**
 * Graph-roster extraction — pure, no NER, no model, no I/O.
 *
 * Microsoft Graph payloads carry their own identity roster in structured,
 * labelled fields (`from.emailAddress`, `toRecipients[].emailAddress`,
 * `organizer`, `attendees[]`, `createdBy.user`, `lastModifiedBy.user`, …), so
 * finding the people in a payload never needs a model: harvest the labelled
 * fields. This module walks any JSON value — a raw Graph resource or one of the
 * app's own compact projections from `app-tools/graph.server.ts` — and returns
 * every identity it names.
 *
 * Detection is STRUCTURAL, not a whitelist of top-level keys, so it survives
 * new tool projections: any object that *looks like* an identity is one,
 * wherever it sits. Three shapes qualify:
 *
 *  1. emailAddress-like — an object whose `address` is an email (Graph's
 *     `emailAddress` resource), or a name-only object sitting under an
 *     `emailAddress` key (Graph omits `address` on some rows).
 *  2. user-like — an object with `displayName` plus an email-ish sibling
 *     (`email` / `mail` / `userPrincipalName`), or any `displayName` carrier
 *     under a `user` key (`createdBy.user` has no email on OneDrive personal
 *     items). This also matches the app's flat `graph_me` projection, whose
 *     `givenName` / `surname` become extra name variants.
 *  3. person-valued string keys — the app's compact projections flatten a
 *     person to one string (`from`, `organizer`, `shared_by`, `with[]`,
 *     `author`), so those keys are read as identities at ANY depth. This is a
 *     key-name heuristic, but on well-known person fields, not on payload roots.
 *
 * Free text (subject, bodyPreview, body.content, file names) is deliberately
 * NOT scanned — that is `pseudonymise.ts`'s job, using the roster found here.
 * A person who appears only in prose and never in a labelled field is invisible
 * to this module by design; see docs/plan/graph-pseudonymisation.md.
 */

/** One person found in a payload's labelled identity fields. */
export interface RosterEntry {
  /** Primary display name — the first non-empty one seen. Null when the
   *  payload only ever carried an address for this person. */
  name: string | null
  /** Email address as it appeared in the payload (original case); null for a
   *  name-only identity. Deduplication is case-insensitive. */
  address: string | null
  /** Every distinct spelling seen for this identity, primary name first.
   *  `graph_me`'s givenName/surname land here too. */
  nameVariants: string[]
  /** The labelled fields the identity was found under, e.g. 'from',
   *  'toRecipients', 'organizer', 'attendees'. Wrapper keys (`emailAddress`,
   *  `user`) are skipped so the role names the relationship, not the envelope. */
  roles: string[]
}

/** Loose email test — one `@`, something either side, a dot in the domain.
 *  Classification only, never validation. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Keys that wrap an identity without naming its role: `from.emailAddress`
 *  should report role 'from', `createdBy.user` role 'createdBy'. */
const WRAPPER_KEYS = new Set(['emailAddress', 'user'])

/** Compact-projection keys whose STRING value is a person (name or address).
 *  These are the flattened person fields the app's own tool projections emit
 *  (`shapeMessages`, `shapeEvents`, `shapeSharedInsight`,
 *  `shapeAttachmentMessage`) plus `author`, which Graph search args use. */
const PERSON_STRING_KEYS = new Set(['from', 'organizer', 'shared_by', 'sharedBy', 'with', 'author'])

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

interface Found {
  name: string | null
  address: string | null
  extraNames: string[]
  role: string
}

/** First email-shaped string among the candidates. */
function firstEmail(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    const s = str(c)
    if (s && EMAIL_RE.test(s)) return s
  }
  return null
}

/** Address carried in a nested collection rather than on the object itself:
 *  `person.scoredEmailAddresses[]` and `contact.emailAddresses[]`. Reading it
 *  here is what lets those resources keep their `displayName` — otherwise the
 *  name sits one level above the only address and the two never meet. Only the
 *  first address is taken; a second address for the same person is left to the
 *  ordinary walk. */
function nestedAddress(obj: Record<string, unknown>): string | null {
  for (const key of ['scoredEmailAddresses', 'emailAddresses']) {
    const list = obj[key]
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const address = firstEmail((item as Record<string, unknown> | null)?.address)
      if (address) return address
    }
  }
  return null
}

/**
 * Does this object itself denote a person? Returns the identity or null.
 * `key` is the property the object sits under — needed for the two shapes
 * where the fields alone are ambiguous (name-only `emailAddress`, email-less
 * `user`). An object with only `displayName` under any other key is NOT a
 * person: rooms, sites and locations all carry a lone displayName.
 */
function matchIdentity(obj: Record<string, unknown>, key: string | null): Found | null {
  // Shape 1: emailAddress-like.
  const address = firstEmail(obj.address)
  const name = str(obj.name)
  if (address) return { name, address, extraNames: [], role: '' }
  if (key === 'emailAddress' && name) return { name, address: null, extraNames: [], role: '' }

  // Shape 2: user-like (covers the flat graph_me projection too).
  const displayName = str(obj.displayName)
  if (displayName) {
    const userAddress = firstEmail(obj.email, obj.mail, obj.userPrincipalName) ?? nestedAddress(obj)
    if (userAddress || key === 'user') {
      const extraNames = [str(obj.givenName), str(obj.surname)].filter(
        (n): n is string => n !== null,
      )
      return { name: displayName, address: userAddress, extraNames, role: '' }
    }
  }
  return null
}

/** Record one flattened person string (shape 3) as a name or an address. */
function foundFromString(value: string, role: string): Found {
  const v = value.trim()
  return EMAIL_RE.test(v)
    ? { name: null, address: v, extraNames: [], role }
    : { name: v, address: null, extraNames: [], role }
}

function walkNode(value: unknown, key: string | null, role: string, out: Found[]): void {
  if (Array.isArray(value)) {
    for (const item of value) walkNode(item, key, role, out)
    return
  }
  if (value === null || typeof value !== 'object') return
  const obj = value as Record<string, unknown>

  // A meeting room is labelled as such by Graph (`attendees[].type ===
  // 'resource'`) even though its mailbox is shaped exactly like a person's.
  // Reading that label is cheaper and more reliable than guessing from the
  // name, and it keeps "Vergaderzaal Brussel" out of the roster — a room is not
  // personal data, and pseudonymising it would cost the model a real fact.
  if (obj.type === 'resource' && obj.emailAddress && typeof obj.emailAddress === 'object') return

  const identity = matchIdentity(obj, key)
  if (identity) {
    // An identity object is a leaf: its remaining fields are the identity's own
    // attributes, not further people.
    out.push({ ...identity, role })
    return
  }

  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      if (PERSON_STRING_KEYS.has(k) && v.trim()) out.push(foundFromString(v, k))
      continue
    }
    if (Array.isArray(v) && PERSON_STRING_KEYS.has(k)) {
      for (const item of v) {
        if (typeof item === 'string' && item.trim()) out.push(foundFromString(item, k))
      }
      continue
    }
    walkNode(v, k, WRAPPER_KEYS.has(k) ? role : k, out)
  }
}

function addVariant(entry: RosterEntry, name: string | null): void {
  if (!name) return
  if (!entry.nameVariants.includes(name)) entry.nameVariants.push(name)
  if (entry.name === null) entry.name = name
}

function addRole(entry: RosterEntry, role: string): void {
  if (role && !entry.roles.includes(role)) entry.roles.push(role)
}

/**
 * Walk any Graph-derived JSON value and return its identity roster, in
 * first-seen order. Identities are deduplicated by address
 * (case-insensitively); name-only finds merge into an addressed entry when the
 * name matches one of its variants, and otherwise stand alone. All name
 * spellings seen for one identity are kept as variants.
 */
export function extractRoster(payload: unknown): RosterEntry[] {
  const found: Found[] = []
  walkNode(payload, null, 'payload', found)

  const entries: RosterEntry[] = []
  const byAddress = new Map<string, RosterEntry>()

  // Addressed identities first, so a later name-only find of the same person
  // merges instead of opening a duplicate entry.
  for (const f of found) {
    if (!f.address) continue
    const addressKey = f.address.toLowerCase()
    let entry = byAddress.get(addressKey)
    if (!entry) {
      entry = { name: null, address: f.address, nameVariants: [], roles: [] }
      byAddress.set(addressKey, entry)
      entries.push(entry)
    }
    addVariant(entry, f.name)
    for (const extra of f.extraNames) addVariant(entry, extra)
    addRole(entry, f.role)
  }

  const byName = new Map<string, RosterEntry>()
  const variantOwner = (name: string): RosterEntry | undefined => {
    const needle = name.toLowerCase()
    return entries.find((e) => e.nameVariants.some((v) => v.toLowerCase() === needle))
  }
  for (const f of found) {
    if (f.address || !f.name) continue
    const nameKey = f.name.toLowerCase()
    const entry = variantOwner(f.name) ?? byName.get(nameKey)
    if (entry) {
      addVariant(entry, f.name)
      for (const extra of f.extraNames) addVariant(entry, extra)
      addRole(entry, f.role)
      continue
    }
    const fresh: RosterEntry = { name: f.name, address: null, nameVariants: [f.name], roles: [] }
    for (const extra of f.extraNames) addVariant(fresh, extra)
    addRole(fresh, f.role)
    byName.set(nameKey, fresh)
    entries.push(fresh)
  }

  return entries
}
