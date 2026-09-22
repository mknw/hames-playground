/**
 * The tutorials' code samples are compiled, not trusted.
 *
 * `docs/tutorials/` is what an external developer copies first, and copied code
 * that does not compile is a bug with a byline. This file extracts every
 * `typescript` fence from every page there and COMPILES it against the real
 * package sources — the same trees `pnpm typecheck` covers — so a page that
 * drifts from the shipped surface (a renamed symbol, a removed parameter, a
 * changed call shape) fails here instead of shipping prose that no longer
 * builds.
 *
 * This is the same mechanism as `lib/harness-patterns/guide-docs-pins.test.ts`
 * and its two siblings, widened in the one way the tutorials need: a tutorial
 * composes ACROSS packages (a guarded agent whose sandbox wrapper is injected
 * and whose catalog ships in a third package), so the resolver below maps all
 * five `@hames/*` specifiers onto their source trees rather than one.
 *
 * Why a real compiler rather than an export-list diff: the fences must not
 * merely name real symbols — the CALL SHAPES must exist (`Tools()` takes a
 * REQUIRED `namespaces` map; `withInjectionGuard` takes `catalog` beside
 * `namespaces`; `router` takes descriptions first and config second). A
 * compiler sees all of that; a key scan sees none of it.
 *
 * Diagnostics inside the package sources themselves are IGNORED — their
 * correctness is the rest of the suite's job; this test judges the fences.
 *
 * What it deliberately does NOT do is execute them. A tutorial fence stands its
 * host values up with `declare const` where the real thing needs a container
 * engine, an MCP gateway or a document store; the wiring is what this pins, and
 * the runtime behaviour those pages quote is covered by the suites that own it.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const TUTORIALS = path.join(REPO_ROOT, 'docs', 'tutorials')
const PACKAGES = path.join(REPO_ROOT, 'packages')

/** `@hames/<pkg>` → the directory its exports map resolves inside. */
const PACKAGE_ROOTS: Record<string, string> = {
  '@hames/harness-patterns': path.join(PACKAGES, 'harness-patterns'),
  '@hames/harness-baml': path.join(PACKAGES, 'harness-baml'),
  '@hames/agents': path.join(PACKAGES, 'agents'),
  '@hames/sandbox': path.join(PACKAGES, 'sandbox'),
  '@hames/connectors': path.join(PACKAGES, 'connectors'),
}

interface Fence {
  doc: string
  index: number
  heading: string
  code: string
}

/** Fences open on a bare ```typescript line and close on the next ``` line. */
function extractFences(): Fence[] {
  const fences: Fence[] = []
  const docs = readdirSync(TUTORIALS)
    .filter((f) => f.endsWith('.md'))
    .sort()
  for (const file of docs) {
    const lines = readFileSync(path.join(TUTORIALS, file), 'utf-8').split('\n')
    let heading = '(preamble)'
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i].match(/^##\s+(.*)/)
      if (h) heading = h[1].trim()
      if (lines[i].trim() === '```typescript') {
        const close = lines.findIndex((l, j) => j > i && l.trim() === '```')
        if (close === -1)
          throw new Error(`${file}: unterminated typescript fence under "${heading}"`)
        fences.push({
          doc: file,
          index: fences.length + 1,
          heading,
          code: lines.slice(i + 1, close).join('\n'),
        })
        i = close
      }
    }
  }
  return fences
}

/**
 * Resolve an `@hames/*` specifier onto a source file, mirroring each package's
 * exports map (`.` → index.ts, then `<rest>/index.ts` or `<rest>.ts`). The
 * `baml_client` subpath resolves the same way, so a fence may import it.
 */
function resolvePackageModule(specifier: string): string | undefined {
  for (const [name, root] of Object.entries(PACKAGE_ROOTS)) {
    if (specifier === name) return path.join(root, 'index.ts')
    if (!specifier.startsWith(`${name}/`)) continue
    const rest = specifier.slice(name.length + 1)
    const candidates = [path.join(root, rest, 'index.ts'), path.join(root, `${rest}.ts`)]
    return candidates.find((c) => exists(c))
  }
  return undefined
}

function exists(p: string): boolean {
  try {
    readFileSync(p)
    return true
  } catch {
    return false
  }
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
    // land in the shared global scope and the next import-less fence can use
    // them. That makes the pin vacuous for exactly the class it exists to
    // catch: an undeclared identifier in an illustrative fence. Forcing module
    // detection isolates every fence from every other (review finding F3; the
    // two-fence probe in the PR discussion is the mutation this reddens).
    moduleDetection: ts.ModuleDetectionKind.Force,
    // A tutorial fence is server-side code and reads `process.env` the way a
    // composition root does. Without this it resolves against the DOM lib
    // alone, so `process` is TS2580 and — worse, because it type-checks —
    // a bare `history` silently binds to `window.history` instead of failing.
    types: ['node'],
    // Resolved explicitly: the virtual fence modules are written into the core
    // package's directory (below), whose own node_modules carries no @types —
    // so the default lookup walks past the app's copy and `types: ['node']`
    // silently resolves to nothing.
    typeRoots: [path.join(REPO_ROOT, 'app', 'node_modules', '@types')],
  }

  const host = ts.createCompilerHost(options, /* setParentNodes */ true)
  // The virtual fence modules sit inside the core package so relative node_modules
  // resolution for non-@hames specifiers behaves as it does for package source.
  const fenceDir = PACKAGE_ROOTS['@hames/harness-patterns']
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
      const resolved = resolvePackageModule(specifier)
      if (resolved) return { resolvedFileName: resolved, isExternalLibraryImport: false }
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
  it('every typescript fence under docs/tutorials/ compiles against the packages', () => {
    const fences = extractFences()
    // Sanity: the pages actually carry fences — a rename or a bulk edit that
    // drops them must not silently pass this pin.
    expect(fences.length).toBeGreaterThanOrEqual(15)
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

  it('every relative markdown link in docs/tutorials/ resolves to a file', () => {
    const broken: string[] = []
    for (const file of readdirSync(TUTORIALS).filter((f) => f.endsWith('.md'))) {
      const content = readFileSync(path.join(TUTORIALS, file), 'utf-8')
      for (const m of content.matchAll(/\]\((\.[^)\s]+)\)/g)) {
        const target = m[1].split('#')[0]
        if (!target) continue
        if (!existsSync(path.resolve(TUTORIALS, target))) broken.push(`${file} → ${m[1]}`)
      }
    }
    expect(broken).toEqual([])
  })
})
