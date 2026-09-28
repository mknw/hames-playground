// @vitest-environment node
// (node, not jsdom: importing a vitest config loads esbuild, whose TextEncoder
// invariant fails under jsdom.)
/**
 * The harness-patterns package suite runs inside this app's vitest run, as a
 * second project (#407), and the coverage floors count it. This pin makes an
 * EMPTY package project fail on its own.
 *
 * Why it is needed: vitest reports "No test files found" only when the whole
 * run collects nothing. Here the `app` project always collects something, so
 * a package include that matches nothing would pass silently. The old
 * separate CI step would have failed outright. The only remaining signal would
 * be three floors dropping (statements ~90.8 against 93), and that margin
 * shrinks as coverage grows.
 *
 * Mutation that reddens it: set the package include to
 * `__tests__/**\/*.nomatch.ts`.
 */

import { globSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import pkgConfig from '../../../packages/harness-patterns/vitest.config'

const PKG = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/harness-patterns',
)

describe('the harness-patterns project', () => {
  it('collects its own suite', () => {
    const include = pkgConfig.test?.include ?? []
    const files = globSync(include, { cwd: PKG })
    // Named anchors from both halves of the suite, not just a count: a glob
    // narrowed to one directory would still collect "something".
    expect(files).toContain('__tests__/stash/chunking.test.ts')
    expect(files).toContain('__tests__/run-frame.test.ts')
    expect(files.length).toBeGreaterThan(10)
  })
})
