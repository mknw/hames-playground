import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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

  // One store from image assembly to boot: the image preloads the classic overlay2
  // store, and a boot daemon on Docker 29's containerd default would see none of it.
  it('pins the same Docker store at assembly and in both boot-time writers', () => {
    const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
    const assembly = read('packages/sandbox/scripts/vm-image/customize.sh').match(
      /printf '(\{"features".*?\})\\n' > \/opt\/vm-image\/assembly-daemon\.json/,
    )
    expect(assembly).not.toBeNull()
    const store = { features: { 'containerd-snapshotter': false }, 'storage-driver': 'overlay2' }
    expect(JSON.parse(assembly![1])).toEqual(store)
    expect(read('packages/sandbox/incus-environment.server.ts')).toMatch(
      /'storage-driver': 'overlay2',\s*features: \{ 'containerd-snapshotter': false \}/,
    )
    expect(read('scripts/lib/sandbox_vm.py')).toMatch(
      /"storage-driver": "overlay2", "features": \{"containerd-snapshotter": False\}/,
    )
  })

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
