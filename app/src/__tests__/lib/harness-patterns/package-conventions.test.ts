/**
 * Source scan: every workspace package under `packages/` carries the house
 * conventions a published package cannot be added without — a prettier config,
 * a LICENSE and README beside the manifest, and (owner ruling 2026-09-22) a
 * cross-package dependency edge declared as a PEER rather than a dependency.
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

  /**
   * ## Why a cross-package edge is a PEER and not a dependency
   *
   * `@hames/harness-patterns` holds module-level `AsyncLocalStorage`
   * singletons — the inference-tier scope, the settings scope, the cold-start
   * watch. Everything those seams enforce is a property of ONE module
   * instance: a scope opened in one copy is invisible to a read from another.
   *
   * As an ordinary `dependency`, nothing stops a consumer's tree holding two
   * copies. The app resolves one at the top level; a companion whose declared
   * range does not overlap it gets its own nested copy; and then a private-tier
   * scope opened by the app is simply not there when the companion's code asks
   * for it. The turn does not fail — it runs on the wrong tier, silently, which
   * is the SD-1/SD-5 class the (a0) assertion in `package-publish.test.ts`
   * already guards one half of (`workspace:^` over `workspace:*`, so a patch
   * release does not split the tree).
   *
   * A peer edge closes the other half: the consumer owns the single copy, and a
   * version it cannot satisfy is an install-time warning naming both ranges
   * rather than a duplicate nobody sees. This is the shape every plugin
   * ecosystem converged on for the same reason.
   *
   * The devDependency half is not bookkeeping. A peer alone installs nothing,
   * so without it `pnpm install` leaves the package's own `node_modules/@hames`
   * empty and its tests, its typecheck and its `pnpm pack` all lose the
   * workspace link. Both entries are `workspace:^`; pnpm rewrites that to a
   * real caret range at pack time, which `package-publish.test.ts` asserts on
   * the tarball itself.
   *
   * Discovered, never listed — same rule as the scans above, and for the same
   * reason: a hardcoded companion list goes stale on exactly the event this
   * pin exists for.
   */
  describe('cross-package edges are peers (owner ruling 2026-09-22)', () => {
    interface Manifest {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const manifests = new Map<string, Manifest>(
      packages.map((name) => [
        name,
        JSON.parse(readFileSync(join(PACKAGES, name, 'package.json'), 'utf8')) as Manifest,
      ]),
    )
    const hames = (field?: Record<string, string>): string[] =>
      Object.keys(field ?? {})
        .filter((spec) => spec.startsWith('@hames/'))
        .sort()

    it('no package lists an @hames/* package under dependencies', () => {
      const offenders = Object.fromEntries(
        [...manifests.entries()]
          .map(([name, m]) => [name, hames(m.dependencies)] as const)
          .filter(([, specs]) => specs.length > 0),
      )
      expect(
        offenders,
        'a cross-package edge under `dependencies` lets a consumer resolve a SECOND copy of ' +
          "harness-patterns, whose module-level AsyncLocalStorage scopes then don't apply — " +
          'declare it under `peerDependencies` (and keep it as a devDependency)',
      ).toEqual({})
    })

    it('every @hames/* peer is also a devDependency, so the workspace link survives', () => {
      const unlinked = Object.fromEntries(
        [...manifests.entries()]
          .map(
            ([name, m]) =>
              [
                name,
                hames(m.peerDependencies).filter((s) => !(m.devDependencies ?? {})[s]),
              ] as const,
          )
          .filter(([, specs]) => specs.length > 0),
      )
      expect(
        unlinked,
        'a peer installs nothing: without the matching devDependency this package has no ' +
          'node_modules/@hames link, so its own tests, typecheck and pack all break',
      ).toEqual({})
    })

    it('the companions DO declare @hames peers, so neither scan above passes vacuously', () => {
      // The four companions of harness-patterns, which is the one package with
      // no @hames edge of its own. Asserted by COUNT, not by name, for the same
      // reason the enumeration is discovered: a sixth companion needs no edit.
      const withPeers = [...manifests.entries()].filter(
        ([, m]) => hames(m.peerDependencies).length > 0,
      )
      expect(withPeers.map(([name]) => name).sort()).toEqual([
        'agents',
        'connectors',
        'harness-baml',
        'sandbox',
      ])
      // agents peers on both harness-baml and harness-patterns; the other three
      // on harness-patterns alone.
      expect(hames(manifests.get('agents')?.peerDependencies)).toEqual([
        '@hames/harness-baml',
        '@hames/harness-patterns',
      ])
    })
  })
})
