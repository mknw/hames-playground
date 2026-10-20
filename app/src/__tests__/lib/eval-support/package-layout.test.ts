// @vitest-environment node
/** Eval entries find packages/ from their own files, and refuse to start when it is missing. */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  REPO_ROOT,
  agentModuleFile,
  agentModuleUrl,
  assertPackageLayout,
  packagePath,
} from '../../../lib/eval-support/package-layout'

const APP = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const read = (file: string) => readFileSync(resolve(APP, file), 'utf8')

afterEach(() => vi.restoreAllMocks())

describe('package resolution is independent of the working directory', () => {
  it('resolves the same paths from a directory with no sibling layout', () => {
    const fromApp = [packagePath('agents', 'agents'), agentModuleFile('general-next')]
    vi.spyOn(process, 'cwd').mockReturnValue(tmpdir())
    expect([packagePath('agents', 'agents'), agentModuleFile('general-next')]).toEqual(fromApp)
    expect(existsSync(packagePath('agents', 'agents'))).toBe(true)
    expect(agentModuleUrl('general-next')).toBe(`file://${resolve(REPO_ROOT, fromApp[1])}`)
    expect(() => assertPackageLayout(['general', 'general-next'])).not.toThrow()
  })

  it('rejects an agent id that could escape the agents directory', () => {
    expect(() => agentModuleFile('../x')).toThrow('Invalid agent id')
  })

  it('leaves no cwd-relative package path anywhere under evals/ or eval-support/', () => {
    // The entries cannot be imported into CI, so pin the call sites by source.
    const files = [
      ...tsFiles(resolve(APP, 'evals')),
      ...tsFiles(resolve(APP, 'src/lib/eval-support')),
    ]
      .filter((f) => !f.endsWith('package-layout.ts'))
      .map((f) => relative(APP, f))
    expect(files).toEqual(
      expect.arrayContaining([
        'evals/general-next/driver.ts',
        'evals/general-next/run.ts',
        'evals/scenarios/controller.ts',
      ]),
    )
    for (const file of files) {
      const source = read(file)
      expect(source, file).not.toMatch(/['"`](?:\.\.\/)+packages\//)
      expect(source, file).not.toMatch(
        /process\.cwd\(\)\s*,\s*['"](?:\.\.\/)*(?:packages|baml_src)/,
      )
    }
    expect(read('evals/general-next/driver.ts')).toContain('agentModuleUrl(id)')
    expect(read('e2e/scenarios/00-fake-fidelity.e2e.ts')).toContain(
      "packagePath('harness-baml', 'baml_src')",
    )
  })

  it('reads the controller scenario corpus from the one location that holds .baml files', () => {
    expect(read('evals/scenarios/controller.ts')).toContain(
      "packagePath('harness-baml', 'baml_src')",
    )
    expect(
      readdirSync(packagePath('harness-baml', 'baml_src')).some((f) => f.endsWith('.baml')),
    ).toBe(true)
  })
})

describe('the layout check fails before anything is spent', () => {
  it('names what is missing and says nothing was started', () => {
    expect(() => assertPackageLayout(['general-next'], () => false)).toThrow(
      /nothing was started or spent.*packages\/agents\/agents/,
    )
  })

  it('names only the missing agent when the directory is present', () => {
    const exists = (p: string) => !p.endsWith('missing-agent.server.ts')
    expect(() => assertPackageLayout(['general', 'missing-agent'], exists)).toThrow(
      /Missing: packages\/agents\/agents\/missing-agent\.server\.ts\./,
    )
  })

  it('runs in the runner before the proxy child, the fixture and any wake', () => {
    const run = read('evals/general-next/run.ts')
    // Exact top-level statements: the anchor rejects nesting (`if (live) …`), the literal a dropped agent.
    const agents = run.match(/^ {2}const agents = \[\.\.\.new Set\(\['general', candidate\]\)\]$/m)
    const check = run.match(/^ {2}assertPackageLayout\(agents\)$/m)
    expect(agents, 'agents statement').not.toBeNull()
    expect(check, 'layout check statement').not.toBeNull()
    expect(agents!.index).toBeLessThan(check!.index!)
    expect(check!.index).toBeGreaterThan(run.indexOf("process.argv.includes('--list')"))
    for (const later of [
      'startEgressBackstop()',
      'fixtureInference()',
      'ensurePrivateTierAwake()',
      'createDriver(',
    ])
      expect(check!.index, later).toBeLessThan(run.indexOf(later))
  })

  it('preloads every agent before the job loop, so an unloadable one fails before any wake', () => {
    const run = read('evals/general-next/run.ts')
    const driver = read('evals/general-next/driver.ts')
    const create = run.match(
      /^ {4}driver = await createDriver\(fake, live, liveCatalog, agents\)$/m,
    )
    expect(create, 'preloading createDriver call').not.toBeNull()
    expect(create!.index).toBeLessThan(run.indexOf('for (const job of jobs)'))
    expect(create!.index).toBeLessThan(run.indexOf('ensurePrivateTierAwake()'))
    expect(driver).toMatch(/^ {4}for \(const id of preload\) await loadAgent\(id\)$/m)
    // the preload must sit before the driver is returned, i.e. before any run() can be called
    expect(driver.indexOf('for (const id of preload)')).toBeLessThan(
      driver.indexOf('async run(next, key)'),
    )
  })
})

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? tsFiles(resolve(dir, e.name))
      : e.name.endsWith('.ts')
        ? [resolve(dir, e.name)]
        : [],
  )
}
