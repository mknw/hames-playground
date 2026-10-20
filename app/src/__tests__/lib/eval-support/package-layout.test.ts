// @vitest-environment node
/** Eval entries find packages/ from their own files, and refuse to start when it is missing. */
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
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

  it('leaves no cwd-relative package path in the eval entries', () => {
    // The entries cannot be imported into CI, so pin the call sites by source.
    for (const file of [
      'evals/general-next/driver.ts',
      'evals/general-next/run.ts',
      'evals/scenarios/controller.ts',
    ]) {
      const source = read(file)
      expect(source, file).not.toMatch(/['"`](?:\.\.\/)+packages\//)
      expect(source, file).not.toMatch(/process\.cwd\(\)\s*,\s*['"]baml_src/)
    }
    expect(read('evals/general-next/driver.ts')).toContain('agentModuleUrl(key.agent)')
    expect(read('evals/scenarios/controller.ts')).toContain("packagePath('harness-baml'")
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
    const check = run.indexOf('assertPackageLayout(')
    expect(check).toBeGreaterThan(run.indexOf("process.argv.includes('--list')"))
    for (const later of [
      'startEgressBackstop()',
      'fixtureInference()',
      'ensurePrivateTierAwake()',
      'createDriver(',
    ])
      expect(check, later).toBeLessThan(run.indexOf(later))
  })
})
