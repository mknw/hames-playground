/**
 * ONE BAML corpus — a structural pin (architecture loop 2026-09-21, candidate 3).
 *
 * The repo used to carry two `baml_src/` trees: the package's
 * (`packages/harness-baml/baml_src`, with a COMMITTED `baml_client/`) and a
 * duplicate under `app/` that generated a git-ignored `app/baml_client/`. Ten
 * of the app tree's thirteen files were byte-identical to the package's and the
 * other three differed only in comments, so the two corpora said the same thing
 * — right up until an edit landed in one of them. Nothing failed when they
 * disagreed: the app tree's client was only read by the dev-fake installer, the
 * smoke scripts, the eval harness and two render tests, so a prompt edited on
 * the app side changed what those rendered and nothing that production sent.
 *
 * The app tree is gone. What this file pins is that it stays gone, because the
 * failure mode of its return is silence — a second tree does not error, it just
 * makes "which copy is the real one?" a question again.
 *
 * Three claims, and the second is the one that mattered in practice:
 *
 *   1. There is no `app/baml_src/` and no `baml_src` alias at the repo root
 *      (the root one was a symlink to the app tree, tracked since 2025-12, and
 *      a dangling symlink is how it announced itself when the tree went).
 *   2. No file under `app/` reaches a generated client by a RELATIVE path.
 *      Every one goes through the package specifier, which is the module the
 *      package's own adapters call — so the dev fake, the smoke scripts, the
 *      evals and the render tests all patch and read the `b` production uses.
 *   3. The app runs no BAML generate step. Generation belongs to the package,
 *      whose client is committed; an app-side generate script would have
 *      nothing to generate FROM, and re-adding one is how the duplicate tree
 *      would come back.
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** vitest runs from `app/` — every pnpm command in this repo does. */
const APP = process.cwd()
const ROOT = path.resolve(APP, '..')

/** The one corpus. Asserted to EXIST, so a rename of the package tree fails
 *  here rather than making the "no second tree" checks vacuously true. */
const CORPUS = path.join(ROOT, 'packages/harness-baml/baml_src')

/** This file, excluded from its own scan: it necessarily spells the patterns. */
const SELF = 'one-baml-corpus.test.ts'

/**
 * Source with comments removed.
 *
 * Load-bearing, not tidiness, and the same idiom `clients-verda.test.ts` uses
 * for the same reason: `middleware.ts` DOCUMENTS the relative specifier it used
 * to carry — quoted, because naming it is the point of the paragraph — and a
 * scan that reads prose cannot tell a stale import from an explanation of why
 * there is no longer one. It cut both ways: the `viaPackage` counter below
 * would also have been satisfied by a comment, which is exactly the
 * reads-like-an-import-imports-nothing failure this file exists to catch.
 *
 * A `//` inside a string literal (a URL) truncates that line early. Nothing in
 * this corpus writes a client specifier after a URL on the same line, and the
 * failure mode is a LOUD one — the import reads as absent, so the non-vacuity
 * check goes red — not a silent pass.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** True for a path that exists OR is a dangling symlink. `existsSync` follows
 *  links, so it alone reports a broken alias as absent — which is exactly the
 *  state the root alias was left in when the app tree was deleted. */
function presentOrDangling(target: string): boolean {
  if (existsSync(target)) return true
  try {
    return lstatSync(target).isSymbolicLink()
  } catch {
    return false
  }
}

describe('one BAML corpus', () => {
  it('lives in the package, and nowhere else', () => {
    expect(existsSync(CORPUS), `the BAML corpus is missing at ${CORPUS}`).toBe(true)
    expect(presentOrDangling(path.join(APP, 'baml_src')), 'app/baml_src is back').toBe(false)
    expect(
      presentOrDangling(path.join(ROOT, 'baml_src')),
      'a baml_src alias is back at the repo root',
    ).toBe(false)
  })

  it('is reached from app code only through the package specifier', () => {
    // Tracked files only: a stale generated directory left on a developer's
    // disk is not a claim about the repo.
    const tracked = execFileSync('git', ['ls-files', '--', 'app'], {
      cwd: ROOT,
      maxBuffer: 16 * 1024 * 1024,
    })
      .toString()
      .split('\n')
      .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f))
    // Non-vacuity: a pathspec typo would otherwise scan nothing and pass.
    expect(tracked.length, 'the file scan found nothing').toBeGreaterThan(100)

    const relative: string[] = []
    let viaPackage = 0
    for (const file of tracked) {
      if (file.endsWith(SELF)) continue
      const text = stripComments(readFileSync(path.join(ROOT, file), 'utf8'))
      // Quoted specifiers in CODE — a specifier named in prose is not an import.
      for (const [, spec] of text.matchAll(/['"`]([^'"`\n]*baml_client[^'"`\n]*)['"`]/g)) {
        if (spec.startsWith('@hames-ai/harness-baml/baml_client')) viaPackage += 1
        else if (spec.startsWith('.') || spec.startsWith('/')) relative.push(`${file}: ${spec}`)
      }
    }
    expect(relative, 'app code imports a generated BAML client by a relative path').toEqual([])
    // The other direction: if nothing imported the package client, the check
    // above would be satisfied by an app that had stopped calling BAML at all.
    expect(viaPackage, 'nothing in app/ imports the package client').toBeGreaterThan(0)
  })

  it('runs no BAML generate step of its own', () => {
    const scripts = (
      JSON.parse(readFileSync(path.join(APP, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>
      }
    ).scripts
    // Non-vacuity: an empty script map would pass the scan below.
    expect(Object.keys(scripts).length).toBeGreaterThan(5)
    const generating = Object.entries(scripts)
      .filter(([, cmd]) => /baml-cli|baml-generate/.test(cmd))
      .map(([name, cmd]) => `${name}: ${cmd}`)
    expect(generating, 'the app declares a BAML generate step again').toEqual([])
  })
})
