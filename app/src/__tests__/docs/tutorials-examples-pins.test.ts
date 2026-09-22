/**
 * `docs/tutorials/examples/` holds one runnable `.ts` file per complete
 * tutorial. This pin exists so those files can never say something the page
 * they came from does not.
 *
 * ## The rule the examples are held to
 *
 * An example is **assembled, not written**. Its code is lifted verbatim from
 * its page's ```typescript fences, and three properties keep it that way:
 *
 * 1. **Verbatim inclusion.** Every fence the manifest says a file was built
 *    from must appear in that file as a CONTIGUOUS substring, byte for byte,
 *    exactly once. Edit either side — the page or the example — and this goes
 *    red naming both.
 * 2. **No wiring of its own.** Every statement in an example must sit inside
 *    one of those quoted fence regions; the only statements allowed outside
 *    them are `console.*` echoes. Comments are free. So an example can PRINT
 *    what the page's code produced, and cannot introduce a pattern, a client, a
 *    guard or a transport the page never wrote. Without this half, rule 1 alone
 *    would let an example quote a fence and then contradict it two lines later.
 * 3. **The manifest accounts for every fence on the page.** `from` and
 *    `omitted` must together name exactly the page's fence ordinals. A page
 *    that GAINS a fence therefore fails until someone decides whether the
 *    example takes it — the silent-drift case a "compiles green" check cannot
 *    see.
 *
 * Plus the compile property the tutorials' own pin already applies to fences:
 * every example type-checks against the packages AS PUBLISHED (the `exports`
 * map gated by the `files` allowlist), never against the monorepo tree.
 *
 * ## Why fences are omitted at all
 *
 * The assembly rule is "the page's designated complete example where it has
 * one, otherwise its fences in page order" — and a fence is dropped only when
 * it cannot share a module with the ones already taken. That is not a
 * technicality: a tutorial's later fences are routinely written as
 * CONTINUATIONS (`declare const makeScripted; // from §1`), which is the right
 * thing on a page and a redeclaration in a file. Each omission carries its
 * reason in the manifest below and in the example's own header, so the choice
 * is reviewable rather than invisible.
 *
 * ## Why this file duplicates the resolver instead of importing it
 *
 * `tutorials-docs-pins.test.ts` builds exactly this tarball-shaped resolution,
 * and its docblock is the authority on WHY (a snippet that works in this
 * monorepo and fails for a consumer is the failure the packaging programme
 * exists to prevent). It exports nothing, though: sharing the machinery would
 * mean editing that file — adding exports, or moving it into a module both
 * import — and this lane must not touch it. So the resolver is duplicated,
 * deliberately and minimally. If the two ever disagree, that file is the
 * original.
 *
 * Execution is NOT attempted here, for the same reason it is not there: an
 * example whose page stands its infrastructure up with `declare const` has no
 * container engine, gateway or document store to run against. Which examples
 * run for real, and which only type-check, is stated in each file's header and
 * in `docs/tutorials/examples/README.md`; running them end to end from a packed
 * tarball is the packaging lane's `scripts/pack-smoke.sh` territory.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const TUTORIALS = path.join(REPO_ROOT, 'docs', 'tutorials')
const EXAMPLES = path.join(TUTORIALS, 'examples')
const PACKAGES = path.join(REPO_ROOT, 'packages')

const PACKAGE_NAMES = [
  'harness-patterns',
  'harness-baml',
  'agents',
  'sandbox',
  'connectors',
] as const

interface ExampleSpec {
  /** The page in `docs/tutorials/` this example is assembled from. */
  page: string
  /** Fence ordinals quoted verbatim, in the order they appear in the file. */
  from: number[]
  /** Fence ordinals deliberately NOT quoted, each with the reason. */
  omitted: Record<number, string>
}

/**
 * The filename contract as well as the manifest: another lane links these five
 * names from the tutorial pages, so a rename here breaks a published link.
 * `wiring-a-host.md` has no entry ON PURPOSE — it is a declared stub with no
 * `typescript` fence at all, so there is nothing to assemble; see
 * `docs/tutorials/examples/README.md`.
 */
const EXAMPLES_MANIFEST: Record<string, ExampleSpec> = {
  'hosting-the-harness.ts': {
    page: 'hosting-the-harness.md',
    from: [5],
    omitted: {
      1: '§1 — a `declare const` sketch of the same turn, superseded by §5',
      2: '§3 — the frameless `runChain` sketch; all of its values are declared',
      3: "§4 — redeclares §1's `agent` and the frame values as `declare const`",
      4: '§4 — redeclares `MyData`/`mySettings`/`onEvent`, so it cannot share a module with #3',
    },
  },
  'guarding-an-agent.ts': {
    page: 'guarding-an-agent.md',
    from: [1, 3, 4],
    omitted: {
      2: '§2 — written as a continuation of §1 (`declare const makeScripted`, `declare const tools`), so quoting it would redeclare the values §1 defines and re-import `harness`/`simpleLoop`',
    },
  },
  'running-code-in-a-sandbox.ts': {
    page: 'running-code-in-a-sandbox.md',
    from: [1],
    omitted: {
      2: "§4 — redeclares §2's `sessionId` and `loop` and re-imports `ConfiguredPattern`/`AgentData`",
    },
  },
  'attaching-a-sandbox-workspace.ts': {
    page: 'attaching-a-sandbox-workspace.md',
    from: [1, 2, 3],
    omitted: {
      4: '§5 — re-imports `withSandbox`, which §3 already imports; one module cannot bind it twice',
    },
  },
  'own-provider-or-model.ts': {
    page: 'own-provider-or-model.md',
    from: [4],
    omitted: {
      1: '§1 — the first step, superseded by the page\'s own "Complete example"',
      2: "§2 — restates step 1's `plug` as a `declare const`",
      3: "§3 — restates step 1's `plug` as a `declare const`",
      5: 'the offline-render fence — restates `plug` the same way',
    },
  },
}

// ============================================================================
// Fences (the same extraction shape the tutorials' own pin uses)
// ============================================================================

interface Fence {
  index: number
  heading: string
  code: string
}

/** Fences open on a bare ```typescript line and close on the next ``` line. */
function fencesOf(page: string): Fence[] {
  const lines = readFileSync(path.join(TUTORIALS, page), 'utf-8').split('\n')
  const fences: Fence[] = []
  let heading = '(preamble)'
  let index = 0
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^##\s+(.*)/)
    if (h) heading = h[1].trim()
    if (lines[i].trim() === '```typescript') {
      const close = lines.findIndex((l, j) => j > i && l.trim() === '```')
      if (close === -1) throw new Error(`${page}: unterminated typescript fence under "${heading}"`)
      fences.push({ index: ++index, heading, code: lines.slice(i + 1, close).join('\n') })
      i = close
    }
  }
  return fences
}

function exampleFiles(): string[] {
  if (!existsSync(EXAMPLES)) return []
  return readdirSync(EXAMPLES)
    .filter((f) => f.endsWith('.ts'))
    .sort()
}

const readExample = (file: string) => readFileSync(path.join(EXAMPLES, file), 'utf-8')

// ============================================================================
// The published surface: exports map, gated by the files allowlist
//
// Duplicated from tutorials-docs-pins.test.ts — see the docblock.
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
    return [`@hames/${name}`, { root, exports: pkg.exports ?? {}, files: pkg.files ?? [] }]
  }),
)

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
    return !relative.includes('/') && relative.endsWith(pattern.slice(1))
  }
  return relative === pattern || relative.startsWith(`${pattern}/`)
}

function resolvePackageModule(specifier: string): string | undefined {
  for (const [name, manifest] of Object.entries(MANIFESTS)) {
    if (specifier !== name && !specifier.startsWith(`${name}/`)) continue
    const subpath = specifier === name ? '.' : `./${specifier.slice(name.length + 1)}`

    let target = manifest.exports[subpath]
    if (!target) {
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

/**
 * Compile every example as its own in-memory module.
 *
 * The virtual files are written into the core package's directory rather than
 * read from `docs/tutorials/examples/`, exactly as the fence pin does: that is
 * where the `typeRoots` below point, and it keeps the two pins resolving
 * identically. A stranger's copy of one of these files sits in their own tree,
 * so no property worth pinning depends on the directory.
 */
function compileExamples(files: string[]): Map<string, string[]> {
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
    esModuleInterop: true,
    isolatedModules: true,
    moduleDetection: ts.ModuleDetectionKind.Force,
    types: ['node'],
    typeRoots: [path.join(REPO_ROOT, 'app', 'node_modules', '@types')],
  }

  const host = ts.createCompilerHost(options, /* setParentNodes */ true)
  const dir = MANIFESTS['@hames/harness-patterns'].root
  const virtual = new Map<string, string>(
    files.map((f) => [path.join(dir, `__tutorial-example-${f}`), readExample(f)]),
  )
  const originalGetSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
    const code = virtual.get(fileName)
    if (code !== undefined)
      return ts.createSourceFile(fileName, code, languageVersionOrOptions, true)
    return originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreate)
  }
  host.resolveModuleNames = (moduleNames, containingFile) =>
    moduleNames.map((specifier) => {
      if (specifier.startsWith('@hames/')) {
        const resolved = resolvePackageModule(specifier)
        return resolved ? { resolvedFileName: resolved, isExternalLibraryImport: false } : undefined
      }
      return ts.resolveModuleName(specifier, containingFile, options, host).resolvedModule
    })

  const program = ts.createProgram({ rootNames: [...virtual.keys()], options, host })

  const results = new Map<string, string[]>()
  for (const file of files) {
    const source = program.getSourceFile(path.join(dir, `__tutorial-example-${file}`))
    if (!source) {
      results.set(file, ['example source did not reach the program'])
      continue
    }
    const diags = [
      ...program.getSyntacticDiagnostics(source),
      ...program.getSemanticDiagnostics(source),
    ]
    results.set(
      file,
      diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
    )
  }
  return results
}

describe('tutorials examples pins', () => {
  it('the five contracted example files are present, and nothing else is', () => {
    expect(existsSync(EXAMPLES)).toBe(true)
    // Sorted both sides: the message then names exactly what is extra or missing.
    expect(exampleFiles()).toEqual(Object.keys(EXAMPLES_MANIFEST).sort())
    expect(existsSync(path.join(EXAMPLES, 'README.md'))).toBe(true)
    // Each file says where it came from, in its own header — a wrong header is
    // a stranger sent to the wrong page.
    const mislabelled = Object.entries(EXAMPLES_MANIFEST)
      .filter(([file, spec]) => !readExample(file).includes(`docs/tutorials/${spec.page}`))
      .map(([file, spec]) => `${file} does not name docs/tutorials/${spec.page}`)
    expect(mislabelled).toEqual([])
  })

  it('every example compiles against the packages AS PUBLISHED', () => {
    const files = exampleFiles()
    expect(files.length).toBeGreaterThanOrEqual(5)
    const failures: string[] = []
    for (const [file, diags] of compileExamples(files)) {
      if (diags.length > 0)
        failures.push(`examples/${file}:\n` + diags.map((d) => `  - ${d}`).join('\n'))
    }
    expect(failures).toEqual([])
  }, 120_000)

  it('every quoted fence appears in its example verbatim, exactly once', () => {
    const failures: string[] = []
    // Non-vacuity floor: a manifest edited down to nothing must not pass green.
    let quoted = 0
    for (const [file, spec] of Object.entries(EXAMPLES_MANIFEST)) {
      const text = readExample(file)
      const fences = fencesOf(spec.page)
      for (const index of spec.from) {
        const fence = fences.find((f) => f.index === index)
        if (!fence) {
          failures.push(`${spec.page} has no fence #${index}, but examples/${file} claims it`)
          continue
        }
        quoted++
        const occurrences = text.split(fence.code).length - 1
        if (occurrences === 1) continue
        failures.push(
          occurrences === 0
            ? `examples/${file} no longer contains ${spec.page} fence #${index} ` +
                `(section: ${fence.heading}) verbatim — one of the two was edited`
            : `examples/${file} contains ${spec.page} fence #${index} ${occurrences} times; ` +
                `a quoted fence must appear exactly once`,
        )
      }
    }
    expect(quoted).toBeGreaterThanOrEqual(7)
    expect(failures).toEqual([])
  })

  it('an example adds no wiring of its own — every statement is quoted, or a console echo', () => {
    const failures: string[] = []
    for (const [file, spec] of Object.entries(EXAMPLES_MANIFEST)) {
      const text = readExample(file)
      const fences = fencesOf(spec.page)
      const covered: Array<[number, number]> = []
      let located = true
      for (const index of spec.from) {
        const fence = fences.find((f) => f.index === index)
        const at = fence ? text.indexOf(fence.code) : -1
        if (!fence || at < 0) located = false
        else covered.push([at, at + fence.code.length])
      }
      // A fence that no longer matches is the VERBATIM test's failure. Without
      // this skip, every statement in the file would also be reported here as
      // unquoted, and the one message that names the real cause would be buried
      // under a hundred that do not.
      if (!located) continue
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true)
      for (const statement of source.statements) {
        const start = statement.getStart(source)
        const end = statement.getEnd()
        if (covered.some(([from, to]) => start >= from && end <= to)) continue
        if (isConsoleEcho(statement)) continue
        const line = source.getLineAndCharacterOfPosition(start).line + 1
        failures.push(
          `examples/${file}:${line} is outside every fence quoted from ${spec.page} and is ` +
            `not a console echo: ${statement.getText(source).split('\n')[0].slice(0, 80)}`,
        )
      }
    }
    expect(failures).toEqual([])
  })

  it('the manifest accounts for every fence on each page it draws from', () => {
    const failures: string[] = []
    for (const [file, spec] of Object.entries(EXAMPLES_MANIFEST)) {
      const onPage = fencesOf(spec.page).map((f) => f.index)
      const accounted = [...spec.from, ...Object.keys(spec.omitted).map(Number)].sort(
        (a, b) => a - b,
      )
      const unaccounted = onPage.filter((i) => !accounted.includes(i))
      const phantom = accounted.filter((i) => !onPage.includes(i))
      if (unaccounted.length > 0)
        failures.push(
          `${spec.page} fence(s) #${unaccounted.join(', #')} are neither quoted by ` +
            `examples/${file} nor recorded as omitted — take them, or say why not`,
        )
      if (phantom.length > 0)
        failures.push(`${spec.page} has no fence(s) #${phantom.join(', #')}, but the manifest does`)
      const blank = Object.entries(spec.omitted).filter(([, why]) => why.trim().length < 10)
      if (blank.length > 0)
        failures.push(`examples/${file}: omitted fences need a reason (#${blank[0][0]} has none)`)
    }
    expect(failures).toEqual([])
  })
})

/** `console.log(...)` / `console.error(...)` and friends, as a whole statement. */
function isConsoleEcho(statement: ts.Statement): boolean {
  if (!ts.isExpressionStatement(statement)) return false
  const call = statement.expression
  if (!ts.isCallExpression(call)) return false
  const callee = call.expression
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'console'
  )
}
