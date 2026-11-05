/**
 * The hermetic layers never reach a hosted MCP server (PR #986 review D1).
 *
 * A developer's env can carry live credentials for the hosted Exa and Lenny's
 * Data transports, and any suite that loads `app-tools/index.server.ts` builds
 * them from the environment. Each hermetic layer therefore forces both
 * switches off in the one place that layer sets its environment. A source scan
 * rather than a run, because layers 2 and 3 are not part of this job; the unit
 * layer is also checked live, since this file runs under its setup.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const LAYERS = [
  ['unit setup', 'src/__tests__/setup.ts', /^process\.env\.(\w+) = 'off'$/gm],
  ['app-path e2e', 'e2e/vitest.config.ts', /^\s+(\w+): 'off',/gm],
  ['browser e2e', 'e2e-browser/global-setup.ts', /^\s+(\w+): 'off',/gm],
] as const

const SWITCHES = ['EXA_TOOLS', 'LENNYS_DATA_MCP']

describe('hosted MCP switches are forced off in every hermetic layer', () => {
  // MUTATION: delete the LENNYS_DATA_MCP (or EXA_TOOLS) line from any one of
  // the three files.
  it.each(LAYERS)('%s (%s) forces both switches off', (_layer, path, pattern) => {
    const forced = [...readFileSync(path, 'utf8').matchAll(pattern)].map((m) => m[1])
    for (const name of SWITCHES) expect(forced, `${path} must force ${name}=off`).toContain(name)
  })

  it('the unit run itself sees both switches off', () => {
    for (const name of SWITCHES) expect(process.env[name]).toBe('off')
  })
})
