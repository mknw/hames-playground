/**
 * The operator entry point for one clone's environment VM (`scripts/incus-environment.ts`).
 *
 * `main()` runs with an injected controller, probe, clock and output, so nothing
 * here reaches Incus or Docker; the controller itself is pinned against a fake
 * Incus API in `incus-environment.test.ts`, and the probe against real TLS in
 * `incus-docker-probe.test.ts`.
 */
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
import type { DockerProbe, IncusEnvironmentOptions } from '../../incus-environment.server'
import { main, VOLATILE, type Deps } from '../../scripts/incus-environment'

let root: string, state: string, delivery: string, configFile: string
let printed: string[], probes: DockerProbe[], created: IncusEnvironmentOptions[]
let reconcile: ReturnType<typeof vi.fn>, teardown: ReturnType<typeof vi.fn>, clock: number

const config = () => ({
  environment: 'dev',
  manager: {
    url: 'https://incus.example.test:8443',
    ca: join(root, 'manager-ca.pem'),
    cert: join(root, 'manager-cert.pem'),
    key: join(root, 'manager-key.pem'),
  },
  bridge: 'devbr',
  address: '10.77.2.2',
  storagePool: 'sandbox-pool',
  image: { server: 'https://images.example.test', fingerprint: 'a'.repeat(64) },
  quota: { cpu: 2, memoryMiB: 2048, diskGiB: 24, rootDiskGiB: 16 },
  stateDirectory: state,
  delivery: { directory: delivery },
})
async function writeConfig(value: unknown) {
  await writeFile(configFile, JSON.stringify(value))
}
const deps = (): Deps => ({
  create: (options) => {
    created.push(options)
    return { reconcile, teardown } as never
  },
  probe: async () => probes.shift() ?? { ready: false, reason: 'unreachable' },
  out: (line) => printed.push(line),
  volatile: [join(root, 'volatile')],
  sleep: async (ms) => {
    clock += ms
  },
  now: () => clock,
})
const run = (...argv: string[]) => main(argv, deps())
// The provisioner's own files, as reconcile returns them.
const stateEnv = () => ({
  SANDBOX_DOCKER_HOST: 'tcp://10.77.2.2:2376',
  SANDBOX_DOCKER_TLS_CA: join(state, 'ca.pem'),
  SANDBOX_DOCKER_TLS_CERT: join(state, 'client.pem'),
  SANDBOX_DOCKER_TLS_KEY: join(state, 'client-key.pem'),
})
const issued = async (generation: string) => {
  await mkdir(state, { recursive: true, mode: 0o700 })
  for (const name of ['ca.pem', 'client.pem', 'client-key.pem', 'ca-key.pem'])
    await writeFile(join(state, name), `${generation} ${name}\n`, { mode: 0o600 })
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'sandbox-incus-cli-')))
  state = join(root, 'state')
  delivery = join(root, 'delivery')
  configFile = join(root, 'dev.json')
  for (const name of ['manager-ca.pem', 'manager-cert.pem', 'manager-key.pem'])
    await writeFile(join(root, name), `synthetic ${name}`)
  await writeConfig(config())
  await issued('first')
  printed = []
  probes = []
  created = []
  clock = Date.parse('2026-10-21T00:00:00Z')
  reconcile = vi.fn(async () => ({ project: 'sandbox-dev', dockerEnv: stateEnv() }))
  teardown = vi.fn(async () => undefined)
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('reconcile delivers only the clone client files', () => {
  it('copies the three files privately, records the connection and prints the root inputs', async () => {
    expect(await run('reconcile', configFile)).toBe(0)
    expect(created[0].manager).toEqual({
      url: 'https://incus.example.test:8443',
      ca: 'synthetic manager-ca.pem',
      cert: 'synthetic manager-cert.pem',
      key: 'synthetic manager-key.pem',
    })
    expect((await stat(delivery)).mode & 0o777).toBe(0o700)
    expect((await readdir(delivery)).sort()).toEqual([
      'ca.pem',
      'cert.pem',
      'connection.json',
      'key.pem',
    ])
    for (const [name, source] of [
      ['ca.pem', 'ca.pem'],
      ['cert.pem', 'client.pem'],
      ['key.pem', 'client-key.pem'],
    ]) {
      expect(await readFile(join(delivery, name), 'utf8')).toBe(`first ${source}\n`)
      expect((await stat(join(delivery, name))).mode & 0o777).toBe(0o600)
    }
    const delivered = {
      SANDBOX_DOCKER_HOST: 'tcp://10.77.2.2:2376',
      SANDBOX_DOCKER_TLS_CA: join(delivery, 'ca.pem'),
      SANDBOX_DOCKER_TLS_CERT: join(delivery, 'cert.pem'),
      SANDBOX_DOCKER_TLS_KEY: join(delivery, 'key.pem'),
    }
    expect(JSON.parse(await readFile(join(delivery, 'connection.json'), 'utf8'))).toEqual(delivered)
    for (const [key, value] of Object.entries(delivered))
      expect(printed).toContain(`DEV_${key}=${value}`)
    expect(printed.join('\n')).not.toMatch(/first|ca-key|synthetic manager/)
  })

  it('tightens a loose delivered file even when its content is unchanged', async () => {
    await run('reconcile', configFile)
    await chmod(join(delivery, 'key.pem'), 0o644)
    expect(await run('reconcile', configFile)).toBe(0)
    expect((await stat(join(delivery, 'key.pem'))).mode & 0o777).toBe(0o600)
  })

  it('leaves unchanged files as the same inode and replaces rotated ones', async () => {
    await run('reconcile', configFile)
    const before = (await stat(join(delivery, 'key.pem'))).ino
    expect(await run('reconcile', configFile)).toBe(0)
    expect((await stat(join(delivery, 'key.pem'))).ino).toBe(before)
    await issued('second')
    expect(await run('reconcile', configFile)).toBe(0)
    expect(await readFile(join(delivery, 'key.pem'), 'utf8')).toBe('second client-key.pem\n')
  })

  it('refuses a group-readable delivery directory, also behind a link', async () => {
    const target = join(root, 'elsewhere')
    await mkdir(target)
    await chmod(target, 0o750)
    for (const directory of [target, join(root, 'link')]) {
      if (directory !== target) await symlink(target, directory)
      await writeConfig({ ...config(), delivery: { directory } })
      expect(await run('reconcile', configFile), directory).toBe(1)
      expect(printed.at(-1)).toMatch(/private \(0700\) directory/)
    }
    await chmod(target, 0o700)
    expect(await run('reconcile', configFile)).toBe(0)
    expect((await lstat(join(target, 'key.pem'))).isFile()).toBe(true)
  })

  it.each([
    ['inside the state directory', () => join(state, 'deliver')],
    ['equal to the state directory', () => state],
    ['containing the state directory', () => root],
  ])('refuses a delivery directory %s', async (_label, directory) => {
    await writeConfig({ ...config(), delivery: { directory: directory() } })
    expect(await run('reconcile', configFile)).toBe(1)
    expect(printed.at(-1)).toMatch(/must not contain each other/)
    expect(created).toEqual([])
  })
})

describe('the config and the paths must survive a reboot', () => {
  it.each([
    ['an unknown top-level key', (c: Record<string, unknown>) => ({ ...c, restricted: false })],
    [
      'an unknown nested key',
      (c: Record<string, any>) => ({ ...c, quota: { ...c.quota, gpu: 1 } }),
    ], // eslint-disable-line @typescript-eslint/no-explicit-any -- config fixture
    ['a missing key', ({ bridge: _bridge, ...c }: Record<string, unknown>) => c],
    ['a wrong type', (c: Record<string, unknown>) => ({ ...c, quota: '2' })],
    [
      'a misplaced owner',
      (c: Record<string, any>) => ({ ...c, delivery: { ...c.delivery, owner: 1000 } }),
    ], // eslint-disable-line @typescript-eslint/no-explicit-any -- config fixture
  ])('refuses %s before any request', async (_label, change) => {
    await writeConfig(change(config()))
    expect(await run('reconcile', configFile)).toBe(1)
    expect(printed.at(-1)).toMatch(/^refused: config /)
    expect(created).toEqual([])
  })

  it('refuses a config that is not JSON without echoing it', async () => {
    await writeFile(configFile, 'secret-synthetic')
    expect(await run('reconcile', configFile)).toBe(1)
    expect(printed.join('\n')).not.toContain('secret-synthetic')
  })

  it.each(['stateDirectory', 'delivery'])(
    'refuses a %s on a mount that does not survive a reboot, also behind a link',
    async (setting) => {
      const volatile = join(root, 'volatile')
      await mkdir(volatile)
      await symlink(volatile, join(root, 'looks-persistent'))
      for (const path of [join(volatile, 'dev'), join(root, 'looks-persistent', 'dev')]) {
        const value =
          setting === 'delivery'
            ? { ...config(), delivery: { directory: path } }
            : { ...config(), stateDirectory: path }
        await writeConfig(value)
        printed = []
        expect(await run('reconcile', configFile), path).toBe(1)
        expect(printed.at(-1)).toMatch(/must survive a host reboot/)
      }
      expect(created).toEqual([])
    },
  )

  it('treats tmpfs and aged-out mounts as volatile by default', () => {
    for (const mount of ['/tmp', '/var/tmp', '/run', '/var/run', '/dev'])
      expect(VOLATILE).toContain(mount)
  })

  it('holds one operation per state directory, and releases it on failure', async () => {
    await writeFile(`${state}.lock`, '1\n')
    expect(await run('reconcile', configFile)).toBe(1)
    expect(printed.at(-1)).toMatch(/another operation may be running/)
    expect(created).toEqual([])
    await rm(`${state}.lock`)
    reconcile.mockRejectedValueOnce(new Error('Incus VM configuration has drifted'))
    expect(await run('reconcile', configFile)).toBe(1)
    expect(printed.at(-1)).toBe('refused: Incus VM configuration has drifted')
    await expect(stat(`${state}.lock`)).rejects.toThrow()
  })
})

describe('health probes the delivered files and waits only for what can change', () => {
  beforeEach(async () => {
    await run('reconcile', configFile)
    printed = []
    created = []
  })

  it('probes with the delivered connection and reports the certificate lifetime', async () => {
    const seen: unknown[] = []
    const probe: Deps['probe'] = async (env) => {
      seen.push(env)
      return {
        ready: true,
        clientCertificateValidTo: new Date(clock + 200 * 86_400_000).toUTCString(),
      }
    }
    expect(await main(['health', configFile], { ...deps(), probe })).toBe(0)
    expect(seen).toEqual([JSON.parse(await readFile(join(delivery, 'connection.json'), 'utf8'))])
    expect(printed).toEqual([
      'Docker ready at tcp://10.77.2.2:2376; client certificate valid for 200 more days',
    ])
    expect(created).toEqual([])
  })

  it('warns when the client certificate is due for rotation', async () => {
    probes = [
      { ready: true, clientCertificateValidTo: new Date(clock + 5 * 86_400_000).toUTCString() },
    ]
    expect(await run('health', configFile)).toBe(0)
    expect(printed.at(-1)).toMatch(/^WARNING: rotate soon/)
  })

  it('waits through unreachable, refused and not-ready answers until its budget', async () => {
    probes = [
      { ready: false, reason: 'unreachable' },
      { ready: false, reason: 'refused' },
      { ready: false, reason: 'not-ready' },
      { ready: true, clientCertificateValidTo: new Date(clock + 200 * 86_400_000).toUTCString() },
    ]
    expect(await run('health', configFile, '--wait', '600')).toBe(0)
    expect(probes).toEqual([])
    const start = clock
    expect(await run('health', configFile, '--wait', '12')).toBe(1)
    expect(clock - start).toBe(15_000)
    expect(printed.at(-1)).toBe('Docker not ready at tcp://10.77.2.2:2376: unreachable')
  })

  it("stops at once on a daemon that is not this environment's", async () => {
    probes = [
      { ready: false, reason: 'untrusted-server' },
      { ready: true, clientCertificateValidTo: '' },
    ]
    expect(await run('health', configFile, '--wait', '600')).toBe(1)
    expect(probes).toHaveLength(1)
    expect(printed.at(-1)).toMatch(/untrusted-server$/)
  })

  it('probes once without --wait and refuses before anything was delivered', async () => {
    expect(await run('health', configFile)).toBe(1)
    await rm(delivery, { recursive: true })
    expect(await run('health', configFile)).toBe(1)
    expect(printed.at(-1)).toMatch(/run reconcile first/)
  })
})

describe('teardown', () => {
  it('removes the VM, then exactly the delivered files', async () => {
    await run('reconcile', configFile)
    await writeFile(join(delivery, 'operator-note.txt'), 'kept')
    expect(await run('teardown', configFile)).toBe(0)
    expect(teardown).toHaveBeenCalledOnce()
    expect(await readdir(delivery).catch(() => [])).toEqual(['operator-note.txt'])
    await rm(join(delivery, 'operator-note.txt'))
    await run('reconcile', configFile)
    expect(await run('teardown', configFile)).toBe(0)
    await expect(stat(delivery)).rejects.toThrow()
  })

  it('keeps the delivered files when teardown fails', async () => {
    await run('reconcile', configFile)
    teardown.mockRejectedValueOnce(new Error('Incus restricted certificate is missing'))
    expect(await run('teardown', configFile)).toBe(1)
    expect((await readdir(delivery)).sort()).toEqual([
      'ca.pem',
      'cert.pem',
      'connection.json',
      'key.pem',
    ])
  })
})

it.each([
  [[]],
  [['provision', 'x.json']],
  [['reconcile']],
  [['reconcile', 'x.json', '--wait', '5']],
  [['health', 'x.json', '--wait']],
  [['health', 'x.json', '--wait', '-1']],
  [['health', 'x.json', '--wait', '1.5']],
])('rejects usage %j', async (argv) => {
  expect(await run(...argv)).toBe(2)
  expect(created).toEqual([])
})
