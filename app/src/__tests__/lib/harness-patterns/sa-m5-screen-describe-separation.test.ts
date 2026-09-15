/**
 * SA-M5 / SD-4 — the injection screen stays separately injected.
 *
 * The one way the Lane A6 design could break SA-M5 (design note §6): collapsing
 * the six describe functions and the screen into a single injected shape — one
 * `DescribeFn` with a `kind` discriminator, or a `screen()` method beside the
 * describe methods. That re-creates the implicit coupling one layer above BAML
 * (the app supplies one object and gets both roles), and it would be harder to
 * spot than the BAML-chain version because it would look like tidy
 * consolidation. The ruling: `ScreenUntrustedContent` stays its own injected
 * function with its own type (`InjectionScreen`), and the six describe
 * functions stay separately injected.
 *
 * This pin makes the property a scan rather than a paragraph, in three parts:
 *
 *  1. core's `injection-guard.ts` — the module that DECLARES `InjectionScreen`
 *     — imports nothing from the BAML seam at all. The screen type is
 *     self-contained in core; nothing describe-shaped can reach it from there.
 *  2. NO exported type declaration under `harness-patterns/` or
 *     `harness-baml/` carries both a screen side and a describe side in one
 *     type. A collapsed `DescribeFn` with `kind: 'describe' | 'screen'`, a
 *     `screen()` method on a describe fn, or a `describe` member on the screen
 *     type all trip this — verified by mutation (see the PR body).
 *  3. the screen keeps its own factory (`createInjectionScreen` in
 *     `harness-baml`) whose name and return type are the screen's alone.
 *
 * The scan reads SOURCE TEXT, not the type system: the failure mode being
 * caught is a declaration that LOOKS like tidy consolidation, which is
 * exactly what a structural check on compiled types would happily accept.
 */

import { describe, expect, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const APP = process.cwd()
const CORE = resolve(APP, 'src/lib/harness-patterns')
const BAML = resolve(APP, 'src/lib/harness-baml')

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

/** Strip comments so prose ABOUT the separation cannot look like a violation
 *  (this file's own header is the proof such prose exists). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** Every exported `type` / `interface` declaration, with its full body. */
function exportedTypeDeclarations(source: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = []
  const re = /\bexport\s+(?:type|interface)\s+(\w+)/g
  for (const match of source.matchAll(re)) {
    const name = match[1]
    const start = match.index ?? 0
    // A declaration ends at the next top-level `export`/statement opener or a
    // blank line after its closing brace/semicolon — for scanning purposes the
    // remainder of the statement is enough: capture up to 1200 chars or the
    // next `export ` keyword, whichever is nearer.
    const rest = source.slice(start, start + 1200)
    const nextExport = rest.slice(1).search(/\nexport /)
    const body = nextExport === -1 ? rest : rest.slice(0, nextExport + 1)
    out.push({ name, body })
  }
  return out
}

const SCREEN_SIDE = /screen/i
const DESCRIBE_SIDE = /describe/i

describe('SA-M5: screen and describe stay separately injected', () => {
  it('injection-guard.ts imports nothing from the BAML seam', async () => {
    const source = stripComments(await readFile(join(CORE, 'injection-guard.ts'), 'utf8'))
    expect(source.includes('harness-baml')).toBe(false)
    expect(/from\s+'[^']*baml/.test(source)).toBe(false)
    expect(/@boundaryml/.test(source)).toBe(false)
  })

  it('InjectionScreen is declared in core, beside the deterministic layer', async () => {
    const source = stripComments(await readFile(join(CORE, 'injection-guard.ts'), 'utf8'))
    expect(/export\s+type\s+InjectionScreen\s*=/.test(source)).toBe(true)
  })

  it('no exported type in core or harness-baml unifies the screen and describe roles', async () => {
    const offenders: string[] = []
    for (const root of [CORE, BAML]) {
      for (const file of await walk(root)) {
        const source = stripComments(await readFile(file, 'utf8'))
        for (const { name, body } of exportedTypeDeclarations(source)) {
          // A pure string-literal union (the `BamlRole` union names both roles —
          // that is the ROUTING map, and clients-verda.test.ts pins it as
          // REQUIRED to carry both, separately) is not a collapse. A collapse
          // is a type that HANDS OUT both behaviours — it must carry a
          // callable: an arrow, a method signature, or a call signature.
          const callable = /=>/.test(body) || /\w+\s*\(/.test(body)
          if (!callable) continue
          const hasScreenSide = SCREEN_SIDE.test(body)
          const hasDescribeSide = DESCRIBE_SIDE.test(body)
          if (hasScreenSide && hasDescribeSide) {
            offenders.push(`${relative(APP, file)} — ${name}`)
          }
        }
      }
    }
    // The failure message names the collapsed type, so the fix is obvious and
    // the temptation ("tidy consolidation") is named in the pin's header.
    expect(offenders).toEqual([])
  })

  it('the screen keeps its own factory in harness-baml, apart from describe', async () => {
    const source = stripComments(await readFile(join(BAML, 'baml-adapters.server.ts'), 'utf8'))
    expect(/export\s+function\s+createInjectionScreen/.test(source)).toBe(true)
  })
})
