// @vitest-environment node
/**
 * The canvas actor is provenance, never authorization (org-knowledge slice 6;
 * FRONT, 2026-11-04). The `'use server'` wrapper's gate stays GATE-ONLY (#225
 * PR-C1, `auth-gate-shape.test.ts`); the id stamped as `createdBy` comes from
 * `canvasActor()`, read after the gate. These scans fail if:
 *
 *  1. `canvas-actor.server.ts` becomes a `'use server'` module (every export of
 *     one is a browser RPC, which would hand out an identity);
 *  2. any `'use server'` module exports or re-exports `canvasActor`;
 *  3. the actor's value reaches a branch: where it is used it is passed straight
 *     to an op, and inside the ops it is only ever a Cypher parameter.
 *
 * Mutations, each red: add `'use server'` to the helper; `export { canvasActor }`
 * from the wrapper; bind it and branch (`const a = await canvasActor(); if
 * (a.userId) …`); compare it in an op (`if (actor.userId === …)`).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const APP_SRC = path.resolve(__dirname, '../../..')
const HELPER = path.join(APP_SRC, 'lib/org-graph/canvas-actor.server.ts')
const OPS = path.resolve(APP_SRC, '../../packages/connectors/neo4j/graph-edit.server.ts')

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') files(full, out)
    } else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

const isUseServer = (code: string) => /(^|\n)\s*['"]use server['"]/.test(code)

describe('the canvas actor is provenance only', () => {
  it('is not a use-server module', () => {
    expect(isUseServer(strip(readFileSync(HELPER, 'utf8')))).toBe(false)
  })

  it('is exported from no use-server module', () => {
    const offenders = files(APP_SRC).filter((f) => {
      const code = strip(readFileSync(f, 'utf8'))
      if (!isUseServer(code)) return false
      return (
        /export\s*\{[^}]*\bcanvasActor\b/.test(code) ||
        /export\s*\*\s*from\s*['"][^'"]*canvas-actor/.test(code) ||
        /export\s+(async\s+)?(function|const|let)\s+canvasActor\b/.test(code)
      )
    })
    expect(offenders).toEqual([])
  })

  it('is passed straight to an op wherever it is used, never bound or branched on', () => {
    const users = files(APP_SRC).filter(
      (f) => f !== HELPER && strip(readFileSync(f, 'utf8')).includes('canvasActor('),
    )
    expect(users.map((f) => path.relative(APP_SRC, f))).toEqual(['lib/neo4j/graph-edit.server.ts'])
    for (const f of users) {
      const code = strip(readFileSync(f, 'utf8'))
      const uses = code.match(/[^\n]*canvasActor\(\)[^\n]*/g) ?? []
      expect(uses.length).toBe(3)
      for (const line of uses) {
        expect(line).toMatch(/^\s*return \w+Op\(ORG_ONTOLOGY, await canvasActor\(\), /)
      }
    }
  })

  it('is only ever a Cypher parameter inside the ops', () => {
    const code = strip(readFileSync(OPS, 'utf8'))
    const reads = code.match(/\bactor\.\w+/g) ?? []
    expect(reads.length).toBeGreaterThanOrEqual(6)
    for (const m of code.matchAll(/[^\n]*\bactor\.\w+[^\n]*/g)) {
      expect(m[0]).toMatch(/^\s*(\{ [^}]*)?(actor: actor\.userId|now: actor\.now)/)
    }
    expect(code).not.toMatch(/\bif\s*\([^)]*\bactor\b/)
    expect(code).not.toMatch(/\bactor\.\w+\s*[!=]==?/)
  })
})
