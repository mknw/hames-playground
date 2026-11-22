// @vitest-environment node
/**
 * The guard that keeps test runs off the live Postgres.
 *
 * On a developer machine `localhost:5432` is the live compose stack. Agent runs
 * started without `TEST_DATABASE_URL` kept falling back to it, and Orca now
 * copies the repo-root `.env` (the password) into every new worktree. These pin
 * the four outcomes of `resolveTestDatabase()`: refuse, the explicit URL, the
 * opted-in compose Postgres, and CI's "no database" (skip). The last block pins
 * what a DB-backed test does without a database: skip, or fail where one is
 * required.
 *
 * Every case passes its own `env` and its own temporary checkout, so nothing
 * here depends on, or reaches, the machine's real Postgres or the owner's
 * `app/.env`.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { parse } from 'yaml'
import ts from 'typescript'
import {
  ALLOW_LOCAL_DB,
  REQUIRE_DB,
  noDatabaseUrl,
  resolveTestDatabase,
  skipWithoutDatabase,
} from './test-database'

/** A throwaway checkout: a root holding `app/`, with an optional `app/.env`. */
function checkout(appEnv?: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'test-db-guard-'))
  mkdirSync(path.join(root, 'app'))
  if (appEnv !== undefined) writeFileSync(path.join(root, 'app', '.env'), appEnv)
  return root
}

const PRIVATE_URL = 'postgresql://postgres:test@127.0.0.1:55439/hames_test'

/** The refusal's message for `checkout`, failing the test if it does not throw. */
function refusalIn(root: string, env: Record<string, string> = {}): string {
  try {
    resolveTestDatabase('hames_test', { env, checkout: root })
  } catch (err) {
    return (err as Error).message
  }
  throw new Error('expected resolveTestDatabase to refuse')
}

describe('resolveTestDatabase: no URL and no opt-in refuses', () => {
  it('throws instead of falling back to localhost:5432, and says how to choose', () => {
    const root = checkout()
    const resolve = () => resolveTestDatabase('hames_test', { env: {}, checkout: root })
    expect(resolve).toThrow(
      /Refusing to fall back to the Postgres on localhost:5432 for hames_test/,
    )
    // The three ways out are in the message itself, so a lane that hits it does
    // not need to go and find the docs.
    expect(resolve).toThrow(
      /docker run --rm -d .* -p 55439:5432 .* pgvector\/pgvector:0\.8\.0-pg16-bookworm/,
    )
    expect(resolve).toThrow(/TEST_DATABASE_URL=postgresql:\/\/postgres:test@127\.0\.0\.1:55439/)
    expect(resolve).toThrow(`${ALLOW_LOCAL_DB}='<absolute path of your own primary checkout>'`)
    expect(resolve).toThrow(/Agents and lanes: use the private Postgres above, and never add this/)
    expect(resolve).toThrow(/CI=1 pnpm test:run/)
  })

  it('hands a lane no opt-in it could paste to let itself in', () => {
    // The reader is an agent in a lane, and the cheapest way out of an error is
    // to paste the line it prints. So: this checkout's path appears nowhere in
    // the message, and every opt-in value the message shows is refused when the
    // lane writes it into its own app/.env.
    const owner = checkout()
    const envs: Record<string, string>[] = [{}, { [ALLOW_LOCAL_DB]: owner }]
    for (const env of envs) {
      const lane = checkout()
      const message = refusalIn(lane, env)
      expect(message).not.toContain(lane)
      expect(message).not.toContain(realpathSync(lane))

      // A quoted value whole (the placeholder has spaces), else up to whitespace.
      const shown = [
        ...message.matchAll(new RegExp(`${ALLOW_LOCAL_DB}=(?:'([^']*)'|(\\S+))`, 'g')),
      ].map((m) => m[1] ?? m[2])
      expect(shown.length, 'the message no longer shows an opt-in line at all').toBeGreaterThan(0)
      for (const value of shown) {
        writeFileSync(path.join(lane, 'app', '.env'), `${ALLOW_LOCAL_DB}='${value}'\n`)
        expect(() => resolveTestDatabase('hames_test', { env: {}, checkout: lane }), value).toThrow(
          /Refusing to fall back/,
        )
      }
    }
  })

  it('also refuses for the unit suite when CI is absent or explicitly off', () => {
    const root = checkout()
    for (const CI of [undefined, '', 'false', '0']) {
      expect(
        () => resolveTestDatabase('hames_test', { skipInCi: true, env: { CI }, checkout: root }),
        `CI=${String(CI)}`,
      ).toThrow(/Refusing to fall back/)
    }
  })
})

describe('resolveTestDatabase: an explicit TEST_DATABASE_URL proceeds', () => {
  it('uses the URL as given', () => {
    expect(
      resolveTestDatabase('hames_test', {
        env: { TEST_DATABASE_URL: PRIVATE_URL },
        checkout: checkout(),
      }),
    ).toEqual({ source: 'explicit', url: PRIVATE_URL })
  })

  it('wins over CI and over an opt-in, so naming a database is always enough', () => {
    const root = checkout()
    expect(
      resolveTestDatabase('hames_test', {
        skipInCi: true,
        env: { TEST_DATABASE_URL: PRIVATE_URL, CI: 'true', [ALLOW_LOCAL_DB]: root },
        checkout: root,
      }),
    ).toEqual({ source: 'explicit', url: PRIVATE_URL })
  })
})

describe('resolveTestDatabase: the opt-in proceeds, in its own checkout only', () => {
  function expectLocal(db: { source: string; url: string }, database: string): void {
    expect(db.source).toBe('local')
    const url = new URL(db.url)
    expect(url.host).toBe('localhost:5432')
    expect(url.pathname).toBe(`/${database}`)
  }

  it('from the environment', () => {
    const root = checkout()
    expectLocal(
      resolveTestDatabase('hames_test_apppath', {
        env: { [ALLOW_LOCAL_DB]: root },
        checkout: root,
      }),
      'hames_test_apppath',
    )
  })

  it('from app/.env, which vitest does not load on its own', () => {
    const root = checkout()
    writeFileSync(path.join(root, 'app', '.env'), `${ALLOW_LOCAL_DB}='${root}'\n`)
    expectLocal(resolveTestDatabase('hames_test', { env: {}, checkout: root }), 'hames_test')
  })

  it('compares real paths, so another spelling of the same checkout still matches', () => {
    // An explicit symlink, rather than relying on macOS's tmpdir being one: on
    // Linux CI that would make the two spellings identical and the test vacuous.
    const root = checkout()
    const link = path.join(mkdtempSync(path.join(tmpdir(), 'test-db-link-')), 'checkout')
    symlinkSync(root, link)
    // The opt-in names the link; the checkout is the target.
    expectLocal(
      resolveTestDatabase('hames_test', { env: { [ALLOW_LOCAL_DB]: `${link}/` }, checkout: root }),
      'hames_test',
    )
    // The checkout is reached through the link; the opt-in names the target.
    expectLocal(
      resolveTestDatabase('hames_test', { env: { [ALLOW_LOCAL_DB]: root }, checkout: link }),
      'hames_test',
    )
  })

  it('refuses a relative opt-in, which names whatever checkout the run is in', () => {
    // A relative value resolves against the cwd, which is the running checkout's
    // app/. So `..` in a copied app/.env would name every lane it lands in.
    // Both are string results only: nothing here connects.
    const cwdCheckout = path.resolve('..')
    expect(() =>
      resolveTestDatabase('hames_test', { env: { [ALLOW_LOCAL_DB]: '..' }, checkout: cwdCheckout }),
    ).toThrow(`${ALLOW_LOCAL_DB} is '..', which does not name this checkout`)

    const root = checkout()
    const relative = path.relative(process.cwd(), root)
    expect(path.isAbsolute(relative)).toBe(false)
    writeFileSync(path.join(root, 'app', '.env'), `${ALLOW_LOCAL_DB}='${relative}'\n`)
    expect(() => resolveTestDatabase('hames_test', { env: {}, checkout: root })).toThrow(
      /which does not name this checkout/,
    )
  })

  it("refuses an opt-in copied from another checkout (an Orca worktree's app/.env)", () => {
    const owner = checkout()
    const lane = checkout(`${ALLOW_LOCAL_DB}=${owner}\n`)
    expect(() => resolveTestDatabase('hames_test', { env: {}, checkout: lane })).toThrow(
      `${ALLOW_LOCAL_DB} is '${owner}', which does not name this checkout`,
    )
  })

  it('refuses a boolean opt-in, because a flag travels into every lane that copies it', () => {
    const root = checkout()
    for (const flag of ['1', 'true']) {
      expect(() =>
        resolveTestDatabase('hames_test', { env: { [ALLOW_LOCAL_DB]: flag }, checkout: root }),
      ).toThrow(/which does not name this checkout/)
    }
  })
})

describe('resolveTestDatabase: CI with no database skips', () => {
  it('gives the unit suite a URL that reaches no server', async () => {
    const db = resolveTestDatabase('hames_test', {
      skipInCi: true,
      env: { CI: 'true' },
      checkout: checkout(),
    })
    expect(db).toEqual({ source: 'none', url: noDatabaseUrl('hames_test') })

    // The skip is only as safe as this URL. A real client against it fails on
    // a missing Unix socket: no TCP connection, no DNS lookup, nothing to log
    // in to. The DB-backed suites read that failure as "skip".
    const client = new pg.Client({ connectionString: db.url })
    await expect(client.connect()).rejects.toMatchObject({ code: 'ENOENT' })
    await client.end().catch(() => {})
  })

  it('does not skip for the e2e suites, which cannot run without a database', () => {
    expect(() =>
      resolveTestDatabase('hames_test_apppath', { env: { CI: '1' }, checkout: checkout() }),
    ).toThrow(/Refusing to fall back/)
  })

  it('ignores a copied opt-in under CI rather than using it', () => {
    const owner = checkout()
    const lane = checkout(`${ALLOW_LOCAL_DB}=${owner}\n`)
    expect(
      resolveTestDatabase('hames_test', { skipInCi: true, env: { CI: '1' }, checkout: lane })
        .source,
    ).toBe('none')
  })
})

/** Shared by the real-tree scan and the source mutations below.
 * Parse code so comments/literals cannot supply a hook, and dot/bracket member
 * access has the same meaning. This checks the suite's direct Vitest idiom,
 * not arbitrary JavaScript control flow or aliases.
 */
function databaseSkipPolicyViolations(source: string, filename = 'database.test.ts'): string[] {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  const violations: string[] = []
  let guarded = false
  const named = (node: ts.Node | undefined, name: string): boolean =>
    !!node && ts.isIdentifier(node) && node.text === name
  const unwrap = (node: ts.Expression): ts.Expression => {
    while (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node)
    ) {
      node = node.expression
    }
    return node
  }
  const member = (node: ts.Node): string | undefined => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text
    if (ts.isElementAccessExpression(node)) {
      const key = unwrap(node.argumentExpression)
      if (ts.isStringLiteralLike(key)) return key.text
    }
  }
  const finalName = (node: ts.Expression): string | undefined => {
    node = unwrap(node)
    return ts.isIdentifier(node) ? node.text : member(node)
  }
  function callbacks(node: ts.Expression): (ts.ArrowFunction | ts.FunctionExpression)[] {
    node = unwrap(node)
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return [node]
    return ts.isCallExpression(node) ? node.arguments.flatMap(callbacks) : []
  }
  const isGuardCall = (node: ts.Node, context: ts.BindingName): boolean =>
    ts.isCallExpression(node) &&
    named(node.expression, 'skipWithoutDatabase') &&
    ts.isIdentifier(context) &&
    named(node.arguments[0], context.text) &&
    named(node.arguments[1], 'dbAvailable') &&
    node.arguments.length === 2

  function inspectHooks(statements: ts.NodeArray<ts.Statement>): void {
    for (const statement of statements) {
      if (!ts.isExpressionStatement(statement)) continue
      const call = unwrap(statement.expression)
      if (!ts.isCallExpression(call)) continue
      // A wrapper with several callbacks does not establish which one runs.
      const candidates = callbacks(call)
      const fn = candidates.length === 1 ? candidates[0] : undefined
      if (!fn) continue
      if (finalName(call.expression) === 'describe' && ts.isBlock(fn.body)) {
        inspectHooks(fn.body.statements)
      }
      if (named(call.expression, 'beforeEach') && fn.parameters[0]) {
        const body = fn.body
        // Require a direct helper call in a registered hook. Coverage remains
        // file-global: this does not prove a hook for each describe block.
        const statements = ts.isBlock(body) ? body.statements : [body]
        for (const statement of statements) {
          // Setup calls may precede the guard, but an earlier return or
          // conditional makes reachability uncertain and needs inspection.
          const expression = ts.isExpressionStatement(statement) ? statement.expression : statement
          if (isGuardCall(expression, fn.parameters[0].name)) guarded = true
          if (!ts.isExpressionStatement(statement)) break
        }
      }
    }
  }
  function contextBypass(node: ts.Node, context?: string): boolean {
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false
    const owner = finalName(node.expression)
    return (
      !!owner &&
      (owner.endsWith('ctx') || owner === context) &&
      (member(node) === 'skip' ||
        (ts.isElementAccessExpression(node) && member(node) === undefined))
    )
  }
  function inspectTest(node: ts.Node, context?: string): void {
    if (contextBypass(node, context)) violations.push('database test bypasses the guard')
    if (
      ts.isIfStatement(node) &&
      ts.isPrefixUnaryExpression(node.expression) &&
      node.expression.operator === ts.SyntaxKind.ExclamationToken &&
      named(node.expression.operand, 'dbAvailable') &&
      (ts.isReturnStatement(node.thenStatement) ||
        (ts.isBlock(node.thenStatement) &&
          node.thenStatement.statements.some(ts.isReturnStatement)))
    ) {
      violations.push('database test returns without asserting')
    }
    ts.forEachChild(node, (child) => inspectTest(child, context))
  }
  function visit(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const property = member(node)
      if (
        (['it', 'test', 'describe'].includes(finalName(node.expression) ?? '') &&
          ['skip', 'skipIf', 'runIf', 'todo'].includes(property ?? '')) ||
        contextBypass(node)
      ) {
        violations.push('database test bypasses the guard')
      }
    }
    if (ts.isCallExpression(node) && ['it', 'test'].includes(finalName(node.expression) ?? '')) {
      for (const fn of callbacks(node)) {
        const context = fn.parameters[0]?.name
        inspectTest(fn.body, context && ts.isIdentifier(context) ? context.text : undefined)
      }
    }
    ts.forEachChild(node, visit)
  }
  inspectHooks(tree.statements)
  visit(tree)
  if (!guarded) violations.push('missing database guard hook')
  return violations
}

const guardedDatabaseTest = `
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))
  it('queries', async (ctx) => { await query('SELECT 1') })
`

describe('database skip source guard mutations (#500)', () => {
  it('accepts the executable database guard hook', () => {
    expect(databaseSkipPolicyViolations(guardedDatabaseTest)).toEqual([])
  })

  it('accepts hooks directly inside nested describe callbacks', () => {
    expect(
      databaseSkipPolicyViolations(
        `vitest['describe']('outer', () => { describe('inner', () => { ${guardedDatabaseTest} }) })`,
      ),
    ).toEqual([])
  })

  it('parses JSX using the scanned filename', () => {
    const source = `${guardedDatabaseTest}
      it('renders', (ctx) => {
        const el = <p>press \` to start</p>
        ctx.skip()
      })
      const hint = \`x\`
    `
    expect(databaseSkipPolicyViolations(source, 'temporary.test.tsx')).toContain(
      'database test bypasses the guard',
    )
    expect(
      databaseSkipPolicyViolations(source.replace('ctx.skip()', ''), 'temporary.test.tsx'),
    ).toEqual([])
  })

  it('accepts a multiline block hook and ignores quoted skip examples', () => {
    const source =
      guardedDatabaseTest.replace(
        'beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))',
        `beforeEach((ctx) => {
        resetMocks()
        skipWithoutDatabase(
          ctx,
          dbAvailable,
        )
      })`,
      ) + `\nconst example = "ctx.skip() and it.skip('example')"`
    expect(databaseSkipPolicyViolations(source)).toEqual([])
  })

  it.each([
    'ctx.skip()',
    'ctx["skip"]()',
    'ctx[`skip`]()',
    'it.skip("query", () => {})',
    'it["runIf"](dbAvailable)("query", () => {})',
    'test.skipIf(!dbAvailable)("query", () => {})',
    'describe.todo("query")',
    'it("query", () => { if (!dbAvailable) return; query("SELECT 1") })',
    'test("query", async () => { if (!dbAvailable) { return }; await query("SELECT 1") })',
    // Shapes the lexical scan refused before #500 (a namespace import, a context
    // not named `ctx`, an early return one block or one wrapper deep).
    'vitest.it.skip("query", () => {})',
    'vitest.describe.skipIf(true)("query", () => {})',
    'vitest.it("query", async () => {\n  if (!dbAvailable) return\n})',
    'it("query", (_ctx) => { _ctx.skip() })',
    'it("query", (t) => { t.ctx.skip() })',
    'it("query", async () => { try {\n  if (!dbAvailable) return\n} finally {} })',
    'it("query", wrap(async () => {\n  if (!dbAvailable) return\n}))',
    'it("query", (async () => {\n  if (!dbAvailable) return\n}))',
    // A bracket key that is a string only after a wrapper or an expression.
    'ctx[("skip")]()',
    'ctx["skip" as const]()',
    'ctx["sk" + "ip"]()',
    'const key = "skip"; ctx[key]()',
    'vitest["it"]["skip"]("query", () => {})',
    'vitest.test.skip("query", () => {})',
    'vitest["test"]("query", () => { if (!dbAvailable) return })',
    'vitest["describe"]["runIf"](true)("query", () => {})',
    'dbctx.skip()',
    'opts.ctx["skip"]()',
    'it("query", (context) => { context.skip() })',
    'test("query", (t) => { t["skip"]() })',
    'it("query", (t) => { const key = "skip"; t[key]() })',
    'ctx["skip" satisfies string]()',
    'ctx[`sk${"ip"}`]()',
    // A wrapper may receive setup and the callback it returns as separate arguments.
    'function wrap<T>(_setup: unknown, body: T): T { return body }; it("query", wrap(() => {}, async () => {\n  if (!dbAvailable) return\n}))',
    'function wrap<T>(_setup: unknown, body: T): T { return body }; it("query", wrap(() => {}, (context: { skip: () => void }) => { context.skip() }))',
    'it("query", () => { for (;;) { if (!dbAvailable) return } })',
    'it("query", () => { while (true) { if (!dbAvailable) return } })',
    'it("query", () => { if (true) { if (!dbAvailable) return } })',
  ])('keeps bypass refused: %s', (bypass) => {
    expect(databaseSkipPolicyViolations(guardedDatabaseTest + bypass).length).toBeGreaterThan(0)
  })

  it.each([
    'const unused = () => skipWithoutDatabase(ctx, dbAvailable)',
    'beforeEach((ctx) => { const unused = () => skipWithoutDatabase(ctx, dbAvailable) })',
    'beforeEach((ctx) => { if (false) skipWithoutDatabase(ctx, dbAvailable) })',
    'beforeEach((ctx) => { return "skipWithoutDatabase(ctx, dbAvailable)" })',
    'beforeEach((ctx) => { return; skipWithoutDatabase(ctx, dbAvailable) })',
    // The hook itself registered from code that never runs.
    'const unused = () => beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))',
    'if (false) beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))',
    'function never() { beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable)) }',
    'false && beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))',
    'function wrap<T>(_setup: unknown, body: T): T { return body }; beforeEach(wrap((ctx: { skip: () => void }) => skipWithoutDatabase(ctx, dbAvailable), () => {}))',
    'describe("query", () => { if (false) beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable)) })',
  ])('requires the helper to run in the hook: %s', (decoy) => {
    const source = guardedDatabaseTest.replace(
      'beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))',
      decoy,
    )
    expect(databaseSkipPolicyViolations(source).length).toBeGreaterThan(0)
  })

  it.each([
    ["ctx['skip']()", guardedDatabaseTest.replace("await query('SELECT 1')", "ctx['skip']()")],
    [
      'comment decoy',
      guardedDatabaseTest.replace(
        'beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))',
        '// skipWithoutDatabase(ctx, dbAvailable)',
      ),
    ],
    [
      'string decoy',
      guardedDatabaseTest.replace(
        'beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))',
        'const decoy = "skipWithoutDatabase(ctx, dbAvailable)"',
      ),
    ],
    [
      'template decoy',
      guardedDatabaseTest.replace(
        'beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))',
        'const decoy = `skipWithoutDatabase(ctx, dbAvailable)`',
      ),
    ],
  ])('rejects %s', (_name, source) => {
    expect(databaseSkipPolicyViolations(source).length).toBeGreaterThan(0)
  })
})

describe('skipWithoutDatabase: what a DB-backed test does with no database', () => {
  const ctx = () => ({ skip: vi.fn() })

  it('neither skips nor fails when the probe reached Postgres', () => {
    for (const env of [{}, { [REQUIRE_DB]: '1' }]) {
      const c = ctx()
      expect(() => skipWithoutDatabase(c, true, env)).not.toThrow()
      expect(c.skip).not.toHaveBeenCalled()
    }
  })

  it('skips, rather than passing while asserting nothing, when it did not', () => {
    const c = ctx()
    skipWithoutDatabase(c, false, {})
    expect(c.skip).toHaveBeenCalledOnce()
  })

  it('fails instead of skipping where a database is required', () => {
    const c = ctx()
    expect(() => skipWithoutDatabase(c, false, { [REQUIRE_DB]: '1' })).toThrow(
      `${REQUIRE_DB} is set, so a DB-backed test may not skip`,
    )
    expect(c.skip).not.toHaveBeenCalled()
  })

  it("is required in CI's postgres job, so a skip there fails the job", () => {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
    const ci = parse(readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8')) as {
      jobs: Record<string, { env?: Record<string, string> }>
    }
    expect(ci.jobs.postgres.env?.[REQUIRE_DB]).toBe('1')
  })

  it('reads the variable from the process environment by default', () => {
    vi.stubEnv(REQUIRE_DB, '1')
    try {
      expect(() => skipWithoutDatabase(ctx(), false)).toThrow(REQUIRE_DB)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('is the only way a test file on the real database client skips', () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const dbFiles = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((f) => /(^|\/)__tests__\/.*\.(test|spec)\.tsx?$/.test(f))
      .map((f) => ({ f, s: readFileSync(path.join(src, f), 'utf8') }))
      .filter(
        ({ s }) =>
          /db\/client\.server'/.test(s) &&
          !/vi\.mock\(\s*'[^']*db\/client\.server'/.test(s) &&
          // a file that mocks `pg` itself never reaches a database
          !/vi\.mock\(\s*'pg'/.test(s),
      )
    // Keep a nonempty inventory floor so a clean pass is not "scanned nothing".
    expect(dbFiles.length).toBeGreaterThanOrEqual(10)
    for (const { f, s } of dbFiles) {
      expect(databaseSkipPolicyViolations(s, f), f).toEqual([])
    }
  })
})

describe('explicit targets cannot bypass the live-server/name guard (#432 row 8)', () => {
  it.each([
    'postgresql://x:x@localhost:5432/hames_test',
    'postgresql://x:x@127.0.0.1/hames_test',
    'postgresql://x:x@[::1]:5432/hames_test',
    'postgresql://x:x@postgres:5432/hames_test',
    'postgresql://x:x@localhost.:5432/hames_test',
    'postgresql://x:x@127.1:5432/hames_test',
    'postgresql://x:x@127.0.0.2:5432/hames_test',
    'postgresql:///hames_test',
    'postgresql://x:x@%6cocalhost:5432/hames_test',
    'postgresql://x:x@%6Cocalhost:5432/hames_test',
    'postgresql://x:x@%70ostgres:5432/hames_test',
    'postgresql://x:x@%31%32%37.0.0.1:5432/hames_test',
    'postgresql://x:x@2130706433:5432/hames_test',
    'postgresql://x:x@0x7f000001:5432/hames_test',
    'postgresql://x:x@0:5432/hames_test',
    'postgresql://x:x@[::]:5432/hames_test',
    'postgresql://x:x@hames-postgres:5432/hames_test',
    'postgresql://x:x@host.docker.internal:5432/hames_test',
    'postgresql://x:x@throwaway.example.com/hames_test',
    'postgresql://x:x@throwaway.example.com:5432/hames_test',
    'postgresql://x:x@%6Cocalhost:55439/hames_test',
    'postgresql://x:x@%ZZ:55439/hames_test',
    'postgresql://x:x@127.0.0.1:55439/hames',
    'postgresql://x:x@127.0.0.1:55439/app_dev',
    'postgresql://x:x@127.0.0.1:55439/hames_test?host=postgres',
    'postgresql://x:x@127.0.0.1:55439/hames_test?dbname=hames',
    'https://example.com/hames_test',
    'not a URL',
  ])('refuses %s before any connection', (url) => {
    expect(() =>
      resolveTestDatabase('hames_test', { env: { TEST_DATABASE_URL: url }, checkout: checkout() }),
    ).toThrow(/Refusing/)
  })

  it.each([
    'postgresql:///hames_test',
    'postgresql://x:x@%6cocalhost:5432/hames_test',
    'postgresql://x:x@%ZZ:55439/hames_test',
  ])('refuses missing or encoded hosts even with the owner exception: %s', (url) => {
    const root = checkout()
    expect(() =>
      resolveTestDatabase('hames_test', {
        env: { TEST_DATABASE_URL: url, [ALLOW_LOCAL_DB]: root },
        checkout: root,
      }),
    ).toThrow(/host/)
  })

  it.each([
    'localhost',
    'postgres',
    '127.0.0.1',
    '2130706433',
    '0x7f000001',
    '0',
    '[::]',
    'hames-postgres',
    'host.docker.internal',
  ])('keeps owner-opted-in test names and refuses non-test names on %s', (host) => {
    const root = checkout()
    for (const database of ['test', 'hames_test', 'hames_test_browser']) {
      const url = `postgresql://x:x@${host}:5432/${database}`
      expect(
        resolveTestDatabase('hames_test', {
          env: { TEST_DATABASE_URL: url, [ALLOW_LOCAL_DB]: root },
          checkout: root,
        }).url,
      ).toBe(url)
    }
    for (const owner of [false, true]) {
      for (const database of ['hames', 'app_dev', 'postgres']) {
        expect(() =>
          resolveTestDatabase('hames_test', {
            env: {
              TEST_DATABASE_URL: `postgresql://x:x@${host}:5432/${database}`,
              ...(owner ? { [ALLOW_LOCAL_DB]: root } : {}),
            },
            checkout: root,
          }),
        ).toThrow(/non-test/)
      }
    }
  })

  it('keeps query overrides and near-sentinel non-test targets refused even for the owner', () => {
    const root = checkout()
    for (const owner of [false, true]) {
      for (const url of [
        'postgresql://x:x@localhost:55439/hames_test?host=postgres',
        'postgresql://x:x@localhost:55439/hames_test?dbname=hames',
        'postgresql://x:x@127.0.0.2:59999/x',
        'postgresql://x:x@127.0.0.1:59998/x',
      ]) {
        expect(() =>
          resolveTestDatabase('hames_test', {
            env: { TEST_DATABASE_URL: url, ...(owner ? { [ALLOW_LOCAL_DB]: root } : {}) },
            checkout: root,
          }),
        ).toThrow(/Refusing/)
      }
    }
  })

  it('keeps the explicit dead-port sentinel accepted', () => {
    const url = 'postgresql://x:x@127.0.0.1:59999/x'
    expect(
      resolveTestDatabase('hames_test', { env: { TEST_DATABASE_URL: url }, checkout: checkout() })
        .url,
    ).toBe(url)
  })

  it('keeps the owner-local exception checkout-bound and test-name-only', () => {
    const root = checkout()
    const env = {
      [ALLOW_LOCAL_DB]: root,
      TEST_DATABASE_URL: 'postgresql://x:x@localhost:5432/hames_test',
    }
    expect(resolveTestDatabase('hames_test', { env, checkout: root }).source).toBe('explicit')
    expect(() => resolveTestDatabase('hames_test', { env, checkout: checkout() })).toThrow(
      /Refusing/,
    )
    for (const database of ['hames', 'app_dev', 'postgres']) {
      expect(() =>
        resolveTestDatabase(database, { env: { [ALLOW_LOCAL_DB]: root }, checkout: root }),
      ).toThrow(/non-test/)
      expect(() =>
        resolveTestDatabase('hames_test', {
          env: { ...env, TEST_DATABASE_URL: `postgresql://x:x@localhost:5432/${database}` },
          checkout: root,
        }),
      ).toThrow(/non-test/)
    }
  })
})
