/**
 * The 'use server' strip (the @hames/agents move, #225 PR-2).
 *
 * Seven of the nine agent definition files used to carry a top-level
 * `'use server'` directive while exporting only data consts and factories —
 * vestigial protection from before the `.server.ts`/`assertServerOnImport`
 * conventions (unlike title-generator and registry.server, whose comments
 * record a DELIBERATE absence). A published package cannot carry SolidStart
 * server-action semantics (#226 B4: framework-agnostic), so the move strips
 * them — the surface-REDUCING direction: per SD-13, stripping removes the
 * exported consts from any browser-reachable surface the directive might have
 * made them part of, and can only have shrunk the app's RPC map.
 *
 * Two pieces of evidence live here, both required by the move's spec:
 *   1. THE STRIP — no directive survives anywhere in the package source.
 *   2. THE CLOSURE — no client component imports anything from the seven
 *      agent-definition modules (or the package's `./agents` barrel at all):
 *      client code reaches agents only through the app's gated server actions
 *      (`getAgentList` etc.), never by importing a definition.
 *
 * The strip's risk was a broken app, not a new hole — `pnpm build` (app-path
 * e2e) verifies the app still boots after it. A REGRESSION here would be the
 * directive reappearing (a new export becoming an RPC by accident) or a
 * client import sneaking in (a definition module entering the client graph).
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// `process.cwd()` is `app/` under vitest (same anchor the other source-scan
// pins use); `import.meta.url` is not a file URL in this jsdom environment.
const APP_ROOT = resolve(process.cwd())
const AGENTS_DIR = resolve(APP_ROOT, '../packages/agents/agents')

/** The seven files that carried the directive before the move (the two
 *  exceptions — title-generator and graph-schema — deliberately never did;
 *  title-generator's comment records why). */
const STRIPPED = [
  'search.server.ts',
  'microsoft-365.server.ts',
  'neo4j-fewshots.server.ts',
  'sandbox-session.server.ts',
  'general.server.ts',
  'retriever-agent.server.ts',
  'flavoured-sandbox.server.ts',
]

/** A top-of-module directive, in either quote style. */
const DIRECTIVE = /^\s*['"]use server['"];?\s*(?:;)?\s*$/m

describe('the strip is complete', () => {
  it('no directive remains in any package file', () => {
    const offenders: string[] = []
    for (const f of readdirSync(AGENTS_DIR)) {
      if (!f.endsWith('.ts')) continue
      const text = readFileSync(join(AGENTS_DIR, f), 'utf8')
      if (DIRECTIVE.test(text)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })

  it('the seven files that used to carry one still exist (the strip did not drop them)', () => {
    const present = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.server.ts'))
    for (const f of STRIPPED) expect(present).toContain(f)
  })

  it('the strip is not a load-bearing regression: every moved module still guards itself', () => {
    // The directives were vestigial; the runtime guard that actually keeps a
    // module off the client is `assertServerOnImport`. Every .server.ts in the
    // package calls it at module load (title-generator's header documents the
    // reasoning) — so the strip removed nothing that was doing work.
    for (const f of readdirSync(AGENTS_DIR)) {
      if (!f.endsWith('.server.ts')) continue
      const text = readFileSync(join(AGENTS_DIR, f), 'utf8')
      expect(text, f).toMatch(/assertServerOnImport\(\)/)
    }
  })
})

describe('no client component imports a definition module', () => {
  /** Client-reachable trees: components, routes, and the client-safe lib
   *  modules (turn-stream, sse-client, api-client, graph-merge, …). The
   *  composition root's .server.ts modules MAY import the definitions — that
   *  is the sanctioned server-side path. */
  const CLIENT_DIRS = [
    join(APP_ROOT, 'src/components'),
    join(APP_ROOT, 'src/routes'),
    join(APP_ROOT, 'src/lib/turn-stream.ts'),
    join(APP_ROOT, 'src/lib/sse-client.ts'),
    join(APP_ROOT, 'src/lib/api-client.ts'),
    join(APP_ROOT, 'src/lib/graph-merge.ts'),
    join(APP_ROOT, 'src/lib/session-registry.ts'),
    join(APP_ROOT, 'src/lib/run-registry.ts'),
  ]

  /** Import specifiers that would drag a definition (or the definitions
   *  barrel) into a client module graph. The package ROOT barrel is
   *  client-safe and allowed; `./agents` (the definitions) is not. */
  const FORBIDDEN = ['@hames/agents/agents', '@hames/agents/agents/index']

  it('client trees never import the definitions barrel or a definition module', () => {
    const offenders: string[] = []
    for (const target of CLIENT_DIRS) {
      let paths: string[] = []
      try {
        paths = statSync(target).isDirectory() ? collectTsFiles(target) : [target]
      } catch {
        continue
      }
      for (const p of paths) {
        const text = readFileSync(p, 'utf8')
        for (const spec of FORBIDDEN) {
          if (text.includes(spec)) offenders.push(`${p} (${spec})`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

function collectTsFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(full)
    }
  }
  walk(dir)
  return out
}
