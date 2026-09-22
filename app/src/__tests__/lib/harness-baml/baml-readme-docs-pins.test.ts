/**
 * The @hames-ai/harness-baml README's code samples are compiled, not trusted —
 * the same guide-docs pin discipline as harness-patterns' (precedent:
 * guide-docs-pins.test.ts). Every `typescript` fence in the README is
 * extracted and compiled against the package's real TypeScript source (the
 * same tree `pnpm typecheck` covers), with `@hames-ai/harness-baml` and
 * `@hames-ai/harness-patterns` specifiers resolved onto the two packages' source
 * files, mirroring their exports maps. Diagnostics inside the package sources
 * themselves are IGNORED — the fences are what this test judges.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const PKG_ROOT = path.join(APP_ROOT, 'packages/harness-baml')
const PATTERNS_ROOT = path.join(APP_ROOT, 'packages/harness-patterns')
const README = readFileSync(path.join(PKG_ROOT, 'README.md'), 'utf-8')

interface Fence {
  index: number
  heading: string
  code: string
}

/** Fences open on a bare ```typescript line and close on the next ``` line. */
function extractFences(content: string): Fence[] {
  const fences: Fence[] = []
  const lines = content.split('\n')
  let heading = '(preamble)'
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^##\s+(.*)/)
    if (h) heading = h[1].trim()
    if (lines[i].trim() === '```typescript') {
      const close = lines.findIndex((l, j) => j > i && l.trim() === '```')
      if (close === -1) throw new Error(`unterminated typescript fence under "${heading}"`)
      fences.push({ index: fences.length + 1, heading, code: lines.slice(i + 1, close).join('\n') })
      i = close
    }
  }
  return fences
}

/** Resolve package specifiers onto the two packages' source files, mirroring
 *  their exports maps. */
function resolvePackageModule(specifier: string): string | undefined {
  const roots: Array<[string, string]> = [
    ['@hames-ai/harness-baml', PKG_ROOT],
    ['@hames-ai/harness-patterns', PATTERNS_ROOT],
  ]
  for (const [name, root] of roots) {
    if (specifier !== name && !specifier.startsWith(name + '/')) continue
    const rest = specifier === name ? 'index' : specifier.slice(name.length + 1)
    const candidates = [path.join(root, rest + '.ts'), path.join(root, rest, 'index.ts')]
    const hit = candidates.find((c) => existsSync(c))
    if (hit) return hit
  }
  return undefined
}

const fences = extractFences(README)

describe('the harness-baml README compiles (guide-docs pin)', () => {
  it('found the fences (guard against extraction rot)', () => {
    expect(fences.length).toBeGreaterThanOrEqual(3)
  })

  it('every typescript fence compiles against the package source', () => {
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
    const host = ts.createCompilerHost(options, true)
    const fenceByPath = new Map<string, string>(
      fences.map((f, i) => [path.join(PKG_ROOT, `__readme-fence-${i}.ts`), f.code]),
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
    const failures: string[] = []
    for (const [fileName, code] of fenceByPath) {
      void code
      const sf = program.getSourceFile(fileName)
      if (!sf) {
        failures.push(`${path.basename(fileName)}: not in program`)
        continue
      }
      const diags = [...program.getSemanticDiagnostics(sf), ...program.getSyntacticDiagnostics(sf)]
      for (const d of diags) {
        const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n')
        failures.push(`${path.basename(fileName)}: ${msg}`)
      }
    }
    expect(failures).toEqual([])
    // Compiling the fences pulls the package's real source graph in — the
    // default 5s test timeout is a cold-CI red, not a real failure.
  }, 60_000)
})
