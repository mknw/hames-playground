#!/usr/bin/env node
/**
 * Data collection for the pack smoke's DERIVED entry sets (scripts/pack-smoke.sh).
 *
 * The probe used to carry a hand-typed `appEntries` array per package. A typed
 * list is a pin that goes stale silently: the app grew imports of
 * `@hames/harness-patterns/runtime-config` and `.../runtime-config.server` and
 * the list never learned about either, so the one check that says "a consumer
 * can load what we ship" stopped covering two modules without anything going
 * red. This script produces the facts the probe derives its sets from instead:
 *
 *   scan-app <out.json>
 *     ONE walk of app/ (the whole tree, minus build output and node_modules —
 *     an allowlist of subdirectories is the same staleness one level up) for
 *     every `@hames/*` specifier the app actually names. Written once per run
 *     and read by all five package probes.
 *
 *   derive <tarball> <package> <app-imports.json> <out.json>
 *     The packed TARBALL's file list (not the source tree, so `files` /
 *     `.npmignore` effects are included) plus that package's slice of the app
 *     scan. The exports-map arithmetic happens in pack-smoke-derived.mjs,
 *     inside the scratch project, against the INSTALLED manifest — which is
 *     what a consumer actually resolves against.
 *
 * Comments are deliberately NOT stripped before matching. A commented-out
 * `from '@hames/x/y'` would enter the set as a phantom, and the probe would go
 * red naming it — loud and wrong, which is recoverable. Stripping comments with
 * a regex risks eating a real specifier off a line that also holds a `//` (a
 * URL, a regex literal), and that failure is silent, which is the exact failure
 * class this script exists to end.
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Directories under app/ that hold no hand-written app source. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.output',
  '.vinxi',
  'dist',
  'coverage',
  '.runtime',
  'playwright-report',
  'test-results',
  'baml_client',
  'public',
])

const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])

/**
 * `from '…'`, a bare or dynamic `import`, `require('…')`, and vitest's module
 * mocks — every form in which app code names a specifier that a consumer's
 * resolver has to answer.
 */
const SPECIFIER_RE =
  /(?:\bfrom|\bimport|\brequire|\bvi\.(?:mock|doMock|unmock|importActual|importMock))\s*\(?\s*['"](@hames\/[^'"]+)['"]/g

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), out)
    } else if (entry.isFile() && SOURCE_EXT.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name))
    }
  }
  return out
}

/** `@hames/agents/agents/search.server` -> ['@hames/agents', './agents/search.server'] */
function splitSpecifier(specifier) {
  const parts = specifier.split('/')
  const pkg = parts.slice(0, 2).join('/')
  const rest = parts.slice(2).join('/')
  return [pkg, rest === '' ? '.' : './' + rest]
}

function scanApp(appDir) {
  const files = walk(appDir, [])
  /** @type {Record<string, Set<string>>} */
  const packages = {}
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    if (!source.includes('@hames/')) continue
    for (const match of source.matchAll(SPECIFIER_RE)) {
      const [pkg, subpath] = splitSpecifier(match[1])
      ;(packages[pkg] ??= new Set()).add(subpath)
    }
  }
  return {
    scannedDir: path.relative(process.cwd(), appDir) || appDir,
    fileCount: files.length,
    packages: Object.fromEntries(
      Object.entries(packages)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([pkg, subpaths]) => [pkg, [...subpaths].sort()]),
    ),
  }
}

/** The tarball's own file list, with npm's `package/` prefix stripped. */
function tarballFiles(tarball) {
  return execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.endsWith('/'))
    .map((line) => (line.startsWith('package/') ? line.slice('package/'.length) : line))
    .sort()
}

const [subcommand, ...args] = process.argv.slice(2)

if (subcommand === 'scan-app') {
  const [outFile] = args
  const appDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'app')
  const result = scanApp(appDir)
  writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n')
  const counts = Object.entries(result.packages)
    .map(([pkg, subpaths]) => `${pkg}=${subpaths.length}`)
    .join(' ')
  console.log(`app scan: ${result.fileCount} files under ${result.scannedDir} -> ${counts}`)
} else if (subcommand === 'derive') {
  const [tarball, packageName, appImportsFile, outFile] = args
  const scan = JSON.parse(readFileSync(appImportsFile, 'utf8'))
  const appImported = scan.packages[packageName] ?? []
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        package: packageName,
        tarball: path.basename(tarball),
        tarballFiles: tarballFiles(tarball),
        appImported,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`derived: ${packageName} — ${appImported.length} app-imported subpaths from the scan`)
} else {
  console.error('usage: pack-smoke-entries.mjs scan-app <out.json>')
  console.error(
    '       pack-smoke-entries.mjs derive <tarball> <package> <app-imports.json> <out.json>',
  )
  process.exit(2)
}
