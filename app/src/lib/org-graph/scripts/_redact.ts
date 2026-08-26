/**
 * Terminal-output redaction for the org-graph scripts.
 *
 * These scripts run against the **real tenant**, so their stdout is the one
 * place real names and addresses could escape into a log, a scrollback, a
 * pasted PR body or an orchestration message. Every script here prints counts
 * and shapes; where an identity has to be shown at all — the pseudonymisation
 * demo has to prove a *specific* real name was replaced — it goes through
 * {@link mask}, which keeps enough structure to recognise a match and not
 * enough to name a person. Error paths additionally go through
 * {@link maskGraphIds}, because a Graph error message quotes the request path
 * and that path can carry a directory id.
 *
 * This is output hygiene, not a security control: the graph and the substitution
 * table still hold the cleartext, and are meant to.
 */

/**
 * `Jan Van Damme` → `··· ··· ···`; `jan.van.damme@example.test` →
 * `···.···.···@···.···`. Every run of letters and digits becomes the **same
 * three** characters, whatever its length; only the separators survive, so a
 * reader can still tell an address from a name and nothing else.
 *
 * ## Why fixed width, and why no initial
 * The earlier version kept each run's first character and its exact length. On
 * a public repo that is a re-identifier, not a redaction: initials plus a
 * per-word length signature narrows a directory of a few dozen people to one,
 * and is trivially confirmable by a colleague. Length is the half that is easy
 * to miss — cover the initials in `J·· V·· D····` and the 3/3/5 word signature
 * still picks one person out of the directory. That illustration is the
 * `Jan Van Damme` fixture from this module's tests on purpose: writing this
 * example with a real name would commit the very defect it describes.
 *
 * So the shape that survives is deliberately the coarsest one that still reads
 * as a shape. A caller that needs to tell two masked literals apart should
 * print an **index** (`person[0]`), not a richer mask.
 *
 * An empty string stays empty; a single character is masked like any other run,
 * because a one-letter run is itself a signature (a middle initial).
 */
export function mask(value: string): string {
  return value.replace(/[\p{L}\p{N}]+/gu, '···')
}

/**
 * Entra object ids out of a free-text string — `.../users/{guid}/memberOf` →
 * `.../users/⟨id⟩/memberOf`.
 *
 * For error paths. A Graph error message embeds the request path, and on the
 * memberships loop that path carries a member's directory id. No name and no
 * address, so the report's own guarantee holds either way — but an opaque
 * stable identifier for one employee is still that person, and "safe to paste
 * this transcript into a PR" should not need a caveat.
 */
export function maskGraphIds(value: string): string {
  return value.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '⟨id⟩')
}

/** A list of literals, masked and comma-joined — for "these needles fired". */
export const maskAll = (values: readonly string[]): string => values.map(mask).join(', ')

/** Sorted `key=count` pairs, or `none` — the shape every tally is printed in. */
export function formatCounts(counts: Record<string, number>): string {
  const pairs = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))
  return pairs.length === 0 ? 'none' : pairs.map(([k, v]) => `${k}=${v}`).join(' ')
}
