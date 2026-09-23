/**
 * The first screen of every front-facing README has one fixed skeleton.
 *
 * A reader who lands on any one of the five package READMEs — or on the
 * tutorials index — has never seen this repository. The owner's rule for what
 * they see first (2026-09-23): a plain description, then which package solves
 * which need, then where the packages can be seen running. So each of those six
 * files opens with exactly these three `##` sections, in this order:
 *
 *   A. `## What this is`
 *   B. `## Which package do you need?` — linking EVERY package's README, so a
 *      reader landing anywhere sees the whole family
 *   C. `## See it running` — linking the hames app (the repository root)
 *
 * B's links are absolute GitHub URLs on purpose: a relative link in a package
 * README is rewritten by npmjs.com against the manifest's `repository` field,
 * and an absolute one reads the same on both sites.
 *
 * The package set is DISCOVERED from `packages/*` (every directory with a
 * `package.json`), never listed, so a sixth package fails every table here
 * until it is added to all six files — which is the point of "the same table
 * everywhere". The five known names are asserted separately as a non-vacuity
 * anchor, so a discovery that silently found nothing cannot pass.
 *
 * The sandbox and connectors READMEs have no docs-pin test of their own, so
 * this file also compiles their `typescript` fences against the five packages'
 * source (specifiers resolved through each package's `exports` map), the same
 * way `agents-readme-docs-pins.test.ts` does for the agents README.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const PACKAGES = path.join(REPO_ROOT, 'packages')
const REPO_URL = 'https://github.com/mknw/hames-playground'

const SKELETON = ['What this is', 'Which package do you need?', 'See it running'] as const

const packageDirs = readdirSync(PACKAGES, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(path.join(PACKAGES, d.name, 'package.json')))
  .map((d) => d.name)
  .sort()

const READMES = [
  ...packageDirs.map((dir) => `packages/${dir}/README.md`),
  'docs/tutorials/README.md',
]

interface Section {
  heading: string
  body: string
}

/** The document's `##` sections (level two exactly), outside code fences. */
function sections(markdown: string): Section[] {
  const out: Section[] = []
  let fence: string | null = null
  for (const line of markdown.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (marker) {
      if (fence === null) fence = marker[1]!
      else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length) fence = null
    }
    const heading = fence === null ? /^## (?!#)(.*\S)\s*$/.exec(line) : null
    if (heading) out.push({ heading: heading[1]!, body: '' })
    else if (out.length > 0) out[out.length - 1]!.body += `${line}\n`
  }
  return out
}

/** Every inline markdown link target in a block of text. */
function links(text: string): string[] {
  return [...text.matchAll(/\]\(\s*<?([^\s)>]+)>?/g)].map((m) => m[1]!)
}

const readmeUrl = (dir: string) => `${REPO_URL}/tree/main/packages/${dir}#readme`

describe('front-facing README skeleton', () => {
  it('discovers the five packages (non-vacuity)', () => {
    expect(packageDirs).toEqual(
      expect.arrayContaining([
        'agents',
        'connectors',
        'harness-baml',
        'harness-patterns',
        'sandbox',
      ]),
    )
    expect(READMES).toHaveLength(packageDirs.length + 1)
  })

  describe.each(READMES)('%s', (file) => {
    const doc = sections(readFileSync(path.join(REPO_ROOT, file), 'utf8'))

    it('opens with the three first-contact sections, in order', () => {
      SKELETON.forEach((expected, i) => {
        expect(
          doc[i]?.heading,
          `${file}: ## heading #${i + 1} is "${doc[i]?.heading ?? '(none)'}", expected "${expected}"`,
        ).toBe(expected)
      })
    })

    it('links every package README from "Which package do you need?"', () => {
      const table = doc.find((s) => s.heading === SKELETON[1])
      expect(table, `${file}: no "## ${SKELETON[1]}" section`).toBeDefined()
      const targets = links(table!.body)
      const missing = packageDirs.filter((dir) => !targets.includes(readmeUrl(dir)))
      expect(
        missing,
        `${file}: "${SKELETON[1]}" does not link these packages' READMEs (${missing
          .map(readmeUrl)
          .join(', ')})`,
      ).toEqual([])
    })

    it('links the repository root from "See it running"', () => {
      const running = doc.find((s) => s.heading === SKELETON[2])
      expect(running, `${file}: no "## ${SKELETON[2]}" section`).toBeDefined()
      const root = links(running!.body).filter(
        (t) => t === REPO_URL || t.startsWith(`${REPO_URL}#`),
      )
      expect(root, `${file}: "${SKELETON[2]}" does not link ${REPO_URL}`).not.toEqual([])
    })
  })
})

// ============================================================================
// The sandbox and connectors usage examples compile against the real packages
// ============================================================================

const FENCE_READMES = ['packages/sandbox/README.md', 'packages/connectors/README.md']

/** Every ```typescript fence in a README, in order. */
function typescriptFences(markdown: string): string[] {
  const lines = markdown.split('\n')
  const fences: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== '```typescript') continue
    const close = lines.findIndex((l, j) => j > i && l.trim() === '```')
    if (close === -1) throw new Error(`unterminated typescript fence at line ${i + 1}`)
    fences.push(lines.slice(i + 1, close).join('\n'))
    i = close
  }
  return fences
}

/** Resolve `@hames-ai/<dir>[/sub]` through that package's `exports` map onto
 *  its source file — `.` and exact keys first, then the `./*` pattern. */
function resolvePackageModule(specifier: string): string | undefined {
  const m = /^@hames-ai\/([^/]+)(?:\/(.+))?$/.exec(specifier)
  if (!m || !packageDirs.includes(m[1]!)) return undefined
  const root = path.join(PACKAGES, m[1]!)
  const exportsMap = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).exports as
    Record<string, string> | undefined
  const key = m[2] ? `./${m[2]}` : '.'
  const target = exportsMap?.[key] ?? (exportsMap?.['./*'] ? `./${m[2]}.ts` : undefined)
  if (!target) return undefined
  const file = path.join(root, target)
  return existsSync(file) ? file : undefined
}

describe('sandbox and connectors README fences compile', () => {
  for (const file of FENCE_READMES) {
    const fences = typescriptFences(readFileSync(path.join(REPO_ROOT, file), 'utf8'))

    it(`${file} carries at least one usage example (non-vacuity)`, () => {
      expect(fences.length, `${file} has no typescript fence`).toBeGreaterThan(0)
    })

    it(`${file}: every typescript fence compiles`, { timeout: 60_000 }, () => {
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
      const pkgRoot = path.join(REPO_ROOT, path.dirname(file))
      const fenceByPath = new Map(
        fences.map((code, i) => [path.join(pkgRoot, `__readme-fence-${i}.ts`), code]),
      )
      const host = ts.createCompilerHost(options, true)
      const getSourceFile = host.getSourceFile.bind(host)
      host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
        const code = fenceByPath.get(fileName)
        if (code !== undefined) return ts.createSourceFile(fileName, code, languageVersion, true)
        return getSourceFile(fileName, languageVersion, onError, shouldCreate)
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
        for (const d of ts.getPreEmitDiagnostics(program, program.getSourceFile(fenceFile))) {
          failures.push(
            `${file} fence #${Number(/(\d+)\.ts$/.exec(fenceFile)![1]) + 1}: ` +
              ts.flattenDiagnosticMessageText(d.messageText, ' '),
          )
        }
      }
      expect(failures).toEqual([])
    })
  }
})
