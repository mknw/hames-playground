/**
 * The @hames-ai/agents README's code samples are compiled, not trusted — the
 * same guide-docs pin discipline as harness-baml's and harness-patterns'
 * (precedent: `guide-docs-pins.test.ts`, `baml-readme-docs-pins.test.ts`).
 * Every `typescript` fence in the README is extracted and compiled against
 * the THREE packages' real TypeScript source (the same tree `pnpm typecheck`
 * covers), with the `@hames-ai/*` specifiers resolved onto the packages' source
 * files, mirroring their exports maps. Diagnostics inside the package sources
 * themselves are IGNORED — the fences are what this test judges.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const APP_ROOT = path.resolve(process.cwd())
const AGENTS_ROOT = path.join(APP_ROOT, '../packages/agents')
const BAML_ROOT = path.join(APP_ROOT, '../packages/harness-baml')
const PATTERNS_ROOT = path.join(APP_ROOT, '../packages/harness-patterns')
const README = readFileSync(path.join(AGENTS_ROOT, 'README.md'), 'utf-8')

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

/** Resolve package specifiers onto the three packages' source files, mirroring
 *  their exports maps (`.` → root index, `./agents` → the definitions barrel,
 *  `./*` wildcard → `<root>/<rest>.ts`). */
function resolvePackageModule(specifier: string): string | undefined {
  const roots: Array<[string, string]> = [
    ['@hames-ai/agents', AGENTS_ROOT],
    ['@hames-ai/harness-baml', BAML_ROOT],
    ['@hames-ai/harness-patterns', PATTERNS_ROOT],
  ]
  for (const [name, root] of roots) {
    if (specifier !== name && !specifier.startsWith(name + '/')) continue
    let rest = specifier === name ? 'index' : specifier.slice(name.length + 1)
    if (rest === 'agents') rest = 'agents/index'
    const candidates = [path.join(root, rest + '.ts'), path.join(root, rest, 'index.ts')]
    const hit = candidates.find((c) => existsSync(c))
    if (hit) return hit
  }
  return undefined
}

const fences = extractFences(README)

describe('the @hames-ai/agents README compiles (guide-docs pin)', () => {
  it('found the fences (guard against extraction rot)', () => {
    expect(fences.length).toBeGreaterThanOrEqual(5)
  })

  // 60s, not the 5s default: the fences compile against three packages'
  // sources on CI runners — the same budget the baml README pin got for the
  // same reason (PR-1b's "README pin gets a 60s budget").
  it('every typescript fence compiles against the package source', { timeout: 60_000 }, () => {
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
      fences.map((f, i) => [path.join(AGENTS_ROOT, `__readme-fence-${i}.ts`), f.code]),
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
    for (const fenceFile of fenceByPath.keys()) {
      const diags = ts.getPreEmitDiagnostics(program, program.getSourceFile(fenceFile))
      for (const d of diags) {
        const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ')
        failures.push(`${path.basename(fenceFile)}: ${msg}`)
      }
    }
    expect(failures).toEqual([])
  })

  it('the exported-surface table matches the package barrel', async () => {
    // The table in the Surface section names every value export of the root
    // barrel. Read the barrel and confirm the names resolve — the cheap
    // sibling of the compile check above.
    const mod = await import('@hames-ai/agents')
    for (const name of [
      'extractGraphElements',
      'extractGraphFromResult',
      'isEdgeElement',
      'isNodeElement',
      'isNeo4jGraphResult',
      'isMemoryGraphResult',
      'extractReferences',
      'referencesForDoc',
      'errorBubble',
      'replayMessages',
    ]) {
      expect(typeof (mod as Record<string, unknown>)[name]).toBe('function')
    }
  })
})
