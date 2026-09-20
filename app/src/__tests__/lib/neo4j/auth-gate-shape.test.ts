/**
 * Auth-gate shape pin for the retained neo4j `'use server'` modules (#225 PR-C1).
 *
 * Every export of a `'use server'` module is a browser-reachable RPC, and each
 * of these two modules duplicates its own auth gate rather than importing one
 * (SD-13: a shared helper would itself be an RPC). This pin holds the narrowing
 * `graph-edit.server.ts`'s gate took in #225 PR-C1: `requireAuthenticated()`
 * returns `Promise<void>` — gate-only by construction, because the id it used
 * to return was discarded by every caller and a gate that hands out the
 * identity it checked invites a future caller to use the return as
 * authorization.
 *
 * `queries.ts`'s `denyUnauthenticated` is already void-shaped in the same
 * sense: it returns the module's `{ success: false; error }` refusal envelope or
 * `null` — never an identity — and every caller returns the envelope *before*
 * opening a session. Both shapes are allowed; anything else (a `string`, an
 * id, an unannotated return) fails, so a new or edited gate cannot quietly go
 * back to handing out identity.
 *
 * Verified by mutation (see the PR body): reverting `requireAuthenticated` to
 * the old `Promise<string>` / `return u.id` shape reddens this file.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const MODULES = [
  '../../../lib/neo4j/graph-edit.server.ts',
  '../../../lib/neo4j/queries.ts',
] as const

/** The two identity-capable-free return shapes a gate may declare. */
const ALLOWED_GATE_RETURNS = new Set(['void', '{ success: false; error: string } | null'])

/** Calls that mark a function as an auth gate (SD-13's duplicated primitives). */
const GATE_MARKERS = ['isBypassEnabled(', 'getAuthenticatedUser(']

/**
 * Extract the balanced `{ … }` body of a function whose declaration MATCH ends
 * with its opening brace (a regex like /^async function …\s*\{/). Skips string
 * literals so braces inside them don't count — and crucially starts at the
 * match's brace, not the line's first `{`, because a return type like
 * `Promise<{ success: false; error: string } | null>` contains braces of its own.
 */
function extractBody(source: string, startLine: number, braceOffset: number): string {
  const lines = source.split('\n')
  const first = lines[startLine]
  const open = braceOffset
  if (first[open] !== '{') {
    throw new Error(`expected opening brace at line ${startLine + 1} col ${open + 1}`)
  }
  let depth = 0
  let quote: string | null = null
  const out: string[] = []
  for (let i = startLine; i < lines.length; i++) {
    const line = i === startLine ? first.slice(open) : lines[i]
    for (let c = 0; c < line.length; c++) {
      const ch = line[c]
      if (quote) {
        if (ch === '\\')
          c++ // skip escaped char
        else if (ch === quote) quote = null
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) return [...out, line.slice(0, c + 1)].join('\n')
      }
    }
    out.push(line)
  }
  throw new Error(`unbalanced braces from line ${startLine + 1}`)
}

interface FoundFunction {
  name: string
  /** Declared `Promise<…>` payload, or null when the annotation is absent. */
  returnType: string | null
  body: string
  file: string
}

/** Every module-level `async function` declaration in a source file. */
function moduleFunctions(source: string, file: string): FoundFunction[] {
  const found: FoundFunction[] = []
  const decl = /^async function (\w+)\(([^)]*)\)(?::\s*Promise<([^>]*)>)?\s*\{/
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = decl.exec(lines[i])
    if (!m) continue
    found.push({
      name: m[1],
      returnType: m[3] ?? null,
      body: extractBody(source, i, m.index! + m[0].length - 1),
      file,
    })
  }
  return found
}

function gates(): FoundFunction[] {
  const gates: FoundFunction[] = []
  for (const rel of MODULES) {
    const file = fileURLToPath(new URL(rel, import.meta.url))
    const source = readFileSync(file, 'utf8')
    for (const fn of moduleFunctions(source, path.basename(rel))) {
      if (GATE_MARKERS.some((marker) => fn.body.includes(marker))) gates.push(fn)
    }
  }
  return gates
}

describe('neo4j auth-gate shape (void gates only)', () => {
  it('finds the duplicated gate in every retained neo4j use-server module', () => {
    const found = gates()
    const names = found.map((g) => `${g.file}:${g.name}`).sort()
    expect(names).toEqual([
      'graph-edit.server.ts:requireAuthenticated',
      'queries.ts:denyUnauthenticated',
    ])
  })

  it('every gate returns a void-shaped type — never an identity', () => {
    for (const gate of gates()) {
      expect(
        gate.returnType,
        `${gate.file}: gate ${gate.name} must declare its return type explicitly`,
      ).not.toBeNull()
      const payload = gate.returnType!.replace(/\s+/g, ' ').trim()
      expect(
        ALLOWED_GATE_RETURNS.has(payload),
        `${gate.file}: gate ${gate.name} declares Promise<${payload}> — a gate must not ` +
          'hand out an identity. Allowed: Promise<void>, or the refusal envelope ' +
          'Promise<{ success: false; error: string } | null> (return it BEFORE opening ' +
          'any resource).',
      ).toBe(true)
    }
  })

  it('no gate body returns the identity it checked', () => {
    for (const gate of gates()) {
      expect(gate.body, `${gate.file}: ${gate.name} must not return BYPASS_USER`).not.toMatch(
        /return\s+BYPASS_USER/,
      )
      expect(
        gate.body,
        `${gate.file}: ${gate.name} must not return the authenticated user's id`,
      ).not.toMatch(/return\s+\w+\.id\b/)
    }
  })
})
