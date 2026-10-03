/**
 * Loads the company-domain source scan's patterns from the
 * `COMPANY_IDENTIFIER_PATTERNS` secret (see `company-domain-source-scan.test.ts`
 * for why they are not in the tree).
 *
 * **No part of a secret line ever reaches an error message.** A line that is
 * not a valid regular expression is reported by its line number and the kind
 * of problem only. `new RegExp` itself is not safe to let throw: V8's
 * `SyntaxError` quotes the whole source (`Invalid regular expression: /…/i`),
 * and CI logs on this repository are public, so leaving the redaction to the
 * Actions log masker would rest on masking a multi-line secret, which GitHub
 * advises against. The original error is dropped rather than attached as a
 * `cause`, because test runners print causes too.
 */

/** Thrown for a malformed secret; its message carries line numbers only. */
export class PatternSecretError extends Error {
  constructor(public readonly lines: number[]) {
    super(
      `COMPANY_IDENTIFIER_PATTERNS: ${lines
        .map((n) => `pattern on line ${n}`)
        .join(', ')} ${lines.length === 1 ? 'is' : 'are'} not a valid regular expression`,
    )
    this.name = 'PatternSecretError'
  }
}

/**
 * One case-insensitive pattern per non-blank line; blank lines are skipped and
 * line numbers count every line, so they match the secret as the owner wrote
 * it. Every malformed line is collected before throwing, so one run names them
 * all.
 */
export function loadIdentifierPatterns(raw: string | undefined): RegExp[] {
  const patterns: RegExp[] = []
  const malformed: number[] = []
  ;(raw ?? '').split('\n').forEach((line, index) => {
    const source = line.trim()
    if (!source) return
    try {
      patterns.push(new RegExp(source, 'i'))
    } catch {
      malformed.push(index + 1)
    }
  })
  if (malformed.length > 0) throw new PatternSecretError(malformed)
  return patterns
}
