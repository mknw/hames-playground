import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('nested VM spike offline safety checks', () => {
  it.each([{ args: [] }, { args: ['--mutations'] }])(
    'runs the hermetic checks $args',
    ({ args }) => {
      const result = spawnSync('python3', ['scripts/sandbox-vm.test.py', ...args], {
        cwd: root,
        encoding: 'utf8',
        timeout: 120_000,
      })
      expect(result.status, result.stdout + result.stderr).toBe(0)
    },
    130_000, // The mutation matrix launches a fresh Python process for every named pin.
  )

  it('renders the wrapper plan without a daemon', () => {
    const result = spawnSync('bash', ['scripts/sandbox-vm-spike.sh', '--install', '--provision'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: 'dry-run',
      steps: ['install', 'provision'],
      target: 'the target host',
    })
  })
})
