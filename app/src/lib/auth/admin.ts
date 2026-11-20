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
 * matched case-insensitively, plus the same `*@domain` wildcard form
 * `allowList.ts` accepts (there because a second tenant admin should be
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
 * The admin addresses from `ADMIN_EMAILS`, in canonical form: NFKC-normalized
 * (compatibility characters folded to the ones they resemble), then trimmed,
 * then lowercased. Canonicalization is for the LIST side — the operator's own
 * spelling — so two spellings of one address typed into the env var are one
 * entry, not two to keep in step by hand. The CHECKED (session) address is
 * never canonicalized; see `isAdminEmail` for why.
 */
export function getAdminEmails(
  runtimeValue: string | undefined = typeof process !== 'undefined'
    ? process.env.ADMIN_EMAILS
    : undefined,
): string[] {
  if (!runtimeValue) return []
  return runtimeValue
    .split(',')
    .map((entry: string) => canonicalAddress(entry))
    .filter((entry) => entry.length > 0)
    .filter((entry) => {
      // A bare `*@` names no domain, so it can match nothing; an operator who
      // wrote it meant a domain. Ignored, and said so once per process —
      // this parse runs on every admin check, so a per-call log would bury
      // everything else the way a failing tick's would.
      if (entry === '*@') {
        warnBareWildcard()
        return false
      }
      return true
    })
}

/** One canonical form for the LIST side of the comparison. NFKC FIRST: it
 *  is the fold that turns fullwidth letters and no-break spaces into the
 *  plain characters they stand in for, so the trim and the case fold below
 *  see what the operator sees. */
function canonicalAddress(address: string): string {
  return address.normalize('NFKC').trim().toLowerCase()
}

/** The once-per-process latch behind the bare-wildcard warning. */
const warnedBareWildcard = { said: false }
function warnBareWildcard(): void {
  if (warnedBareWildcard.said) return
  warnedBareWildcard.said = true
  console.warn(
    'ADMIN_EMAILS: ignoring the entry "*@" — a wildcard needs a domain (write "*@example.com")',
  )
}

/**
 * Is this address an admin? Exact match, or a `*@domain` wildcard entry that
 * covers it — the same two rules `allowList.ts` applies to sign-in, so an
 * operator who knows one syntax knows both.
 *
 * The two sides are deliberately NOT canonicalized the same way:
 *
 *  - The entries are canonicalized HERE as well rather than trusted to have
 *    passed through the parser — the list is the operator's own spelling, and
 *    folding it is what makes a fullwidth entry typed once still match.
 *  - The CHECKED (session) address is NEVER folded: an address that is not
 *    plain printable ASCII, or that would CHANGE under NFKC, is refused
 *    outright, and only its lowercase form is compared. Folding the checked
 *    side would let a look-alike — fullwidth letters, a mathematical-bold
 *    glyph — normalize INTO the address it imitates and match it, which is
 *    the one comparison an admin gate must never make.
 */
export function isAdminEmail(
  email: string | null | undefined,
  adminEmails: string[] = getAdminEmails(),
): boolean {
  if (!email) return false
  const addr = email.trim()
  // Plain printable ASCII only: no spaces, no control characters, nothing a
  // different font could render as the address it is standing in for.
  if (!/^[\x21-\x7e]+$/.test(addr)) return false
  // NFKC-stable only: an address that folds under NFKC is not the address it
  // would fold into, and the fold below is exactly what must not happen to
  // it.
  if (addr.normalize('NFKC') !== addr) return false
  const normalized = addr.toLowerCase()
  for (const entry of adminEmails) {
    const canonical = canonicalAddress(entry)
    if (canonical === normalized) return true
    if (canonical.startsWith('*@') && normalized.endsWith(canonical.substring(1))) return true
  }
  return false
}
