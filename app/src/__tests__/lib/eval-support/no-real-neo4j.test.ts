/**
 * The Eval never reads org or member data from a real Neo4j — the local compose
 * graph, the dev deployment's, or any env-configured one. Its org rows run on the
 * synthetic graph and its member directory is `SYNTHETIC_MEMBERS`
 * (`synthetic-org-graph.ts`), a fresh in-memory store per scenario.
 *
 * Three parts:
 *  1. A source scan over every module under `evals/` and `src/lib/eval-support/`:
 *     none imports a module that opens the Neo4j driver (computed, not listed) by
 *     any literal form — `import`/`from`/`import()`, quoted or backtick, `require()`,
 *     `createRequire(…)(…)` — and every call of the two roster factories whose
 *     DEFAULT reads the directory out of the graph passes `directory: 'none'`.
 *  2. The tool-dispatch path: a tool no registered transport owns falls through to
 *     the MCP gateway, whose `neo4j-cypher` reads the real graph. So the general-next
 *     driver's synthetic transport must own every tool the gateway catalog maps to
 *     `neo4j` — checked by running the driver's own `ownsTool` predicate.
 *  3. A runtime proof with the driver trapped: the factories as the Eval calls them,
 *     and the synthetic graph, never reach `getNeo4jDriver` — while the factories'
 *     default does, so the trap is shown to sit on the real path.
 *
 * Mutations that redden it: drop `{ directory: 'none' }` from either factory call in
 * `evals/general-next/driver.ts`; import `org-graph/roster-source.server` (or
 * `neo4j-driver`) from any eval module, including as ``import(`…`)`` or
 * `createRequire(import.meta.url)('neo4j-driver')`; let the driver's `ownsTool`
 * disown a neo4j tool (`&& !name.includes('neo4j')`) or drop one from `NAMESPACES`;
 * make `createEgressRoster` ignore `'none'`.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MCP_TOOL_CATALOG } from '@hames-ai/connectors/mcp-catalog'

const opened = vi.hoisted(() => ({ count: 0 }))
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
vi.mock('@hames-ai/connectors/neo4j/client', () => ({
  getNeo4jDriver: () => {
    opened.count++
    throw new Error('the Eval opened a real Neo4j driver')
  },
}))

const APP = resolve('.')
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'reports' ? [] : walk(path)
    return /\.(ts|tsx|mts)$/.test(name) ? [path] : []
  })

/** Every literal module specifier of a module: static and dynamic imports,
 *  `require()` and `createRequire(…)(…)`, quoted or in a backtick literal without
 *  an interpolation. */
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bcreateRequire\s*\([^)]*\)\s*\(\s*)(['"`])([^'"`$]+)\1/g
const specifiers = (source: string): string[] => [...source.matchAll(SPECIFIER)].map((m) => m[2])

/** A specifier as an absolute file under `app/`, or undefined for a package. */
function resolveLocal(from: string, spec: string): string | undefined {
  const base = spec.startsWith('~/')
    ? join(APP, 'src', spec.slice(2))
    : spec.startsWith('.')
      ? resolve(dirname(from), spec)
      : undefined
  if (!base) return undefined
  return [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find(
    (p) => existsSync(p) && statSync(p).isFile(),
  )
}

const DRIVER_PACKAGES = /^(neo4j-driver|@hames-ai\/connectors\/neo4j(\/.*)?)$/
/** The one module that imports a directory reader but reads it only when its
 *  caller does not declare `directory: 'none'` — which half 1 checks at every
 *  eval call site and half 2 checks at runtime. */
const GATED = join(APP, 'src/lib/harness-client/web-pseudonymiser.server.ts')
const GATED_FACTORIES = /\b(createEgressRoster|createWebPseudonymiser)\s*\(([^)]*)\)/g

/** Every app module that opens the Neo4j driver, directly or through another one. */
function graphReaders(): Set<string> {
  const files = walk(join(APP, 'src/lib'))
  const imports = new Map(
    files.map((f) => {
      const specs = specifiers(readFileSync(f, 'utf8'))
      return [f, { packages: specs, local: specs.map((s) => resolveLocal(f, s)) }] as const
    }),
  )
  const readers = new Set(
    files.filter((f) => imports.get(f)!.packages.some((s) => DRIVER_PACKAGES.test(s))),
  )
  for (let grew = true; grew;) {
    grew = false
    for (const f of files) {
      if (readers.has(f) || f === GATED) continue
      if (imports.get(f)!.local.some((p) => p && readers.has(p))) {
        readers.add(f)
        grew = true
      }
    }
  }
  return readers
}

const EVAL_MODULES = [...walk(join(APP, 'evals')), ...walk(join(APP, 'src/lib/eval-support'))]

describe('the Eval reads no real Neo4j for org data (source scan)', () => {
  it('finds the graph readers it guards against (the scan is not vacuous)', () => {
    const readers = [...graphReaders()].map((f) => relative(APP, f))
    expect(readers).toEqual(
      expect.arrayContaining([
        'src/lib/org-graph/roster-source.server.ts',
        'src/lib/org-graph/member-mentions.server.ts',
        'src/lib/org-graph/org-graph-store.server.ts',
      ]),
    )
    expect(readers).not.toContain(relative(APP, GATED))
    expect(EVAL_MODULES.length).toBeGreaterThan(20)
  })

  it('no eval module imports the Neo4j driver or a module that opens it', () => {
    const readers = graphReaders()
    const offenders = EVAL_MODULES.flatMap((f) =>
      specifiers(readFileSync(f, 'utf8'))
        .filter((s) => DRIVER_PACKAGES.test(s) || readers.has(resolveLocal(f, s) ?? ''))
        .map((s) => `${relative(APP, f)} imports ${s}`),
    )
    expect(offenders).toEqual([])
  })

  it("every eval call of a directory-reading roster factory declares directory: 'none'", () => {
    const calls = EVAL_MODULES.flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(GATED_FACTORIES)].map((m) => ({
        where: `${relative(APP, f)}: ${m[0]}`,
        none: /\bdirectory\s*:\s*'none'/.test(m[2]),
      })),
    )
    // The driver builds both, and the egress-gate scenario one more.
    expect(calls.length).toBeGreaterThanOrEqual(3)
    expect(calls.filter((c) => !c.none).map((c) => c.where)).toEqual([])
  })
})

describe('the Eval reads no real Neo4j for org data (tool dispatch)', () => {
  /** The driver's real `NAMESPACES`, `isSandboxTool` and `ownsTool`, executed as written
   *  (types stripped). src/ may not import evals/, so the blocks are read, not imported. */
  function driverOwnsTool(): {
    owns: (name: string) => boolean
    namespaces: Record<string, string>
  } {
    const src = readFileSync(join(APP, 'evals/general-next/driver.ts'), 'utf8')
    const pick = (re: RegExp, what: string) => {
      const m = re.exec(src)?.[1]
      if (!m) throw new Error(`driver.ts: cannot find ${what}`)
      return m.replace(/:\s*(string|Record<string, string>)\b/g, '')
    }
    const namespaces = pick(/const NAMESPACES[^=]*=\s*(\{[\s\S]*?\n\})/, 'NAMESPACES')
    const sandbox = pick(/const isSandboxTool\s*=\s*([^\n]+)/, 'isSandboxTool')
    const owns = pick(/\bownsTool:\s*(\([^)]*\)\s*=>[^\n]*?),?\n/, 'ownsTool')
    return runInNewContext(
      `const NAMESPACES = ${namespaces}; const isSandboxTool = ${sandbox};
       ({ owns: ${owns}, namespaces: NAMESPACES })`,
    )
  }

  it('the gateway catalog names neo4j tools (the check is not vacuous)', () => {
    const neo4jTools = Object.keys(MCP_TOOL_CATALOG).filter((t) => MCP_TOOL_CATALOG[t] === 'neo4j')
    expect(neo4jTools).toEqual(
      expect.arrayContaining(['get_neo4j_schema', 'read_neo4j_cypher', 'write_neo4j_cypher']),
    )
  })

  it('the synthetic transport owns every neo4j tool, so none falls through to the gateway', () => {
    const { owns, namespaces } = driverOwnsTool()
    const neo4jTools = Object.keys(MCP_TOOL_CATALOG).filter((t) => MCP_TOOL_CATALOG[t] === 'neo4j')
    expect(neo4jTools.filter((t) => !owns(t))).toEqual([])
    expect(neo4jTools.filter((t) => namespaces[t] !== 'neo4j')).toEqual([])
    // The predicate is live, not a constant: it disowns what the driver does not serve.
    expect(owns('sandbox_bash')).toBe(false)
    expect(owns('not_a_tool')).toBe(false)
  })

  it('the driver registers that transport', () => {
    const src = readFileSync(join(APP, 'evals/general-next/driver.ts'), 'utf8')
    expect(src).toMatch(/\bconst dispose = registerTransport\(transport\)/)
    expect(src).toMatch(/id: 'general-eval-synthetic-only'/)
  })
})

describe('the Eval reads no real Neo4j for org data (runtime, driver trapped)', () => {
  beforeEach(() => {
    opened.count = 0
  })

  it('the roster factories as the Eval builds them never open the driver', async () => {
    const { createEgressRoster, createWebPseudonymiser } =
      await import('../../../lib/harness-client/web-pseudonymiser.server')
    const payloads = [[{ displayName: 'Mira Cedar', mail: 'mira.cedar@example.com' }]]
    const egress = await createEgressRoster({ directory: 'none' })(payloads, 'hello')
    expect(egress.directory).toBe('none')
    await createWebPseudonymiser({ directory: 'none' })(payloads, 'hello')
    expect(opened.count).toBe(0)
  })

  it('the trap sits on the real path: the factories’ default does open it', async () => {
    const { createEgressRoster } =
      await import('../../../lib/harness-client/web-pseudonymiser.server')
    const egress = await createEgressRoster()([], 'hello')
    expect(egress.directory).toBe('unreadable')
    expect(opened.count).toBe(1)
  })

  it('the synthetic graph and member matcher never open it', async () => {
    const {
      createSyntheticOrgGraph,
      orgGraphSnapshot,
      syntheticMentionsMember,
      SYNTHETIC_MEMBERS,
    } = await import('../../../lib/eval-support/synthetic-org-graph')
    const store = createSyntheticOrgGraph(['members', 'theme-1'])
    const members = orgGraphSnapshot(store).nodes.filter((n) => n.label === 'Member')
    expect(members).toHaveLength(SYNTHETIC_MEMBERS.length)
    expect(syntheticMentionsMember(SYNTHETIC_MEMBERS[0].displayName)).toBe(true)
    expect(opened.count).toBe(0)
  })
})
