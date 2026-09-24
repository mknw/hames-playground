/**
 * The code samples in `docs/harness-patterns/` are compiled, not trusted.
 *
 * That directory holds the framework's design records (`withReferences`,
 * `parallel`, the prompt-caching bench), a hands-on walkthrough, and four
 * pages that now redirect to the package docs. The records keep their
 * historical sketches in `text` fences on purpose: a rejected alternative is
 * not meant to compile. Every `typescript` fence, by contrast, claims to be
 * the SHIPPED surface, and this test holds it to that: each one is extracted
 * and compiled against the packages as a consumer installs them.
 *
 * ## Where the resolver comes from
 *
 * The resolver below (the `exports` map gated by the `files` allowlist, then
 * mapped onto disk) is COPIED from `tutorials-docs-pins.test.ts`, which
 * exports nothing: a test file is not a module other tests import. Read that
 * file's docblock for why resolution goes through the published surface and
 * not the source tree, and why the compile is a real `tsc` program rather
 * than a key scan. If the two copies ever need to change together, that is
 * the moment to lift the resolver into a shared helper; until then a copy is
 * one file fewer than an abstraction with two callers.
 *
 * Diagnostics inside the package sources themselves are IGNORED; this test
 * judges the fences. It does not execute them: fences whose heading says
 * "(excerpt)" stand their host values up with `declare const`.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const DOCS = path.join(REPO_ROOT, 'docs', 'harness-patterns')
const PACKAGES = path.join(REPO_ROOT, 'packages')

const PACKAGE_NAMES = [
  'harness-patterns',
  'harness-baml',
  'agents',
  'sandbox',
  'connectors',
] as const

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
    const lines = readFileSync(path.join(DOCS, file), 'utf-8').split('\n')
    let heading = '(preamble)'
    // Per-DOC counter, so the failure names a fence the reader can find.
    let inDoc = 0
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i].match(/^#{2,3}\s+(.*)/)
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
  return readdirSync(DOCS)
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
    fences.map((f, i) => [path.join(fenceDir, `__hp-docs-fence-${i}.ts`), f.code]),
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
    const source = program.getSourceFile(path.join(fenceDir, `__hp-docs-fence-${i}.ts`))
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

describe('docs/harness-patterns docs pins', () => {
  // Same generous timeout as the tutorials pin: one tsc Program over five
  // packages' real source is sub-second warm and several seconds cold.
  it('every typescript fence compiles against the packages AS PUBLISHED', () => {
    const fences = extractFences()
    // A non-vacuity floor, not a target: a rename or a bulk edit that drops
    // the fences must not pass green having compiled nothing.
    expect(fences.length).toBeGreaterThanOrEqual(4)
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

  it('no code fence is labelled ts/tsx/js, which would render the same and skip the compile', () => {
    const dodges: string[] = []
    for (const file of docPages()) {
      readFileSync(path.join(DOCS, file), 'utf-8')
        .split('\n')
        .forEach((l, i) => {
          if (/^\s*```(ts|tsx|js|javascript)\s*$/.test(l)) dodges.push(`${file}:${i + 1}`)
        })
    }
    expect(dodges).toEqual([])
  })

  it('every relative markdown link resolves', () => {
    const broken: string[] = []
    let checked = 0
    for (const file of docPages()) {
      const content = readFileSync(path.join(DOCS, file), 'utf-8')
      for (const m of content.matchAll(/\]\((\.[^)\s]+)\)/g)) {
        const target = m[1].split('#')[0]
        if (!target) continue
        checked++
        if (!existsSync(path.resolve(DOCS, target))) broken.push(`${file} → ${m[1]}`)
      }
    }
    // Same non-vacuity floor: a regex that stopped matching would pass green.
    expect(checked).toBeGreaterThanOrEqual(20)
    expect(broken).toEqual([])
  })
})
