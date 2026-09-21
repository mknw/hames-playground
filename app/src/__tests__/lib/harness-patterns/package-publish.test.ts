/**
 * The packaging pin the pre-publish audit called the missing one (#225,
 * pre-publish audit, finding 11): the existing `package-conventions.test.ts`
 * pins the two cheapest conventions (prettier config, LICENSE/README beside
 * the manifest) and would not have caught any of the audit's four must-fix
 * findings. This test drives `pnpm pack` per workspace package and asserts
 * what a consumer actually receives, mechanically:
 *
 *   (a) the packed manifest — produced with `pnpm pack`, i.e. the artifact
 *       the publish path ships — contains no `workspace:` specifier in any
 *       dependency field: pnpm rewrites `workspace:^` to `^0.1.0` at pack
 *       time, and npm does NOT rewrite the protocol at all, which is why
 *       `npm publish` of a manifest still carrying `workspace:*` dies at
 *       every consumer's resolution with EUNSUPPORTEDPROTOCOL (audit
 *       finding 1). The companion assertion drives `npm publish --dry-run`
 *       and asserts it REFUSES — the guard is the belt to that brace.
 *   (a3) the cross-package edges ship as PEERS: no `@hames/*` entry survives
 *       in the packed `dependencies`, and every `@hames/*` peer packs as a
 *       real caret range. That is the rewrite (a) proves happened at all,
 *       read on the field it now has to happen in — `pnpm pack` rewrites
 *       `workspace:^` wherever it appears, but nothing else asserts the
 *       companion edges MOVED, and a revert of one manifest is invisible to
 *       every other assertion in this file (owner ruling 2026-09-22; the
 *       duplicate-instance rationale is on the pin in
 *       `package-conventions.test.ts`).
 *   (b) every manifest carries the `prepublishOnly` npm-vs-pnpm guard —
 *       the belt-and-braces that stops `npm publish` at the counter
 *       (finding 1's fix);
 *   (c) every explicit `exports` target exists in the packed file list
 *       (audit finding 11's (b));
 *   (d) every bare import specifier in a packed `.ts` file is declared in
 *       the packed manifest's `dependencies` or `peerDependencies` — the
 *       cytoscape class of defect: a type-only import that works in the
 *       workspace, is erased before `pnpm pack` sees it, and lands on a
 *       consumer's `tsc` as TS2307 (audit finding 3, and finding 11's (c)).
 *
 * The packed manifest is read from the real tarball, not the source
 * `package.json` — the whole point is to assert the artifact, the thing a
 * consumer resolves, which the source manifest can drift from. Packing runs
 * through pnpm because that is the publish path (`pnpm publish` packs the
 * same artifact); the npm path is pinned separately, by refusing it.
 *
 * Proven, not just green: the workspace mutations that redden each half are
 * on the record in the PR that shipped this file — reintroduce a
 * `workspace:*` (reddens (a)), reintroduce the `cytoscape` type-only import
 * (reddens (d)), drop a `prepublishOnly` script (reddens (b) and the
 * npm-refusal assertion). (a3)'s is on the PR that added it: move one
 * companion's `@hames/*` peer back under `dependencies` — the emptiness half
 * reddens for that package, and deleting the edge outright reddens the
 * non-vacuity half instead.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'

// `process.cwd()` is `app/` under vitest, the same anchor the other
// source-scan pins use.
const PACKAGES = resolve(process.cwd(), '../packages')

/** Every workspace member under `packages/` (the `packages/*` glob in
 * `pnpm-workspace.yaml`), by directory name — same enumeration rule as
 * `package-conventions.test.ts`, so a sixth package is checked for free. */
function workspacePackages(): string[] {
  return readdirSync(PACKAGES)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => statSync(join(PACKAGES, name)).isDirectory())
    .filter((name) => {
      try {
        return statSync(join(PACKAGES, name, 'package.json')).isFile()
      } catch {
        return false
      }
    })
    .sort()
}

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

interface Packed {
  /** The manifest as it SHIPS — read out of the tarball, not the source tree. */
  manifest: Record<string, unknown> & {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    scripts?: Record<string, string>
    exports?: Record<string, string>
  }
  /** Paths of every file in the tarball. */
  files: string[]
}

/** `pnpm pack` the package (the publish path — pnpm rewrites the workspace
 * protocol here, so this is the artifact a consumer actually installs) and
 * unpack it into a temp dir. */
function pack(name: string): Packed {
  const pkgDir = join(PACKAGES, name)
  const tmp = mkdtempSync(join(tmpdir(), 'pack-pin-'))
  try {
    execFileSync('pnpm', ['pack', '--pack-destination', tmp], {
      cwd: pkgDir,
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const tarball = readdirSync(tmp).find((f) => f.endsWith('.tgz'))
    expect(tarball, 'pnpm pack produced a tarball').toBeTruthy()
    execFileSync('tar', ['-xzf', join(tmp, tarball!), '-C', tmp], { timeout: 60_000 })
    return {
      manifest: JSON.parse(readFileSync(join(tmp, 'package', 'package.json'), 'utf8')),
      files: readdirSync(tmp, { recursive: true })
        .map(String)
        // entries arrive with the leading `package/` tar root — strip it
        .map((p) => p.replace(/^package\//, ''))
        .filter((p) => p.length > 0),
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** Bare import specifiers (no `node:`, relative, absolute, `data:`, `bun:`)
 * declared by a `.ts` source. Parsed with the TypeScript AST, not a regex —
 * the same specifiers appear in doc-comment prose and error strings
 * ("Use `import { b } from 'baml_client/async_client'"), and a regex pin
 * that reddens on prose is a pin nobody re-runs. */
function bareImports(src: string): string[] {
  const sf = ts.createSourceFile('packed.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const specs: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0]
      if (arg && ts.isStringLiteral(arg)) specs.push(arg.text)
    } else if (ts.isCallExpression(node) && node.expression.getText(sf).trim() === 'require') {
      const arg = node.arguments[0]
      if (arg && ts.isStringLiteral(arg)) specs.push(arg.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return specs.filter((spec) => !/^(node:|bun:|data:|\.\/|\.\.\/|\/|#)/.test(spec))
}

describe('packed artifact pin (pnpm pack — the publish path — what a consumer actually receives)', () => {
  const packages = workspacePackages()
  // One pack per package for the whole suite. `pnpm pack` is by far the
  // slowest thing here, and every assertion below reads the same artifact.
  const packedByName = new Map(packages.map((name) => [name, pack(name)]))

  it('there are packages to check, so the scan cannot pass vacuously', () => {
    expect(packages.length).toBeGreaterThanOrEqual(4)
    expect(packages).toContain('harness-patterns')
  })

  it('(a3, non-vacuity) the four companions each pack at least one @hames peer', () => {
    // (a3) is a pair of emptiness assertions, so it passes for a package with
    // no cross-package edge at all — including one whose edge was reverted to a
    // `dependency` AND dropped. This is the half that reddens on a revert:
    // packed here, not read off the source manifest, because the artifact is
    // what a consumer resolves.
    const withPeers = packages.filter(
      (name) =>
        Object.keys(packedByName.get(name)!.manifest.peerDependencies ?? {}).filter((spec) =>
          spec.startsWith('@hames/'),
        ).length > 0,
    )
    expect(withPeers.sort()).toEqual(['agents', 'connectors', 'harness-baml', 'sandbox'])
  })

  for (const name of packages) {
    describe(name, () => {
      const pkgDir = join(PACKAGES, name)
      const packed = packedByName.get(name)!

      it('(a0) every cross-package dependency spec is workspace:^ — the caret, not the exact pin', () => {
        // The SOURCE manifest is where the protocol is declared; pnpm rewrites
        // it at publish. `workspace:*` rewrites to an EXACT version, so the
        // first patch release of harness-patterns splits every consumer tree
        // into two copies of a package holding four module-level
        // AsyncLocalStorage singletons — the boundary stops applying silently
        // (pre-publish audit finding 2, the SD-1/SD-5 class).
        const source = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
          dependencies?: Record<string, string>
          peerDependencies?: Record<string, string>
          devDependencies?: Record<string, string>
        }
        const crossPackage = Object.entries({
          ...source.dependencies,
          ...source.peerDependencies,
          ...source.devDependencies,
        }).filter(([spec]) => spec.startsWith('@hames/'))
        // Vacuously true for the root package (no @hames deps) — fine.
        const offenders = Object.fromEntries(
          crossPackage.filter(([, range]) => range !== 'workspace:^'),
        )
        expect(
          offenders,
          'cross-package deps must be workspace:^: an exact pin (workspace:*) bakes the ' +
            'first patch release into a duplicate-instance hazard permanently',
        ).toEqual({})
      })

      it('(a) the packed manifest carries no `workspace:` specifier in any dependency field', () => {
        // Dependency VALUES only — the prepublishOnly guard's error message
        // legitimately contains the words `workspace:`, and this assertion
        // is about what a package manager tries to RESOLVE.
        const specifiers = [
          ...Object.values(packed.manifest.dependencies ?? {}),
          ...Object.values(packed.manifest.peerDependencies ?? {}),
          ...Object.values(packed.manifest.devDependencies ?? {}),
        ]
        const offenders = specifiers.filter((spec) => spec.includes('workspace:'))
        expect(
          offenders,
          'a workspace: specifier in the packed manifest fails every consumer install ' +
            'with EUNSUPPORTEDPROTOCOL; the publish path is `pnpm publish`, which ' +
            'rewrites `workspace:^` to a caret range — see the prepublishOnly guard',
        ).toEqual([])
      })

      it('(a3) cross-package edges pack as peers: none under dependencies, all real ranges', () => {
        const hamesDeps = Object.keys(packed.manifest.dependencies ?? {}).filter((spec) =>
          spec.startsWith('@hames/'),
        )
        expect(
          hamesDeps,
          'a cross-package edge must ship under `peerDependencies`: as a `dependency` a ' +
            'consumer can resolve a second copy of harness-patterns, and the module-level ' +
            'AsyncLocalStorage scopes stop applying silently rather than failing',
        ).toEqual([])

        // The packed peer ranges are the rewrite's OUTPUT. `workspace:` absence
        // is assertion (a); this asserts the range is one a consumer's resolver
        // can actually satisfy, i.e. that the rewrite produced a caret over a
        // released-looking version rather than a pin or an empty string.
        const peers = Object.entries(packed.manifest.peerDependencies ?? {}).filter(([spec]) =>
          spec.startsWith('@hames/'),
        )
        const malformed = peers.filter(([, range]) => !/^\^\d+\.\d+\.\d+(-[\w.]+)?$/.test(range))
        expect(
          Object.fromEntries(malformed),
          'pnpm rewrites `workspace:^` to a caret range at pack time — anything else here is ' +
            'either an unrewritten protocol or an exact pin that splits the consumer tree',
        ).toEqual({})
      })

      it('(a2) `npm publish --dry-run` REFUSES — the prepublishOnly guard fires', () => {
        // npm does not rewrite the workspace protocol, so it must never reach
        // the registry with this manifest. The guard turns npm publish into a
        // refused command at the counter. Safe to run here: the guard aborts
        // before npm packs or contacts the registry, and even with the guard
        // gone a --dry-run uploads nothing.
        let refused = false
        let stderr = ''
        try {
          execFileSync(NPM, ['publish', '--dry-run'], {
            cwd: pkgDir,
            encoding: 'utf8',
            timeout: 120_000,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        } catch (err) {
          refused = true
          stderr = String((err as { stderr?: string }).stderr ?? err)
        }
        expect(
          refused,
          'npm publish must be refused by the prepublishOnly guard — npm does not ' +
            'rewrite workspace: specifiers and would ship them literally, burning ' +
            'the version number permanently',
        ).toBe(true)
        expect(stderr).toMatch(/pnpm publish/)
      })

      it('(b) the manifest carries the npm-vs-pnpm prepublishOnly guard', () => {
        // The SOURCE manifest is what governs both runners (pnpm strips
        // scripts from the packed manifest — correct: consumers need none).
        const source = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
          scripts?: Record<string, string>
        }
        const guard = source.scripts?.prepublishOnly
        expect(guard, 'every publishable package refuses npm publish at the counter').toBeTruthy()
        expect(guard).toMatch(/npm-cli/)
        expect(guard).toMatch(/npm_config_user_agent/)
      })

      it('(c) every explicit exports target exists in the packed file list', () => {
        const exportsMap = packed.manifest.exports ?? {}
        const missing: string[] = []
        for (const [subpath, target] of Object.entries(exportsMap)) {
          if (subpath === './package.json') continue
          // Wildcards (`./*`) cannot be enumerated — the explicit entries
          // around them are what a broken allowlist actually loses.
          if (subpath.includes('*') || String(target).includes('*')) continue
          const file = String(target).replace(/^\.\//, '')
          if (!packed.files.includes(file)) missing.push(`${subpath} -> ${target}`)
        }
        expect(missing).toEqual([])
      })

      it('(d) every bare import in a packed .ts is declared in the packed manifest', () => {
        const declared = new Set(
          Object.keys({
            ...packed.manifest.dependencies,
            ...packed.manifest.peerDependencies,
          }),
        )
        const undeclared = new Map<string, string[]>()
        for (const file of packed.files.filter((f) => f.endsWith('.ts'))) {
          const src = readFileSync(join(PACKAGES, name, file), 'utf8')
          for (const spec of bareImports(src)) {
            const pkgName = spec.startsWith('@')
              ? spec.split('/').slice(0, 2).join('/')
              : spec.split('/')[0]
            if (!declared.has(pkgName)) {
              const files = undeclared.get(pkgName) ?? []
              files.push(file)
              undeclared.set(pkgName, files)
            }
          }
        }
        expect(
          [...undeclared.entries()].map(([spec, files]) => `${spec}: ${files.join(', ')}`),
          'a shipped .ts importing a package its own manifest does not declare breaks a ' +
            "consumer's tsc (TS2307) — these packages ship raw TypeScript, so the " +
            "consumer compiles the imports' FILES, not the workspace's node_modules",
        ).toEqual([])
      })
    })
  }
})
