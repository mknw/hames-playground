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
 * What is scanned: the files git TRACKS under `app/`, `packages/` and `docs/`,
 * plus `.env.production.example` at the repo root. Tracked-only is the point —
 * gitignored files (a developer's local `.env`, build output, logs) never
 * reach a public clone, so reddening on one would be a false alarm about a
 * different thing than what this guard exists to prevent.
 *
 * What is deliberately NOT scanned for: people's names. A public deny-list of
 * real names would republish those names in the repo it guards — the test
 * would become the leak it exists to prevent. Names are caught by the scrub
 * that removed them and by review; the domain and the tenant hostnames are the
 * mechanical carriers a string scan can pin without listing anyone.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ROOT = resolve(process.cwd(), '..')
const SCAN_ROOTS = ['app', 'packages', 'docs', '.env.production.example']

/** This file itself carries the patterns by design, so it is excluded. */
const SELF = 'company-domain-source-scan.test.ts'

const FORBIDDEN: Array<{ label: string; pattern: RegExp }> = [
  { label: 'real email domain', pattern: /dtsc\.be/i },
  { label: 'real tenant hostname', pattern: /dtsc(?:-my)?\.sharepoint\.com/i },
]

/** Assets whose bytes cannot carry prose; avoids decoding binaries needlessly. */
const BINARY = /\.(png|jpe?g|gif|ico|svgz|woff2?|ttf|otf|eot|pdf|zip|gz|webp|avif|mp4|webm)$/i

describe('source scan — company-identifying domain', () => {
  it('the real domain and tenant hostnames appear in no tracked file under app/, packages/ or docs/', async () => {
    const tracked = execFileSync('git', ['ls-files', ...SCAN_ROOTS], {
      cwd: ROOT,
      maxBuffer: 16 * 1024 * 1024,
    })
      .toString()
      .split('\n')
      .filter(Boolean)
      .filter((file) => !file.endsWith(SELF))
    // The scan must never pass vacuously: a broken `git ls-files` (empty
    // output) is a failure, not a clean scan.
    expect(tracked.length).toBeGreaterThan(100)

    const offenders: string[] = []
    for (const file of tracked) {
      if (BINARY.test(file)) continue
      const text = await readFile(join(ROOT, file), 'utf8')
      for (const { label, pattern } of FORBIDDEN) {
        if (pattern.test(text)) offenders.push(`${file} (${label})`)
      }
    }
    expect(offenders).toEqual([])
  })
})
