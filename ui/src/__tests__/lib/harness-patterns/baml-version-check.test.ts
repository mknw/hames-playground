/**
 * BAML client staleness check (#154).
 *
 * Covers the pure comparison only — the filesystem/`import()` gathering in
 * `collectBamlClientWarnings` reads the real working directory, which is not
 * what these assertions are about.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const load = () => import('../../../lib/harness-patterns/baml-version-check.server')

describe('parseGeneratorVersion', () => {
  it('reads the version pin out of a generator block', async () => {
    const { parseGeneratorVersion } = await load()
    const source = `generator target {
    output_type "typescript"
    output_dir "../"
    version "0.224.0"
    default_client_mode async
}`
    expect(parseGeneratorVersion(source)).toBe('0.224.0')
  })

  it('returns null when there is no version pin', async () => {
    const { parseGeneratorVersion } = await load()
    expect(parseGeneratorVersion('generator target {\n  output_type "typescript"\n}')).toBeNull()
  })

  it('ignores api_version (client blocks, not the generator pin)', async () => {
    const { parseGeneratorVersion } = await load()
    const source =
      'client<llm> CustomAzure {\n  options {\n    api_version "2024-10-01-preview"\n  }\n}'
    expect(parseGeneratorVersion(source)).toBeNull()
  })
})

describe('checkBamlClient', () => {
  it('is silent when every version agrees and the sources match', async () => {
    const { checkBamlClient } = await load()
    const sources = { 'generators.baml': 'a', 'clients.baml': 'b' }
    expect(
      checkBamlClient({
        pinnedVersion: '0.224.0',
        installedVersion: '0.224.0',
        clientVersion: '0.224.0',
        generatedSources: sources,
        diskSources: { ...sources },
      }),
    ).toEqual([])
  })

  it('warns when the generator pin and the installed package disagree', async () => {
    const { checkBamlClient } = await load()
    const warnings = checkBamlClient({
      pinnedVersion: '0.224.0',
      installedVersion: '0.225.1',
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0].kind).toBe('version-mismatch')
    expect(warnings[0].message).toContain('0.224.0')
    expect(warnings[0].message).toContain('0.225.1')
    expect(warnings[0].message).toContain('pnpm baml-generate')
  })

  it('warns when the client stamp lags the generator pin', async () => {
    const { checkBamlClient } = await load()
    const warnings = checkBamlClient({
      pinnedVersion: '0.225.1',
      installedVersion: '0.225.1',
      clientVersion: '0.224.0',
    })
    expect(warnings.map((w) => w.kind)).toEqual(['version-mismatch'])
  })

  it('does not warn on versions when only one of them is readable', async () => {
    const { checkBamlClient } = await load()
    expect(checkBamlClient({ pinnedVersion: '0.224.0' })).toEqual([])
    expect(checkBamlClient({ installedVersion: '0.224.0', clientVersion: null })).toEqual([])
    expect(checkBamlClient({})).toEqual([])
  })

  it('flags a stale client when a .baml source changed since generation', async () => {
    const { checkBamlClient } = await load()
    const warnings = checkBamlClient({
      generatedSources: { 'simpleLoop.baml': 'function LoopController(a, b) {}' },
      diskSources: { 'simpleLoop.baml': 'function LoopController(a, b, c) {}' },
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0].kind).toBe('stale-client')
    expect(warnings[0].message).toContain('simpleLoop.baml')
    expect(warnings[0].message).toContain('pnpm baml-generate')
  })

  it('flags added and removed .baml files, listed alphabetically', async () => {
    const { checkBamlClient } = await load()
    const warnings = checkBamlClient({
      generatedSources: { 'removed.baml': 'x', 'kept.baml': 'same' },
      diskSources: { 'added.baml': 'y', 'kept.baml': 'same' },
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('added.baml, removed.baml')
    expect(warnings[0].message).not.toContain('kept.baml')
  })

  it('stays silent on source drift when either snapshot is unreadable', async () => {
    const { checkBamlClient } = await load()
    expect(checkBamlClient({ diskSources: { 'a.baml': 'x' } })).toEqual([])
    expect(checkBamlClient({ generatedSources: { 'a.baml': 'x' }, diskSources: null })).toEqual([])
  })

  it('reports version drift and source drift independently', async () => {
    const { checkBamlClient } = await load()
    const warnings = checkBamlClient({
      pinnedVersion: '0.224.0',
      installedVersion: '0.225.1',
      generatedSources: { 'a.baml': 'x' },
      diskSources: { 'a.baml': 'y' },
    })
    expect(warnings.map((w) => w.kind)).toEqual(['version-mismatch', 'stale-client'])
  })
})

describe('runBamlClientCheckOnce', () => {
  it('is a no-op under vitest and runs at most once per process', async () => {
    const { runBamlClientCheckOnce, __resetBamlClientCheckForTests } = await load()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    __resetBamlClientCheckForTests()
    runBamlClientCheckOnce()
    runBamlClientCheckOnce()
    await Promise.resolve()
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('warns once per finding when the vitest guard is lifted, never twice', async () => {
    const { runBamlClientCheckOnce, collectBamlClientWarnings, __resetBamlClientCheckForTests } =
      await load()
    // The check reads the real tree; whatever it finds there, the boot hook
    // must report it exactly once no matter how many times boot calls it.
    const expected = await collectBamlClientWarnings()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const savedVitest = process.env.VITEST
    delete process.env.VITEST
    __resetBamlClientCheckForTests()

    try {
      runBamlClientCheckOnce()
      runBamlClientCheckOnce()
      await vi.waitFor(() => expect(warnSpy.mock.calls).toHaveLength(expected.length))
    } finally {
      if (savedVitest === undefined) delete process.env.VITEST
      else process.env.VITEST = savedVitest
      warnSpy.mockRestore()
      __resetBamlClientCheckForTests()
    }
  })
})

describe('collectBamlClientWarnings', () => {
  it('reads the real baml_src / baml_client and returns well-formed warnings', async () => {
    const { collectBamlClientWarnings } = await load()

    const warnings = await collectBamlClientWarnings()

    expect(Array.isArray(warnings)).toBe(true)
    for (const w of warnings) {
      expect(['stale-client', 'version-mismatch']).toContain(w.kind)
      expect(w.message).toMatch(/baml/i)
    }
  })

  it('reports no staleness against a freshly generated client', async () => {
    // `pnpm baml-generate` runs before the suite (predev / CI step), so a
    // stale-client warning here means the generated client really has drifted.
    const { collectBamlClientWarnings } = await load()

    const warnings = await collectBamlClientWarnings()

    expect(warnings.filter((w) => w.kind === 'stale-client')).toEqual([])
  })
})
