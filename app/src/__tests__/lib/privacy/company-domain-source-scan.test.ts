/**
 * Source scan: the real company domain and its Microsoft 365 tenant hostnames
 * stay out of the public repo.
 *
 * The fixtures, docs and example config once carried the real email domain,
 * the real tenant hostnames and real people's addresses on them; they were
 * scrubbed to Microsoft's own reserved `contoso` placeholders (the house style
 * `app/src/lib/app-tools/graph.server.ts` already used) and this test is the
 * pin, in the same spirit as the other source-scan tests
 * (`encryption-coverage.test.ts`, `zero-app-imports.test.ts`).
 *
 * **The patterns are not in this file, or anywhere in the public tree.** A
 * deny-list written here republishes the very identifier it guards — the
 * argument this file always made about people's names (below) holds for the
 * domain too, and the owner's 2026-10-03 rule names the company tenant and
 * domain as never-public. They arrive through `COMPANY_IDENTIFIER_PATTERNS`:
 * one case-insensitive regular expression per line, set as a repository
 * secret and passed to the CI test step.
 *
 * **Failure policy, stated rather than inherited: fail OPEN when the variable
 * is absent.** A fork's pull request never receives secrets, and a local run
 * has no reason to, so an unset variable skips the scan with a warning rather
 * than failing every such run. The cost is that the guard is only as present
 * as the secret: with it unset in the repository, CI scans nothing. A
 * malformed pattern fails closed (the `RegExp` throws).
 *
 * **Nothing about a pattern is printed.** CI logs on a public repository are
 * public, so an offender is reported as the file and the pattern's line
 * number in the variable, never its text.
 *
 * What is scanned: the WHOLE git-tracked tree, every root. Tracked-only is the
 * point — gitignored files (a developer's local `.env`, build output, logs)
 * never reach a public clone, so reddening on one would be a false alarm about
 * a different thing than what this guard exists to prevent. Whole-tree rather
 * than a list of known roots because a guard whose blind spot is "anywhere
 * that was not already on the list" fails exactly when a carrier is added
 * somewhere new, which is the only scenario it exists for.
 *
 * What the patterns should cover: the plain domain, the two tenant hostnames,
 * and the underscore-encoded slug form. The slug is not an edge case —
 * `pseudonymise.ts` documents that the same address appears in a
 * SharePoint/OneDrive `webUrl` with every dot turned into an underscore, so it
 * is the second canonical spelling of the same identifier and a guard that
 * knows only the plain form is half a guard.
 *
 * What is deliberately NOT scanned for: people's names. A deny-list of real
 * names would republish those names wherever it lives — the test would become
 * the leak it exists to prevent. Names are caught by the scrub that removed
 * them and by review; the domain and the tenant hostnames are the mechanical
 * carriers a string scan can pin without listing anyone.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ROOT = resolve(process.cwd(), '..')

/** One pattern per non-blank line; a malformed one throws here, loudly. */
const FORBIDDEN: RegExp[] = (process.env.COMPANY_IDENTIFIER_PATTERNS ?? '')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((source) => new RegExp(source, 'i'))

if (FORBIDDEN.length === 0) {
  console.warn(
    '[company-domain-source-scan] COMPANY_IDENTIFIER_PATTERNS is unset: the scan is SKIPPED. ' +
      'CI runs it only when the repository secret of that name is set.',
  )
}

/** Assets whose bytes cannot carry prose; avoids decoding binaries needlessly. */
const BINARY = /\.(png|jpe?g|gif|ico|svgz|woff2?|ttf|otf|eot|pdf|zip|gz|webp|avif|mp4|webm)$/i

describe.skipIf(FORBIDDEN.length === 0)('source scan — company-identifying domain', () => {
  it('the real domain and tenant hostnames appear in no tracked file anywhere in the repo', async () => {
    // No pathspec and no exclusions: every tracked file, at every root, is in
    // scope — this file included, since it no longer carries the patterns.
    const tracked = execFileSync('git', ['ls-files'], {
      cwd: ROOT,
      maxBuffer: 16 * 1024 * 1024,
    })
      .toString()
      .split('\n')
      .filter(Boolean)
    // The scan must never pass vacuously: a broken `git ls-files` (empty
    // output) is a failure, not a clean scan. Whole-tree widening is exactly
    // when a broken invocation would silently scan nothing, so this check is
    // load-bearing and stays.
    expect(tracked.length).toBeGreaterThan(100)

    const offenders: string[] = []
    for (const file of tracked) {
      // Submodules list as a single directory entry (gitlink); nothing to read.
      if ((await stat(join(ROOT, file))).isDirectory()) continue
      if (BINARY.test(file)) continue
      const text = await readFile(join(ROOT, file), 'utf8')
      FORBIDDEN.forEach((pattern, index) => {
        if (pattern.test(text)) offenders.push(`${file} (pattern on line ${index + 1})`)
      })
    }
    expect(offenders).toEqual([])
  })
})

// Deliberate non-targets, stated so a future pattern does not silently widen
// the guard over them (there is no file exclusion list any more):
// - `app/src/lib/auth/graph-token.server.ts` holds the Graph User-Agent
//   `NONISV|<company>|hames-app/1.0`, Microsoft's documented convention, an
//   owner-flagged decision (see PR #353). It carries the company name, not the
//   domain, so a domain or hostname pattern does not match it; a bare-token
//   pattern would, and that edit should re-read this comment.
// - The LICENSE/README copyright attributions carry the owner's name, which is
//   precisely what this guard refuses to scan for.
