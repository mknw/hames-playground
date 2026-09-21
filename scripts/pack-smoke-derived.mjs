/**
 * The pack smoke's derived entry check. COPIED into each scratch project by
 * scripts/pack-smoke.sh and imported by that project's probe — never imported
 * from the repo, because a dynamic `import('@hames/…')` resolves relative to
 * the file doing the importing, and from inside the repo that is the workspace
 * symlink, which is the one resolution this whole smoke exists to rule out.
 *
 * It replaces the probe's hand-typed `appEntries` array and its
 * "every explicit export target exists" loop with two DERIVED sets:
 *
 *   appImported — every `@hames/<pkg>/…` subpath the app names, from one scan
 *                 of app/ (scripts/pack-smoke-entries.mjs `scan-app`).
 *   declared    — the INSTALLED manifest's `exports` map, with each `*` pattern
 *                 expanded against the files the TARBALL actually contains.
 *
 * and asserts, in order:
 *
 *   (c) every app-imported subpath RESOLVES from the tarball, by the manifest's
 *       own exports algorithm, onto a file the tarball ships. This is the drift
 *       a typed list cannot see: an app import the probe was never told about.
 *   (d) every declared entry — explicit first, then the wildcard expansion —
 *       points at a file the tarball ships.
 *
 * and then EVALUATES the union of the two sets through the installed tarball,
 * which is what proves a consumer can actually load what we ship.
 *
 * (c) is a set check and runs BEFORE any import: an unresolvable specifier then
 * fails by NAME ("the app imports X; no exports entry covers it") instead of as
 * whichever ERR_MODULE_NOT_FOUND the import happened to raise.
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

/** Node's PATTERN_KEY_COMPARE: longest prefix before `*` wins, then longest suffix. */
function patternKeyCompare(a, b) {
  const [aPrefix, aSuffix] = a.split('*')
  const [bPrefix, bSuffix] = b.split('*')
  return bPrefix.length - aPrefix.length || bSuffix.length - aSuffix.length
}

/**
 * Resolve one subpath through an exports map the way node does: an exact key
 * wins; otherwise the most specific `*` pattern does, and its matched substring
 * is substituted into the target. Returns the target path, or null when nothing
 * covers the subpath at all.
 */
function resolveSubpath(subpath, exportsMap) {
  if (typeof exportsMap[subpath] === 'string') return exportsMap[subpath]
  const patterns = Object.keys(exportsMap)
    .filter((key) => key.includes('*'))
    .sort(patternKeyCompare)
  for (const key of patterns) {
    const [prefix, suffix] = key.split('*')
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue
    if (subpath.length < prefix.length + suffix.length) continue
    const target = exportsMap[key]
    if (typeof target !== 'string') continue
    return target.replace('*', subpath.slice(prefix.length, subpath.length - suffix.length))
  }
  return null
}

/** Every subpath a `*` pattern declares, given the files the tarball ships. */
function expandPatterns(exportsMap, files) {
  const subpaths = new Set()
  for (const [key, target] of Object.entries(exportsMap)) {
    if (!key.includes('*') || typeof target !== 'string' || !target.includes('*')) continue
    const [prefix, suffix] = target.replace(/^\.\//, '').split('*')
    for (const file of files) {
      if (!file.startsWith(prefix) || !file.endsWith(suffix)) continue
      if (file.length < prefix.length + suffix.length) continue
      subpaths.add(key.replace('*', file.slice(prefix.length, file.length - suffix.length)))
    }
  }
  return subpaths
}

const specifierFor = (pkg, subpath) => (subpath === '.' ? pkg : pkg + subpath.slice(1))

const shippedPath = (target) => target.replace(/^\.\//, '')

/**
 * @param {object} options
 * @param {string} options.entriesFile  JSON from `pack-smoke-entries.mjs derive`
 * @param {string} options.manifestFile the INSTALLED package.json — what a consumer resolves against
 * @param {(specifier: string) => Promise<unknown>} options.importer must be defined in the SCRATCH project
 */
export async function assertDerivedEntries({ entriesFile, manifestFile, importer }) {
  const { package: pkg, appImported, tarballFiles } = JSON.parse(readFileSync(entriesFile, 'utf8'))
  const exportsMap = JSON.parse(readFileSync(manifestFile, 'utf8')).exports
  const shipped = new Set(tarballFiles)

  assert.ok(
    appImported.length > 0,
    `the app scan found no ${pkg} imports — the scan itself is broken`,
  )
  assert.ok(tarballFiles.length > 0, `the ${pkg} tarball listed no files — the pack step is broken`)

  const explicit = Object.keys(exportsMap).filter(
    (key) => key !== './package.json' && !key.includes('*'),
  )
  const declared = [...new Set([...explicit, ...expandPatterns(exportsMap, tarballFiles)])].sort()

  // (c) every app-imported subpath resolves, named as the app names it.
  const unresolved = []
  for (const subpath of appImported) {
    const target = resolveSubpath(subpath, exportsMap)
    if (target === null) {
      unresolved.push(`${specifierFor(pkg, subpath)} — no exports entry of ${pkg} covers it`)
    } else if (!shipped.has(shippedPath(target))) {
      unresolved.push(
        `${specifierFor(pkg, subpath)} — exports resolves it to ${target}, which the tarball does not ship`,
      )
    }
  }
  assert.equal(
    unresolved.length,
    0,
    `the app imports ${unresolved.length} ${pkg} subpath(s) a tarball consumer cannot resolve:\n  ` +
      unresolved.join('\n  '),
  )

  // (d) every declared entry points at a file the tarball ships.
  const broken = []
  for (const subpath of declared) {
    const target = resolveSubpath(subpath, exportsMap)
    if (target === null || !shipped.has(shippedPath(target))) {
      broken.push(`${subpath} -> ${target ?? '(unresolvable)'} is missing from the tarball`)
    }
  }
  assert.equal(
    broken.length,
    0,
    `${pkg} declares ${broken.length} export entr(ies) the tarball does not ship:\n  ` +
      broken.join('\n  '),
  )

  // The union EVALUATES through the installed tarball.
  const union = [...new Set([...appImported, ...declared])].sort()
  const failures = []
  for (const subpath of union) {
    const specifier = specifierFor(pkg, subpath)
    try {
      await importer(specifier)
      console.log(`  eval ok:   ${specifier}`)
    } catch (err) {
      failures.push([specifier, err])
      console.error(`  eval FAIL: ${specifier}: ${err?.message ?? String(err)}`)
    }
  }
  if (failures.length > 0) {
    console.error(
      `\npack smoke: ${failures.length}/${union.length} ${pkg} entries failed module evaluation` +
        ' — a regression: the package imports something a tarball consumer cannot resolve' +
        ' (an app/src edge returning, or an undeclared dependency).',
    )
    // Rethrow the FIRST failure raw: the original stack (ERR_MODULE_NOT_FOUND
    // naming the unresolvable path) is the evidence a PR body records.
    throw failures[0][1]
  }

  console.log(
    `${pkg}: ${appImported.length} app-imported subpaths resolved, ` +
      `${declared.length} declared entries evaluated (${explicit.length} explicit, ` +
      `${declared.length - explicit.length} from the wildcard expansion over ${tarballFiles.length} packed files); ` +
      `${union.length} union entries evaluated`,
  )
}
