/**
 * At-rest encryption for stored user content and personal data — Server Only.
 *
 * The decision this implements is *application-layer* encryption rather than
 * disk- or database-level: a `pg_dump`, a stolen volume or a snapshot restored
 * somewhere else must yield ciphertext, not rows. AES-256-GCM, in the same
 * authenticated envelope `auth/secret-crypto.server.ts` already uses for the
 * MSAL token cache — this module is the key management, the null handling and
 * the legacy-plaintext handling *around* those primitives, deliberately not a
 * second crypto implementation.
 *
 * Dependency direction: `db/` -> `auth/secret-crypto`. That module imports
 * nothing from `db/`, so there is no cycle; the alternative was copying the
 * cipher, which is how two envelopes drift apart.
 *
 * ## The key
 *
 * `DATA_ENCRYPTION_KEY`, and nothing else. There is deliberately **no**
 * fallback to `AUTH_SESSION_SECRET` or to `TOKEN_ENCRYPTION_KEY`, unlike the
 * token store's HKDF fallback: the three protect data with three different
 * rotation costs. Rotating the cookie key logs everyone out; rotating the
 * token key makes users sign in again; rotating *this* key makes every stored
 * conversation unreadable unless it is re-encrypted first. Sharing key
 * material would couple the cheap rotations to the expensive one.
 *
 * The value is HKDF-normalised to 32 bytes under this module's own `info`
 * label, so any length of secret can be pasted in, and the resulting key is
 * cryptographically distinct from the token-cache key even when an operator
 * pastes the same string into both env vars.
 *
 * ## Failure policy (named on purpose — an unexamined one is the defect)
 *
 * - **No key configured** — every encrypt and every decrypt throws
 *   {@link MissingDataEncryptionKeyError}. We never fall back to writing
 *   plaintext, and never return an empty value that the next save would then
 *   write over. `client.server.ts`'s schema init escalates the dangerous
 *   variant of this — no key *and* encrypted rows already in the table — into
 *   a boot failure, so the process refuses to serve rather than throwing per
 *   request.
 * - **Wrong key or tampered row** — throws {@link DataDecryptionError}. This
 *   is the opposite of `user-tokens.server.ts`, which treats a failed decrypt
 *   as "no usable cache" and re-authenticates, and the difference is
 *   deliberate: a token cache is reconstructible, a conversation is not. Fail
 *   soft there and the read looks like an empty conversation, which the next
 *   turn's `saveConversation` happily overwrites. The loud failure keeps a
 *   key-management incident from becoming data loss.
 * - **Blast radius of one bad row, named separately** because it is a second
 *   decision and not a corollary of the one above: a listing maps every row it
 *   selected, so a single unreadable `title` fails `listConversations` for that
 *   owner's whole sidebar, not just the one conversation. Fail-closed is still
 *   right for content the user is being *shown* — a silently shorter list is
 *   how a key incident turns into "my conversations are gone" — but the two
 *   background firing paths in `db/routines.server.ts` deliberately choose the
 *   opposite policy, because a tick that shows nobody their data has no reason
 *   to take every other user's routines down with the bad row.
 *
 * ## Envelope
 *
 * `v1.<iv>.<authTag>.<ciphertext>`, base64url parts (see
 * `secret-crypto.server.ts`). The version prefix carries two jobs beyond
 * documentation: it is what makes the backfill migration idempotent
 * (`migrate-encryption.server.ts` selects on {@link NOT_ENCRYPTED_SQL}), and it is
 * what lets a future rotation be lazy — `v2.` values can be written alongside
 * `v1.` ones and each read with the key its own prefix names.
 */
import { hkdfSync } from 'node:crypto'
import { assertServerOnImport } from '../harness-patterns/assert.server'
import { decryptSecret, encryptSecret } from '../auth/secret-crypto.server'

assertServerOnImport()

/** Env var holding the data-encryption key. Exported so docs/tests name it once. */
export const DATA_KEY_ENV = 'DATA_ENCRYPTION_KEY'

/** Current envelope version, including its separator. */
export const ENVELOPE_PREFIX = 'v1.'

const HKDF_INFO = 'kg-agent:db-crypto:v1'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

/** base64url length of an `n`-byte buffer (unpadded, which is what Node emits). */
const b64urlLen = (bytes: number): number => Math.ceil((bytes * 4) / 3)

/**
 * The shape of an envelope, as one source of truth in two dialects.
 *
 * `v1.<iv>.<tag>.<ciphertext>`, every part base64url, with the IV and tag parts
 * pinned to the exact length their byte count encodes to. The body is `*`, not
 * `+`, because AES-GCM of the empty string is empty and `title = ''` must read
 * back as itself rather than as a lookalike.
 *
 * There used to be three definitions of "already encrypted" in play — this
 * structural one, a `LIKE 'v1.%'` in SQL and a `startsWith('v1.')` in JS — and
 * they disagreed on exactly the values that matter: a *user-authored* title
 * beginning `v1.` was skipped by the backfill (so it stayed in the clear in
 * every dump) and counted as ciphertext by the key-less boot gate (so an
 * operator was told to restore a key that had never existed). The prefix tests
 * are gone; both dialects below are generated from the same constants.
 */
const ENVELOPE_BODY = `[A-Za-z0-9_-]`
const ENVELOPE_SHAPE = `^${ENVELOPE_PREFIX.replace('.', '\\.')}${ENVELOPE_BODY}{${b64urlLen(
  IV_BYTES,
)}}\\.${ENVELOPE_BODY}{${b64urlLen(TAG_BYTES)}}\\.${ENVELOPE_BODY}*$`

const ENVELOPE_RE = new RegExp(ENVELOPE_SHAPE)

/**
 * SQL predicate fragment that selects *not-yet-encrypted* values of a TEXT
 * column, and its complement. Both use {@link looksEncrypted}'s own rule, so
 * SQL selection, the JS skip inside the backfill and the read path cannot
 * disagree about what an envelope is. `~` is a POSIX regex match; the pattern
 * is a compile-time constant, never user input.
 */
export const NOT_ENCRYPTED_SQL = (column: string): string =>
  `${column} IS NOT NULL AND ${column} !~ '${ENVELOPE_SHAPE}'`

/** `column` holds one of our envelopes. Complement of {@link NOT_ENCRYPTED_SQL}. */
export const ENCRYPTED_SQL = (column: string): string => `${column} ~ '${ENVELOPE_SHAPE}'`

/** Thrown when `DATA_ENCRYPTION_KEY` is absent and encrypted data is in play. */
export class MissingDataEncryptionKeyError extends Error {
  constructor(what: string) {
    super(
      `[db-crypto] ${DATA_KEY_ENV} is not set, so ${what} cannot proceed. ` +
        `Generate one with \`openssl rand -base64 32\` and set ${DATA_KEY_ENV}. ` +
        'Refusing to store or serve user data unencrypted.',
    )
    this.name = 'MissingDataEncryptionKeyError'
  }
}

/** Thrown when a stored envelope will not authenticate under the current key. */
export class DataDecryptionError extends Error {
  constructor(where: string) {
    super(
      `[db-crypto] could not decrypt ${where}: the value is not readable with the ` +
        `current ${DATA_KEY_ENV}. This is a wrong/rotated key or a tampered row — ` +
        'failing loudly rather than serving an empty value that the next write would overwrite.',
    )
    this.name = 'DataDecryptionError'
  }
}

// Memoised on the raw env value rather than on first use, so a test (or a
// future in-process rotation) that changes the variable is honoured instead of
// silently keeping the key derived at first call.
let derived: { raw: string; key: Buffer } | null = null

/** True when a key is configured. Does not derive it. */
export function hasDataEncryptionKey(): boolean {
  return Boolean(process.env[DATA_KEY_ENV]?.trim())
}

function dataKey(what: string): Buffer {
  const raw = process.env[DATA_KEY_ENV]?.trim()
  if (!raw) throw new MissingDataEncryptionKeyError(what)
  if (derived?.raw !== raw) {
    derived = {
      raw,
      key: Buffer.from(hkdfSync('sha256', Buffer.from(raw), Buffer.alloc(0), HKDF_INFO, KEY_BYTES)),
    }
  }
  return derived.key
}

/**
 * Whether a stored value is one of our envelopes.
 *
 * Structural, not just prefix-matching: a user-authored title that happens to
 * start with `v1.` must not be mistaken for ciphertext and reported as
 * undecryptable. Matching the whole shape — part count, alphabet and the exact
 * IV/tag lengths — reduces the false-positive space to values that are, for
 * practical purposes, only produced by {@link encryptField}. This is *the*
 * definition; {@link NOT_ENCRYPTED_SQL} and {@link ENCRYPTED_SQL} are the same
 * rule rendered for Postgres, and a test pins the two against each other.
 */
export function looksEncrypted(value: unknown): value is string {
  return typeof value === 'string' && ENVELOPE_RE.test(value)
}

/** Encrypt a value for storage. */
export function encryptField(plaintext: string): string {
  return encryptSecret(plaintext, dataKey('writing user data'))
}

/** Encrypt a nullable column value; `null` stays `null` (and stays visible). */
export function encryptFieldOrNull(plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined) return null
  return encryptField(plaintext)
}

/**
 * Decrypt a stored column value.
 *
 * A value that is not an envelope is returned unchanged: that is a row written
 * before the backfill (or one the backfill skipped), and reading it as the
 * plaintext it is beats refusing to serve it. `where` is a `table.column`
 * label that lands in the error message.
 */
export function decryptField(stored: string, where: string): string {
  if (!looksEncrypted(stored)) return stored
  const plain = decryptSecret(stored, dataKey(`reading ${where}`))
  if (plain === null) throw new DataDecryptionError(where)
  return plain
}

/** {@link decryptField} for a nullable column. */
export function decryptFieldOrNull(
  stored: string | null | undefined,
  where: string,
): string | null {
  if (stored === null || stored === undefined) return null
  return decryptField(stored, where)
}

/**
 * Encrypt a JSON document for a JSONB column.
 *
 * The envelope is stored as a JSONB **string scalar** rather than migrating the
 * column to TEXT. That keeps the column type, avoids a rewrite lock on a table
 * whose whole payload is the blob, and gives the reader an exact test —
 * `jsonb_typeof(context) = 'string'` — instead of the heuristic a TEXT column
 * would need. `pg` parses a JSONB string scalar into a JS string, so
 * {@link decryptJsonb} sees the envelope directly.
 */
export function encryptJsonb(serialized: string): string {
  return JSON.stringify(encryptField(serialized))
}

/**
 * Read a JSONB column that may hold either an envelope (a JSON string) or a
 * legacy plaintext document (a JSON object), returning the serialized JSON in
 * both cases.
 *
 * A string that is *not* an envelope is treated as a corrupt row, not a legacy
 * one, and throws rather than handing a caller a JSON payload that will not
 * parse. The assumption is about *writers*, not about the column: no writer in
 * this repo ever stored a bare string there, but the column type permits one,
 * so a hand-written `jsonb_set`-style fixup would land in the throwing branch.
 * That is the intended reading — an unexplained bare string in a blob column is
 * likelier damage than data.
 */
export function decryptJsonb(stored: unknown, where: string): string {
  if (typeof stored === 'string') {
    if (!looksEncrypted(stored)) throw new DataDecryptionError(`${where} (unrecognised envelope)`)
    return decryptField(stored, where)
  }
  return JSON.stringify(stored)
}
