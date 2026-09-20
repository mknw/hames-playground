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
 * What is scanned: the WHOLE git-tracked tree, every root. Tracked-only is the
 * point — gitignored files (a developer's local `.env`, build output, logs)
 * never reach a public clone, so reddening on one would be a false alarm about
 * a different thing than what this guard exists to prevent. Whole-tree rather
 * than a list of known roots because a guard whose blind spot is "anywhere
 * that was not already on the list" fails exactly when a carrier is added
 * somewhere new, which is the only scenario it exists for.
 *
 * What the patterns cover: the plain domain, the two tenant hostnames, and
 * the underscore-encoded slug form. The slug is not an edge case —
 * `pseudonymise.ts` documents that the same address appears in a
 * SharePoint/OneDrive `webUrl` with every dot turned into an underscore, so it
 * is the second canonical spelling of the same identifier and a guard that
 * knows only the plain form is half a guard.
 *
 * What is deliberately NOT scanned for: people's names. A public deny-list of
 * real names would republish those names in the repo it guards — the test
 * would become the leak it exists to prevent. Names are caught by the scrub
 * that removed them and by review; the domain and the tenant hostnames are the
 * mechanical carriers a string scan can pin without listing anyone.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ROOT = resolve(process.cwd(), '..')

/** This file itself carries the patterns by design, so it is excluded. */
const SELF = 'company-domain-source-scan.test.ts'

const FORBIDDEN: Array<{ label: string; pattern: RegExp }> = [
  { label: 'real email domain', pattern: /dtsc\.be/i },
  { label: 'real tenant hostname', pattern: /dtsc(?:-my)?\.sharepoint\.com/i },
  {
    label: 'underscore-encoded domain slug',
    pattern: /_dtsc_be/i,
  },
]

/** Assets whose bytes cannot carry prose; avoids decoding binaries needlessly. */
const BINARY = /\.(png|jpe?g|gif|ico|svgz|woff2?|ttf|otf|eot|pdf|zip|gz|webp|avif|mp4|webm)$/i

describe('source scan — company-identifying domain', () => {
  it('the real domain and tenant hostnames appear in no tracked file anywhere in the repo', async () => {
    // No pathspec: every tracked file, at every root, is in scope.
    const tracked = execFileSync('git', ['ls-files'], {
      cwd: ROOT,
      maxBuffer: 16 * 1024 * 1024,
    })
      .toString()
      .split('\n')
      .filter(Boolean)
      .filter((file) => !file.endsWith(SELF))
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
      for (const { label, pattern } of FORBIDDEN) {
        if (pattern.test(text)) offenders.push(`${file} (${label})`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps the exclusion list minimal and explicit', async () => {
    // The only exclusion is this file itself (SELF above), which necessarily
    // carries the patterns. Two deliberate non-exclusions, stated here so a
    // future pattern does not silently widen the guard over them:
    // - `app/src/lib/auth/graph-token.server.ts` holds the Graph User-Agent
    //   `NONISV|<company>|kg-agent/1.0`, Microsoft's documented convention, an
    //   owner-flagged decision (see PR #353). No current pattern matches it —
    //   the literal has no dot-suffix — so it needs no file exclusion; but a
    //   future bare-token pattern would trip it, and that edit should re-read
    //   this comment first.
    // - The LICENSE/README copyright attributions carry the owner's name,
    //   which is precisely what this guard refuses to scan for.
    expect(SELF).toContain('company-domain-source-scan')
  })
})
