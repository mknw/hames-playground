/**
 * The 'use server' strip pin for @hames/connectors (#225 PR-C2; the PR-2
 * template, applied to this package).
 *
 * The modules that moved in from the host app carried `'use server'`
 * directives — in the host, those directives made every export of the module
 * a browser-reachable RPC (SD-13). The package is a LIBRARY: its modules are
 * imported by the host's composition root, not exposed as RPCs, so the
 * directives are stripped and `assertServerOnImport()` (which the host's
 * bundler and any consumer's runtime can enforce) is the load-time guard that
 * replaces them — added to exactly the modules that relied on the directive
 * alone.
 *
 * What this pin holds:
 *  1. NO `'use server'` directive survives anywhere in the package (source
 *     text scan — directives cannot hide anywhere but source).
 *  2. The modules that carried the directive (the neo4j query ops and the
 *     graph-edit ops) call `assertServerOnImport()` at load, so the strip
 *     removes nothing load-bearing.
 *  3. The modules that already carried the guard before the move (the
 *     registry and the Graph tools) still do.
 */

import { describe, it, expect } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const PKG = resolve(process.cwd(), '.')

/** Modules that carried `'use server'` in the host app and were stripped. */
const STRIPPED = ['neo4j/queries.ts', 'neo4j/graph-edit.server.ts']
/** Modules that already called the guard before the move. */
const PRE_GUARDED = ['app-tools/registry.ts', 'graph/graph-tools.server.ts']

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      files.push(...(await walk(full)))
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      files.push(full)
    }
  }
  return files
}

describe("the 'use server' strip (PR-2 template, @hames/connectors)", () => {
  it('no directive survives in any package source file', async () => {
    const files = await walk(PKG)
    expect(files.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      // A directive, not a mention in prose: quoted at the start of a line
      // (the form the bundler and the RPC transform both recognise).
      if (/^\s*['"]use server['"]/m.test(text)) {
        offenders.push(relative(PKG, file))
      }
    }
    expect(offenders).toEqual([])
  })

  it('every module that relied on the directive alone now calls assertServerOnImport()', async () => {
    for (const rel of STRIPPED) {
      const text = await readFile(join(PKG, rel), 'utf8')
      expect(
        text.includes('assertServerOnImport()'),
        `${rel} must call assertServerOnImport() — it relied on the stripped directive`,
      ).toBe(true)
    }
  })

  it('the pre-guarded modules kept their guard through the move', async () => {
    for (const rel of PRE_GUARDED) {
      const text = await readFile(join(PKG, rel), 'utf8')
      expect(text.includes('assertServerOnImport()'), `${rel} lost its guard in the move`).toBe(
        true,
      )
    }
  })
})
