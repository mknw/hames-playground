/**
 * The package guide's code samples are compiled, not trusted (the guide-docs
 * pin; precedent: uno-fonts.test.ts).
 *
 * packages/harness-patterns/GUIDE.md and README.md both carry `typescript`
 * fences that document the package's public surface. This file extracts every
 * fence from both files and COMPILES it against the package's real TypeScript
 * source — the same tree `pnpm typecheck` already covers — so a guide that
 * drifts from the exported surface (a renamed symbol, a removed parameter, a
 * changed call shape) fails here instead of shipping prose that no longer
 * builds. That is the whole point: the guide is the first thing a consumer
 * copies, and copied code that does not compile is a bug with a byline.
 *
 * Why a real compiler rather than an export-list diff: the fences must not
 * merely name real symbols — the CALL SHAPES must exist (e.g. `Tools()` takes
 * a REQUIRED `namespaces` map; `harness()` needs a data generic carrying an
 * index signature). A compiler sees both; a key scan sees neither. The
 * compiler is the test.
 *
 * Each fence is compiled as its own in-memory module: imports resolve through
 * a paths-style map onto the package's source files (mirroring the exports
 * map: `.` → index.ts, `./patterns`, `./guard`, `./*`), so the fences prove
 * the same surface a consumer's bundler resolves. Diagnostics inside the
 * package source itself are IGNORED — the package's own correctness is the
 * rest of the suite's job; this test only judges the fences.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const PKG_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../packages/harness-patterns',
)

const GUIDE_DOCS: Array<{ file: string; content: string }> = (
  ['README.md', 'GUIDE.md'] as const
).map((file) => ({
  file,
  content: readFileSync(path.join(PKG_ROOT, file), 'utf-8'),
}))

interface Fence {
  doc: string
  index: number
  heading: string
  code: string
}

/** Fences open on a bare ```typescript line and close on the next ``` line. */
function extractFences(): Fence[] {
  const fences: Fence[] = []
  for (const { file, content } of GUIDE_DOCS) {
    const lines = content.split('\n')
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

/** Resolve `@hames/harness-patterns` subpaths onto the package's source files,
 *  mirroring the exports map (`.` → index.ts; `./patterns`; `./guard`; `./*`). */
function resolvePackageModule(specifier: string): string | undefined {
  if (specifier === '@hames/harness-patterns') return path.join(PKG_ROOT, 'index.ts')
  if (!specifier.startsWith('@hames/harness-patterns/')) return undefined
  const rest = specifier.slice('@hames/harness-patterns/'.length)
  const candidates = [path.join(PKG_ROOT, rest, 'index.ts'), path.join(PKG_ROOT, `${rest}.ts`)]
  return candidates.find((c) => exists(c))
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
  }

  const host = ts.createCompilerHost(options, /* setParentNodes */ true)
  const fenceByPath = new Map<string, string>(
    fences.map((f, i) => [path.join(PKG_ROOT, `__guide-fence-${i}.ts`), f.code]),
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

  const program = ts.createProgram({
    rootNames: [...fenceByPath.keys()],
    options,
    host,
  })

  const results = new Map<Fence, string[]>()
  fences.forEach((fence, i) => {
    const source = program.getSourceFile(path.join(PKG_ROOT, `__guide-fence-${i}.ts`))
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

describe('guide docs pins', () => {
  it('every typescript fence in README.md and GUIDE.md compiles against the package exports', () => {
    const fences = extractFences()
    // Sanity: the guide actually carries fences — a refactor that renames
    // README/GUIDE or drops the fences must not silently pass this pin.
    expect(fences.length).toBeGreaterThanOrEqual(6)
    const compiled = compileFences(fences)
    const failures: string[] = []
    for (const [fence, diags] of compiled) {
      if (diags.length > 0) {
        failures.push(
          `${fence.doc} fence #${fence.index} (section: ${fence.heading}):\n` +
            diags.map((d) => `  - ${d}`).join('\n'),
        )
      }
    }
    expect(failures).toEqual([])
  })
})
