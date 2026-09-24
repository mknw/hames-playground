#!/usr/bin/env node
// Pins `.changeset/config.json`'s changedFilePatterns against the tarballs.
//
// The PR check (`changeset status`) only asks for a changeset when a changed
// file matches those patterns, and the negated ones (`!__tests__/**`, …) are
// the files we claim do NOT ship. That claim is a hand-typed list beside each
// package's `files` allowlist, so it can drift: widen `files` to include
// `scripts/` and every change there would ship with no changeset asked for.
// This script closes that gap from the other side — it packs every public
// package (dry run, nothing written) and fails if any file that WOULD be in a
// tarball is excluded by a negated pattern.
//
// Patterns are relative to the package directory, as changesets applies them.
// `path.matchesGlob` stands in for changesets' picomatch; both are gitignore-
// style globs and the patterns here use nothing beyond `*` and `**`.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const config = JSON.parse(readFileSync(path.join(root, '.changeset/config.json'), 'utf8'))
const negated = (config.changedFilePatterns ?? [])
  .filter((p) => p.startsWith('!'))
  .map((p) => p.slice(1))

const failures = []
for (const dir of readdirSync(path.join(root, 'packages'))) {
  const pkgDir = path.join(root, 'packages', dir)
  if (!existsSync(path.join(pkgDir, 'package.json'))) continue
  const manifest = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  if (manifest.private) continue
  const packed = JSON.parse(
    execFileSync('pnpm', ['pack', '--dry-run', '--json'], { cwd: pkgDir, encoding: 'utf8' }),
  )
  for (const { path: file } of packed.files) {
    const hit = negated.find((pattern) => path.matchesGlob(file, pattern))
    if (hit) failures.push(`${manifest.name}: ships ${file}, but "!${hit}" says it does not`)
  }
}

if (failures.length > 0) {
  console.error(
    'changedFilePatterns exclude files that ship — a change to them would need no changeset:',
  )
  for (const f of failures) console.error(`  ${f}`)
  console.error(
    'Narrow the negated pattern in .changeset/config.json, or drop the file from `files`.',
  )
  process.exit(1)
}
console.log(`OK: no shipped file matches the ${negated.length} negated changedFilePatterns.`)
