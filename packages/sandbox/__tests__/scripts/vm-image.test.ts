import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const scripts = ['build.test.py', 'helpers.test.py'].map((name) =>
  fileURLToPath(new URL('../../scripts/vm-image/' + name, import.meta.url)),
)

describe('VM image offline stages', () => {
  it.each(
    scripts.flatMap((script) => [
      { script, args: [] },
      { script, args: ['--mutations'] },
    ]),
  )(
    'runs hermetic Python checks $script $args',
    ({ script, args }) => {
      const result = spawnSync('python3', [script, ...args], {
        encoding: 'utf8',
        timeout: 60_000,
      })
      expect(result.status, result.stdout + result.stderr).toBe(0)
    },
    // The expanded per-mutation child matrix exceeds Vitest's 5 s default.
    60_000,
  )
})
