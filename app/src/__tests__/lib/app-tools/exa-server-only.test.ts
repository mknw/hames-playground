/** Pin the hosted Exa module's runtime boundary and credential isolation. */
import { describe, expect, it } from 'vitest'

import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const SRC = resolve(process.cwd(), 'src')
const EXA = join(SRC, 'lib/app-tools/exa.server.ts')

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await filesUnder(full)))
    else out.push(full)
  }
  return out
}

describe('source scan: the hosted-Exa transport stays server-only', () => {
  it('exa.server.ts carries the runtime server-only assert', async () => {
    const source = await readFile(EXA, 'utf8')
    expect(
      /assertServerOnImport\(\)/.test(source),
      'exa.server.ts must call assertServerOnImport() at module scope',
    ).toBe(true)
  })

  it('EXA_API_KEY is referenced only by server-suffixed modules', async () => {
    const offenders: string[] = []
    for (const path of await filesUnder(SRC)) {
      if (path.endsWith('.server.ts') || path.endsWith('.test.ts')) continue
      if (path.includes('__mocks__')) continue
      const source = await readFile(path, 'utf8')
      if (source.includes('EXA_API_KEY')) offenders.push(path)
    }
    expect(offenders).toEqual([])
  })
})
