/**
 * Source scan: every workspace package under `packages/` carries the house
 * conventions a published package cannot be added without.
 *
 * ## Why a pin rather than a note in a review checklist
 *
 * Issue #354 is the case study, and it is self-concealing — which is the only
 * kind of defect a pin is genuinely worth paying for. `packages/harness-patterns`
 * shipped without a `.prettierrc.json`; prettier then formatted its files with
 * its own defaults, `prettier --check` on those same files also used the
 * defaults and reported them CLEAN, and CI's changed-file format check filters
 * to `app/` so it never looked. Nothing anywhere reported a problem. What it
 * cost: on PR #352 a 9-line addition came back as ~130 lines of whole-file
 * style churn, and that churn HID a regression — a published export
 * (`omitResultFields`) lost its 30-line docblock because a new function was
 * inserted between the rationale and the function it documented.
 *
 * So the invariant is not "the config is nice to have". It is that a diff in a
 * published package must be the size of the change it describes, because that
 * is the only thing standing between a reviewer and a silent deletion.
 *
 * This pin is the FIRST half of #354's third bullet ("a pin that every
 * workspace package has a `.prettierrc.json`, so a fourth package cannot be
 * added without one" — a fifth, now). The other half of that issue, widening
 * CI's format-check glob beyond `app/`, is NOT done here and #354 stays open
 * for it: this catches the missing config, not an unformatted file.
 *
 * Discovered, never listed. A hardcoded package list would go stale on exactly
 * the event the pin exists for — a new package — so the directory is read.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// `process.cwd()` is `app/` under vitest, the same anchor the other source-scan
// pins use.
const PACKAGES = resolve(process.cwd(), '../packages')

/** Every workspace member under `packages/` (the `packages/*` glob in
 *  `pnpm-workspace.yaml`), by directory name. */
function workspacePackages(): string[] {
  return readdirSync(PACKAGES)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => statSync(join(PACKAGES, name)).isDirectory())
    .filter((name) => {
      try {
        return statSync(join(PACKAGES, name, 'package.json')).isFile()
      } catch {
        return false
      }
    })
    .sort()
}

describe('workspace package conventions', () => {
  const packages = workspacePackages()

  it('there are packages to check, so the scan cannot pass vacuously', () => {
    // Five today. The floor is deliberately below that: this assertion exists
    // to catch a broken readdir, not to have to be edited on every extraction.
    expect(packages.length).toBeGreaterThanOrEqual(4)
    expect(packages).toContain('harness-patterns')
    expect(packages).toContain('sandbox')
  })

  it('every package carries a .prettierrc.json, and they all agree (#354)', () => {
    const configs = new Map<string, string>()
    const missing: string[] = []
    for (const name of packages) {
      try {
        configs.set(name, readFileSync(join(PACKAGES, name, '.prettierrc.json'), 'utf8'))
      } catch {
        missing.push(name)
      }
    }
    expect(
      missing,
      'a published package with no prettier config formats to prettier defaults, and --check agrees with itself',
    ).toEqual([])

    // One style, or the churn comes back per package rather than per repo.
    // Compared against the APP's config, which is the house style the repo
    // converges on file by file.
    const house = readFileSync(resolve(process.cwd(), '.prettierrc.json'), 'utf8')
    const disagreeing = [...configs.entries()]
      .filter(([, body]) => JSON.stringify(JSON.parse(body)) !== JSON.stringify(JSON.parse(house)))
      .map(([name]) => name)
    expect(disagreeing, 'these packages format differently from app/').toEqual([])
  })

  it('every package ships a LICENSE and a README beside its manifest', () => {
    const incomplete: string[] = []
    for (const name of packages) {
      for (const file of ['LICENSE', 'README.md']) {
        try {
          statSync(join(PACKAGES, name, file))
        } catch {
          incomplete.push(`${name}/${file}`)
        }
      }
    }
    expect(incomplete).toEqual([])
  })
})
