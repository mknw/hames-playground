/**
 * Terminal-output redaction for the org-graph scripts.
 *
 * These scripts run against the **real tenant**, so their stdout is the one
 * place real names and addresses could escape into a log, a scrollback, a
 * pasted PR body or an orchestration message. Every script here prints counts
 * and shapes; where an identity has to be shown at all — the pseudonymisation
 * demo has to prove a *specific* real name was replaced — it goes through
 * {@link mask}, which keeps enough structure to recognise a match and not
 * enough to name a person.
 *
 * This is output hygiene, not a security control: the graph and the substitution
 * table still hold the cleartext, and are meant to.
 */

/**
 * `Jan Van Damme` → `J·· V·· D····`; `jan.van.damme@dtsc.be` →
 * `j··@d···.··`-ish. Keeps the first character of each alphanumeric run and the
 * separators, replacing the rest with `·`, so the shape of the literal (word
 * count, lengths, whether it is an address) survives and the identity does not.
 *
 * A single character is returned as-is — there is nothing to hide in `A` — and
 * an empty string stays empty.
 */
export function mask(value: string): string {
  return value.replace(/[\p{L}\p{N}]+/gu, (run) =>
    run.length <= 1 ? run : run[0] + '·'.repeat(run.length - 1),
  )
}

/** A list of literals, masked and comma-joined — for "these needles fired". */
export const maskAll = (values: readonly string[]): string => values.map(mask).join(', ')

/** Sorted `key=count` pairs, or `none` — the shape every tally is printed in. */
export function formatCounts(counts: Record<string, number>): string {
  const pairs = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))
  return pairs.length === 0 ? 'none' : pairs.map(([k, v]) => `${k}=${v}`).join(' ')
}
