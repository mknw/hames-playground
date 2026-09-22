/**
 * The tutorials' code samples are compiled, not trusted — and compiled against
 * the surface a CONSUMER gets, not the one this monorepo happens to expose.
 *
 * `docs/tutorials/` is what an external developer copies first, and copied code
 * that does not compile is a bug with a byline. This file extracts every
 * `typescript` fence from every page there and compiles it against the real
 * package sources, the same trees `pnpm typecheck` covers.
 *
 * ## Why resolution goes through `exports` + `files`, not the source tree
 *
 * Binding ground rule from the packaging programme: a snippet must work for
 * someone who installed the TARBALL. "A snippet that works in this monorepo and
 * fails for a consumer is the failure class the whole packaging programme
 * exists to prevent." A resolver that maps `@hames-ai/x/anything` straight onto
 * `packages/x/anything.ts` cannot see that failure: it happily resolves a path
 * the `exports` map does not expose, or a file the `files` allowlist does not
 * ship. So {@link resolvePackageModule} below models the published surface —
 * the exports map (exact keys, then `./*` patterns, longest prefix wins) gated
 * by the files allowlist (directory entries recurse; `!` negates) — and only
 * then maps the survivor onto disk.
 *
 * This is a faithful STATIC model, not the tarball itself. The end-to-end truth
 * is `scripts/pack-smoke.sh`, which packs, installs into a scratch consumer and
 * evaluates every entry; that script is the packaging lane's and is the right
 * home for an execution-level check. What this pin buys is that the same
 * failure is caught in the unit layer, on every push, in under a second.
 *
 * ## Why a real compiler
 *
 * The fences must not merely name real symbols — the CALL SHAPES must exist
 * (`Tools()` takes a REQUIRED `namespaces` map; `withInjectionGuard` takes
 * `catalog` beside `namespaces`; `router` takes descriptions first and config
 * second). A compiler sees all of that; a key scan sees none of it.
 *
 * Diagnostics inside the package sources themselves are IGNORED — their
 * correctness is the rest of the suite's job; this test judges the fences.
 *
 * It deliberately does NOT execute them: a fence stands its host values up with
 * `declare const` where the real thing needs a container engine, an MCP gateway
 * or a document store. The wiring is what this pins; the runtime behaviour the
 * pages quote is covered by the suites that own it.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const TUTORIALS = path.join(REPO_ROOT, 'docs', 'tutorials')
const PACKAGES = path.join(REPO_ROOT, 'packages')

const PACKAGE_NAMES = [
  'harness-patterns',
  'harness-baml',
  'agents',
  'sandbox',
  'connectors',
] as const

/**
 * Pages a tutorial links that are shipped by a DIFFERENT, still-open PR.
 *
 * This list is self-destructing by construction: each entry asserts the target
 * is **still missing**, so the day that PR merges this test goes RED and names
 * the entry to delete. That is the point — an allowlist that silently outlives
 * its reason is how a dangling link becomes permanent.
 *
 * Sequencing (top-level coordinator, 2026-09-22): #381 merged first and #382's
 * delta reconciled it. The one entry this list ever held —
 * `hosting-the-harness.md`, owed by #382 — is gone because that page is here;
 * the list is deliberately kept (empty) rather than deleted, because the next
 * cross-PR link will want the same mechanism and rebuilding it from scratch is
 * how the reasoning gets lost.
 */
const PENDING_PAGES: Record<string, string> = {}

interface Fence {
  doc: string
  index: number
  heading: string
  code: string
}

/** Fences open on a bare ```typescript line and close on the next ``` line. */
function extractFences(): Fence[] {
  const fences: Fence[] = []
  for (const file of docPages()) {
    const lines = readFileSync(path.join(TUTORIALS, file), 'utf-8').split('\n')
    let heading = '(preamble)'
    // Per-DOC counter: a global one names a fence number the reader cannot find
    // in the document the message names (review finding F4).
    let inDoc = 0
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i].match(/^##\s+(.*)/)
      if (h) heading = h[1].trim()
      if (lines[i].trim() === '```typescript') {
        const close = lines.findIndex((l, j) => j > i && l.trim() === '```')
        if (close === -1)
          throw new Error(`${file}: unterminated typescript fence under "${heading}"`)
        fences.push({
          doc: file,
          index: ++inDoc,
          heading,
          code: lines.slice(i + 1, close).join('\n'),
        })
        i = close
      }
    }
  }
  return fences
}

function docPages(): string[] {
  return readdirSync(TUTORIALS)
    .filter((f) => f.endsWith('.md'))
    .sort()
}

// ============================================================================
// The published surface: exports map, gated by the files allowlist
// ============================================================================

interface Manifest {
  root: string
  exports: Record<string, string>
  files: string[]
}

const MANIFESTS: Record<string, Manifest> = Object.fromEntries(
  PACKAGE_NAMES.map((name) => {
    const root = path.join(PACKAGES, name)
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'))
    return [`@hames-ai/${name}`, { root, exports: pkg.exports ?? {}, files: pkg.files ?? [] }]
  }),
)

/**
 * npm `files` semantics, narrowed to the entry shapes these manifests use:
 * `*.ts` (root-level only — the glob does not cross a slash), a bare directory
 * name (recursive), an exact filename, and `!entry` negation.
 */
function shippedInTarball(manifest: Manifest, relative: string): boolean {
  let included = false
  for (const entry of manifest.files) {
    const negated = entry.startsWith('!')
    const pattern = negated ? entry.slice(1) : entry
    if (!matchesFilesEntry(pattern, relative)) continue
    if (negated) return false
    included = true
  }
  return included
}

function matchesFilesEntry(pattern: string, relative: string): boolean {
  if (pattern.startsWith('*.')) {
    // Root-level glob: no slash may appear in the path.
    return !relative.includes('/') && relative.endsWith(pattern.slice(1))
  }
  // A bare name is either the file itself or a directory carrying it.
  return relative === pattern || relative.startsWith(`${pattern}/`)
}

/**
 * Resolve an `@hames-ai/*` specifier the way a consumer's bundler does: through
 * the package's `exports` map only, then check the target actually ships.
 * Returns undefined when the specifier is not exposed — which is a FAILURE the
 * fence should see, not a reason to fall through to the source tree.
 */
function resolvePackageModule(specifier: string): string | undefined {
  for (const [name, manifest] of Object.entries(MANIFESTS)) {
    if (specifier !== name && !specifier.startsWith(`${name}/`)) continue
    const subpath = specifier === name ? '.' : `./${specifier.slice(name.length + 1)}`

    let target = manifest.exports[subpath]
    if (!target) {
      // Subpath patterns: longest literal prefix wins, as Node resolves them.
      let bestPrefix = -1
      for (const [key, value] of Object.entries(manifest.exports)) {
        const star = key.indexOf('*')
        if (star === -1) continue
        const prefix = key.slice(0, star)
        const suffix = key.slice(star + 1)
        if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue
        if (prefix.length <= bestPrefix) continue
        bestPrefix = prefix.length
        target = value.replace(
          '*',
          subpath.slice(prefix.length, subpath.length - (suffix.length || 0)),
        )
      }
    }
    if (!target) return undefined

    const relative = target.replace(/^\.\//, '')
    if (!shippedInTarball(manifest, relative)) return undefined
    const onDisk = path.join(manifest.root, relative)
    return existsSync(onDisk) ? onDisk : undefined
  }
  return undefined
}

/** Compile every fence as its own in-memory module; return per-fence diagnostics. */
function compileFences(fences: Fence[]): Map<Fence, string[]> {
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
    esModuleInterop: true,
    isolatedModules: true,
    // Every fence is its OWN module, even when it imports nothing.
    //
    // The virtual fence files share one directory, and TypeScript treats a file
    // with no import/export as a global SCRIPT — so its top-level declarations
    // land in shared global scope and the next import-less fence can use them.
    // That made the pin vacuous for exactly the class it exists to catch: an
    // undeclared identifier in an illustrative fence (review finding F3).
    moduleDetection: ts.ModuleDetectionKind.Force,
    // A fence is server-side code and reads `process.env` the way a composition
    // root does. Without node types it resolves against the DOM lib alone, so
    // `process` is an error and — worse, because it type-checks — a bare
    // `history` silently binds to `window.history`.
    types: ['node'],
    // Named explicitly: the virtual fence modules are written into the core
    // package's directory, whose own node_modules carries no @types, so the
    // default lookup walks straight past the app's copy.
    typeRoots: [path.join(REPO_ROOT, 'app', 'node_modules', '@types')],
  }

  const host = ts.createCompilerHost(options, /* setParentNodes */ true)
  const fenceDir = MANIFESTS['@hames-ai/harness-patterns'].root
  const fenceByPath = new Map<string, string>(
    fences.map((f, i) => [path.join(fenceDir, `__tutorial-fence-${i}.ts`), f.code]),
  )
  const originalGetSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
    const code = fenceByPath.get(fileName)
    if (code !== undefined)
      return ts.createSourceFile(fileName, code, languageVersionOrOptions, true)
    return originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreate)
  }
  host.resolveModuleNames = (moduleNames, containingFile) =>
    moduleNames.map((specifier) => {
      if (specifier.startsWith('@hames-ai/')) {
        // NO fall-through to node_modules: inside this workspace the symlink
        // would resolve a subpath the published package does not expose, which
        // is the whole failure this resolver exists to catch.
        const resolved = resolvePackageModule(specifier)
        return resolved ? { resolvedFileName: resolved, isExternalLibraryImport: false } : undefined
      }
      return ts.resolveModuleName(specifier, containingFile, options, host).resolvedModule
    })

  const program = ts.createProgram({ rootNames: [...fenceByPath.keys()], options, host })

  const results = new Map<Fence, string[]>()
  fences.forEach((fence, i) => {
    const source = program.getSourceFile(path.join(fenceDir, `__tutorial-fence-${i}.ts`))
    if (!source) {
      results.set(fence, ['fence source did not reach the program'])
      return
    }
    const diags = [
      ...program.getSyntacticDiagnostics(source),
      ...program.getSemanticDiagnostics(source),
    ]
    results.set(
      fence,
      diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
    )
  })
  return results
}

describe('tutorials docs pins', () => {
  // Explicit, generous timeout for the same reason the guide pin carries one:
  // one tsc Program over five packages' real source is sub-second warm and
  // several seconds on a cold CI runner. The compile is the work; the clock
  // must not be the gate.
  it('every typescript fence compiles against the packages AS PUBLISHED', () => {
    const fences = extractFences()
    // A non-vacuity floor, not a target: it exists so a rename or a bulk edit
    // that drops the fences cannot pass green. Kept well below the real count
    // so an ordinary edit never trips it.
    expect(fences.length).toBeGreaterThanOrEqual(12)
    const failures: string[] = []
    for (const [fence, diags] of compileFences(fences)) {
      if (diags.length > 0) {
        failures.push(
          `${fence.doc} fence #${fence.index} (section: ${fence.heading}):\n` +
            diags.map((d) => `  - ${d}`).join('\n'),
        )
      }
    }
    expect(failures).toEqual([])
  }, 120_000)

  it('every relative markdown link resolves, or is a declared pending page', () => {
    const broken: string[] = []
    let checked = 0
    for (const file of docPages()) {
      const content = readFileSync(path.join(TUTORIALS, file), 'utf-8')
      for (const m of content.matchAll(/\]\((\.[^)\s]+)\)/g)) {
        const target = m[1].split('#')[0]
        if (!target) continue
        checked++
        if (PENDING_PAGES[path.basename(target)]) continue
        if (!existsSync(path.resolve(TUTORIALS, target))) broken.push(`${file} → ${m[1]}`)
      }
    }
    // Same non-vacuity floor: if the regex ever stopped matching, this would
    // otherwise pass green having checked nothing (review finding F6).
    expect(checked).toBeGreaterThanOrEqual(20)
    expect(broken).toEqual([])
  })

  it('every declared pending page is STILL pending — delete the entry once it lands', () => {
    const landed = Object.entries(PENDING_PAGES)
      .filter(([page]) => existsSync(path.join(TUTORIALS, page)))
      .map(([page, why]) => `${page} has landed (${why}) — remove it from PENDING_PAGES`)
    expect(landed).toEqual([])
  })
})
