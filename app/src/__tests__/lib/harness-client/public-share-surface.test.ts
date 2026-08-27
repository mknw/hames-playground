/**
 * Source scan: the anonymous read path stays one function wide.
 *
 * Every export of a `'use server'` module is an RPC the browser can call
 * (SD-13), so "this file is not owner-scoped" is a statement about a file and
 * not about a function. `shared-conversation.server.ts` is that file. The two
 * ways it silently stops being safe are a second export slipped in beside the
 * first — helpers in these modules are RPCs too, however internal they look —
 * and an auth import appearing so that the read starts behaving differently for
 * a signed-in caller.
 *
 * A reviewer cannot keep checking either by eye, which is what this is for. It
 * fails on the addition, not on a wrong one: a genuine second public read means
 * deliberately editing the list below, and that edit is the review.
 *
 * The mirror-image assertion is on `actions.server.ts` — every export there
 * MUST be owner-scoped — because the two files' only difference is which side
 * of that line they are on, and a share action drifting into the public module
 * would pass a test that only looked at one of them.
 */
import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// `process.cwd()` is `app/` under vitest, the anchor the other source-scan pins
// use (`encryption-coverage.test.ts`, the Neo4j ones).
const SRC = resolve(process.cwd(), 'src')
const PUBLIC_MODULE = resolve(SRC, 'lib/harness-client/shared-conversation.server.ts')
const OWNER_MODULE = resolve(SRC, 'lib/harness-client/actions.server.ts')

/** `export async function name(` / `export function name(` — the RPC shapes.
 *  Types and interfaces are not callable and are deliberately not matched. */
const EXPORTED_FUNCTIONS = /^export (?:async )?function\s+([A-Za-z0-9_$]+)/gm

/** Every function in the file, exported or not, with the source of its body.
 *  Non-exported ones matter because an exported action is allowed to be gated
 *  by something it calls — see the fixpoint below. */
const ANY_FUNCTION = /^(?:export )?(?:async )?function\s+([A-Za-z0-9_$]+)/gm

function exportedFunctions(source: string): string[] {
  return [...source.matchAll(EXPORTED_FUNCTIONS)].map((m) => m[1]).sort()
}

/**
 * Drop comments before scanning for identifiers.
 *
 * These modules carry long rationale headers that NAME the things this test
 * looks for — "never calls `requireUser()`" is a sentence in the public
 * module's own header, and a scan that read it would fail on the documentation
 * rather than on the code. Crude but sufficient: no string literal in either
 * file contains a comment opener.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Each function's body, keyed by name — sliced from one declaration to the
 *  next, which is enough to tell what it calls. */
function bodies(source: string): Map<string, string> {
  const decls = [...source.matchAll(ANY_FUNCTION)]
  const out = new Map<string, string>()
  decls.forEach((m, i) => {
    const start = m.index ?? 0
    const end = i + 1 < decls.length ? (decls[i + 1].index ?? source.length) : source.length
    out.set(m[1], source.slice(start, end))
  })
  return out
}

/**
 * Functions that resolve the caller, directly or through something they call.
 *
 * A fixpoint rather than a literal `requireUser()` grep, because three exports
 * are gated one level down (`processMessage` → `processMessageWithAgent`,
 * `approveAction` / `rejectAction` → `resolveApproval`) and a test that could
 * not see that would have to be weakened with a hand-maintained allow-list —
 * which is where a genuinely ungated export would eventually be parked.
 */
function gatedFunctions(source: string): Set<string> {
  const fns = bodies(source)
  const gated = new Set<string>()
  for (let changed = true; changed;) {
    changed = false
    for (const [name, body] of fns) {
      if (gated.has(name)) continue
      const direct = body.includes('requireUser()')
      const viaCallee = [...gated].some((g) => body.includes(`${g}(`))
      if (direct || viaCallee) {
        gated.add(name)
        changed = true
      }
    }
  }
  return gated
}

describe('the public share surface', () => {
  it('exports exactly one callable function', async () => {
    const source = await readFile(PUBLIC_MODULE, 'utf8')
    expect(exportedFunctions(source)).toEqual(['loadSharedConversation'])
  })

  it('is a "use server" module, so the scan is about the right kind of file', async () => {
    const source = await readFile(PUBLIC_MODULE, 'utf8')
    // Without the directive it is not an RPC at all and this pin would be
    // guarding something that no longer exists.
    expect(source).toContain("'use server'")
  })

  it('imports nothing from the auth layer', async () => {
    const source = code(await readFile(PUBLIC_MODULE, 'utf8'))
    const imports = [...source.matchAll(/^import[^\n]*?from\s+'([^']+)'/gm)].map((m) => m[1])
    // The token is the authorization here. An auth import would mean the answer
    // depends on who is asking, which is a different feature from the one this
    // module implements — and the way a public page starts leaking a signed-in
    // caller's data.
    expect(imports.filter((p) => p.includes('/auth/') || p.endsWith('/auth'))).toEqual([])
    expect(source).not.toContain('getAuthenticatedUser')
    expect(source).not.toContain('requireUser')
    expect(source).not.toContain('BYPASS_USER')
  })

  it('never selects the owner out of the row it loads', async () => {
    const source = code(await readFile(PUBLIC_MODULE, 'utf8'))
    expect(source).not.toContain('userId')
    expect(source).not.toContain('user_id')
  })
})

describe('the owner-scoped surface beside it', () => {
  it('resolves the caller in every exported action', async () => {
    const source = code(await readFile(OWNER_MODULE, 'utf8'))
    const names = exportedFunctions(source)
    // Sanity: the scan found a real module rather than an empty string.
    expect(names.length).toBeGreaterThan(5)

    const gated = gatedFunctions(source)
    const ungated = names.filter((n) => !gated.has(n))

    // `getAgentList` returns registry metadata and holds no user data — it is
    // the one export that legitimately needs no caller. Listing it here is the
    // deliberate act that adding another one would also require.
    expect(ungated).toEqual(['getAgentList'])
    // And the three share actions are inside the gated set, not merely absent
    // from the ungated one — an export the scan failed to SEE would satisfy the
    // assertion above while being wide open.
    expect(gated.has('shareConversation')).toBe(true)
    expect(gated.has('unshareConversation')).toBe(true)
    expect(gated.has('getShareToken')).toBe(true)
  })
})
