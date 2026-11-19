/**
 * The deployment's admin allow-list — who may reach the owner-only GPU
 * control panel (`/admin`).
 *
 * No admin or role concept existed before this: the app's only access
 * distinction is the sign-in allow-list (`allowList.ts`), which decides who may
 * use the app at all. The GPU panel is a different question with a different
 * answer — it switches a SHARED, BILLED box on, so it is the owner's alone
 * (owner, 2026-11-19: "The modal (or admin panel, a 4th tab) will be only
 * accessible to me.").
 *
 * The list is the `ADMIN_EMAILS` env var: comma-separated email addresses,
 * matched case-insensitively after trimming, plus the same `*@domain` wildcard
 * form `allowList.ts` accepts (there because a second tenant admin should be
 * one line, not a per-person edit). Unset means NOBODY is an admin — the panel
 * is hidden, its server functions refuse, and the app is exactly what it was.
 *
 * Kept as a pure module beside `allowList.ts` rather than inside the `'use
 * server'` file that uses it: the check itself is unit-testable here, and a
 * `'use server'` module cannot export a shared helper without also exporting
 * it as an RPC the browser could call.
 */

/** The env var the deployment sets. Named here so tests and `.env.example`
 *  document one spelling. */
export const ADMIN_EMAILS_ENV = 'ADMIN_EMAILS'

/**
 * The admin addresses from `ADMIN_EMAILS`, lowercased and trimmed.
 *
 * Default parameters rather than a direct `process.env` read for the same
 * reason `getAllowedEmails` takes them: an injectable seam for tests. An
 * unset var is an EMPTY list — nobody is an admin — rather than an error, so
 * a deployment that does not care about the panel keeps a working app with
 * the panel hidden.
 */
export function getAdminEmails(
  runtimeValue: string | undefined = typeof process !== 'undefined'
    ? process.env.ADMIN_EMAILS
    : undefined,
): string[] {
  if (!runtimeValue) return []
  return runtimeValue
    .split(',')
    .map((email: string) => email.trim().toLowerCase())
    .filter((email: string) => email.length > 0)
}

/**
 * Is this address an admin? Exact match, or a `*@domain` wildcard entry that
 * covers it — the same two rules `allowList.ts` applies to sign-in, so an
 * operator who knows one syntax knows both.
 */
export function isAdminEmail(
  email: string | null | undefined,
  adminEmails: string[] = getAdminEmails(),
): boolean {
  if (!email) return false
  const normalized = email.trim().toLowerCase()
  if (adminEmails.includes(normalized)) return true
  for (const entry of adminEmails) {
    if (entry.startsWith('*@') && normalized.endsWith(entry.substring(1))) return true
  }
  return false
}
