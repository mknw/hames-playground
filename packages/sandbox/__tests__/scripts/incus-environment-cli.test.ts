/**
 * The operator entry point for one clone's environment VM (`scripts/incus-environment.ts`).
 *
 * `main()` runs with an injected controller, probe, clock and output, so nothing
 * here reaches Incus or Docker; the controller itself is pinned against a fake
 * Incus API in `incus-environment.test.ts`, and the probe against real TLS in
 * `incus-docker-probe.test.ts`.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmod,
  chown,
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
// An unprivileged test cannot hand files to another user: record the calls.
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  chown: vi.fn(async () => undefined),
}))
import type { DockerProbe, IncusEnvironmentOptions } from '../../incus-environment.server'
import { main, VOLATILE, type Deps } from '../../scripts/incus-environment'

let root: string, state: string, delivery: string, configFile: string
let printed: string[], probes: DockerProbe[], created: IncusEnvironmentOptions[]
let reconcile: ReturnType<typeof vi.fn>, teardown: ReturnType<typeof vi.fn>, clock: number
// A real client certificate for `health`, which reads its expiry before probing.
let certificates: string, clientCertificate: string

const config = () => ({
  environment: 'dev',
  manager: {
    url: 'https://incus.example.test:8443',
    ca: join(root, 'manager-ca.pem'),
    cert: join(root, 'manager-cert.pem'),
    key: join(root, 'manager-key.pem'),
  },
  bridge: 'devbr',
  address: '198.51.100.2',
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
  SANDBOX_DOCKER_HOST: 'tcp://198.51.100.2:2376',
  SANDBOX_DOCKER_TLS_CA: join(state, 'ca.pem'),
  SANDBOX_DOCKER_TLS_CERT: join(state, 'client.pem'),
  SANDBOX_DOCKER_TLS_KEY: join(state, 'client-key.pem'),
})
const issued = async (generation: string) => {
  await mkdir(state, { recursive: true, mode: 0o700 })
  for (const name of ['ca.pem', 'client.pem', 'client-key.pem', 'ca-key.pem'])
    await writeFile(join(state, name), `${generation} ${name}\n`, { mode: 0o600 })
}
const bootId = () =>
  readFile('/proc/sys/kernel/random/boot_id', 'utf8').then(
    (id) => id.trim(),
    () => '',
  )

beforeAll(async () => {
  certificates = await mkdtemp(join(tmpdir(), 'sandbox-incus-cli-cert-'))
  execFileSync(
    'openssl',
    [
      ...['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=dev'],
      ...['-keyout', join(certificates, 'key.pem'), '-out', join(certificates, 'cert.pem')],
    ],
    { stdio: 'ignore' },
  )
  clientCertificate = await readFile(join(certificates, 'cert.pem'), 'utf8')
})
afterAll(() => rm(certificates, { recursive: true, force: true }))
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
  vi.mocked(chown).mockClear()
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('reconcile delivers only the clone client files', () => {
  it('copies the three files privately, records the connection and prints the root inputs', async () => {
    expect(await run('reconcile', configFile)).toBe(0)
    // The library receives its own options, never the delivery settings.
    const { delivery: _delivery, ...options } = config()
    expect(created).toEqual([
      {
        ...options,
        manager: {
          url: 'https://incus.example.test:8443',
          ca: 'synthetic manager-ca.pem',
          cert: 'synthetic manager-cert.pem',
          key: 'synthetic manager-key.pem',
        },
      },
    ])
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
      SANDBOX_DOCKER_HOST: 'tcp://198.51.100.2:2376',
      SANDBOX_DOCKER_TLS_CA: join(delivery, 'ca.pem'),
      SANDBOX_DOCKER_TLS_CERT: join(delivery, 'cert.pem'),
      SANDBOX_DOCKER_TLS_KEY: join(delivery, 'key.pem'),
    }
    expect(JSON.parse(await readFile(join(delivery, 'connection.json'), 'utf8'))).toEqual(delivered)
    for (const [key, value] of Object.entries(delivered))
      expect(printed).toContain(`DEV_${key}=${value}`)
    expect(printed.join('\n')).not.toMatch(/first|ca-key|synthetic manager|not a clone/)
    expect(chown).not.toHaveBeenCalled()
  })

  it('hands the directory and every delivered file to delivery.owner, on every run', async () => {
    await writeConfig({
      ...config(),
      delivery: { directory: delivery, owner: { uid: 4242, gid: 4343 } },
    })
    const owned = [
      delivery,
      ...['ca.pem', 'cert.pem', 'key.pem', 'connection.json'].map((name) => join(delivery, name)),
    ]
    for (const label of ['first run', 'unchanged rerun']) {
      vi.mocked(chown).mockClear()
      expect(await run('reconcile', configFile), label).toBe(0)
      expect(
        vi
          .mocked(chown)
          .mock.calls.map(([path, uid, gid]) => [path, uid, gid])
          .sort(),
        label,
      ).toEqual(owned.map((path) => [path, 4242, 4343]).sort())
    }
  })

  it('prefixes the root inputs with the environment, and says when no clone reads them', async () => {
    await writeConfig({ ...config(), environment: 'dev-2' })
    expect(await run('reconcile', configFile)).toBe(0)
    expect(printed).toContain('DEV_2_SANDBOX_DOCKER_HOST=tcp://198.51.100.2:2376')
    expect(printed).toContain(
      'NOTE: dev-2 is not a clone (dev or release): no Compose overlay reads DEV_2_* inputs',
    )
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

  it('leaves no staged copy of a file it could not put in place', async () => {
    await mkdir(join(delivery, 'key.pem'), { recursive: true, mode: 0o700 })
    await chmod(delivery, 0o700)
    expect(await run('reconcile', configFile)).toBe(1)
    expect((await readdir(delivery)).sort()).toEqual(['ca.pem', 'cert.pem', 'key.pem'])
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

  it.each([
    ['stateDirectory', (c: ReturnType<typeof config>) => ({ ...c, stateDirectory: 'state' })],
    [
      'delivery.directory',
      (c: ReturnType<typeof config>) => ({ ...c, delivery: { directory: 'delivery' } }),
    ],
  ])('refuses a relative %s', async (label, change) => {
    await writeConfig(change(config()))
    expect(await run('reconcile', configFile)).toBe(1)
    expect(printed.at(-1)).toBe(`refused: ${label} must be an absolute path`)
    expect(created).toEqual([])
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

  it('treats tmpfs and aged-out mounts as volatile by default, under their macOS names too', () => {
    for (const mount of ['/tmp', '/var/tmp', '/run', '/var/run', '/dev'])
      expect(VOLATILE).toContain(mount)
    for (const mount of ['/tmp', '/var/tmp', '/var/run', '/var/folders'])
      expect(VOLATILE).toContain(`/private${mount}`)
  })

  // macOS resolves these through /private; Linux keeps them, or /var/run -> /run.
  it.each(['/tmp', '/var/tmp', '/var/run'])(
    'refuses %s as this host resolves it',
    async (mount) => {
      await writeConfig({ ...config(), stateDirectory: join(mount, 'hames-absent', 'state') })
      expect(await main(['reconcile', configFile], { ...deps(), volatile: VOLATILE })).toBe(1)
      expect(printed.at(-1)).toMatch(/^refused: stateDirectory must survive a host reboot/)
      expect(created).toEqual([])
    },
  )
})

describe('one operation per state directory', () => {
  const lock = () => `${state}.lock`

  it('records its pid and boot while it runs, and releases the lock on failure', async () => {
    let held = ''
    reconcile.mockImplementationOnce(async () => {
      held = await readFile(lock(), 'utf8')
      throw new Error('Incus VM configuration has drifted')
    })
    expect(await run('reconcile', configFile)).toBe(1)
    expect(printed.at(-1)).toBe('refused: Incus VM configuration has drifted')
    expect(held).toBe(`${process.pid}\n${await bootId()}\n`)
    await expect(stat(lock())).rejects.toThrow()
  })

  it.each([
    ['a running process', async () => `${process.pid}\n${await bootId()}\n`],
    ['pid 1, recorded without a boot', async () => '1\n'],
    ['an unreadable record', async () => 'synthetic\n'],
  ])('refuses a lock held by %s', async (_label, record) => {
    await writeFile(lock(), await record())
    expect(await run('reconcile', configFile)).toBe(1)
    expect(printed.at(-1)).toMatch(/another operation may be running/)
    expect(created).toEqual([])
    await expect(readFile(lock(), 'utf8')).resolves.toBe(await record())
  })

  it.each([
    [
      'a process that has exited',
      async () => `${spawnSync(process.execPath, ['-e', '']).pid}\n${await bootId()}\n`,
    ],
    ['a process of an earlier boot', async () => `${process.pid}\nsynthetic-earlier-boot\n`],
  ])('reclaims a lock left by %s, and says so', async (_label, record) => {
    const recorded = await record()
    await writeFile(lock(), recorded)
    expect(await run('reconcile', configFile)).toBe(0)
    expect(printed[0]).toBe(
      `reclaimed ${lock()}: process ${recorded.split('\n')[0]} that held it is gone`,
    )
    expect(created).toHaveLength(1)
    await expect(stat(lock())).rejects.toThrow()
  })
})

describe('health probes the delivered files and waits only for what can change', () => {
  beforeEach(async () => {
    await run('reconcile', configFile)
    await writeFile(join(delivery, 'cert.pem'), clientCertificate)
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
      'Docker ready at tcp://198.51.100.2:2376; client certificate valid for 200 more days',
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

  it('names rotation at once for an expired client certificate, without probing', async () => {
    probes = [{ ready: false, reason: 'refused' }]
    const { validTo } = new (await import('node:crypto')).X509Certificate(clientCertificate)
    clock = Date.parse(validTo) + 1
    expect(await run('health', configFile, '--wait', '600')).toBe(1)
    expect(printed).toEqual([
      'client certificate expired: rotate it (teardown, then reconcile, then recreate the app)',
    ])
    expect(probes).toHaveLength(1)
  })

  it('refuses an unreadable client certificate without echoing it', async () => {
    await writeFile(join(delivery, 'cert.pem'), 'secret-synthetic')
    expect(await run('health', configFile)).toBe(1)
    expect(printed).toEqual(['refused: the delivered client certificate is unreadable'])
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
    expect(printed.at(-1)).toBe('Docker not ready at tcp://198.51.100.2:2376: unreachable')
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

  it.each([
    [
      'an extra key',
      (c: Record<string, unknown>) => ({ ...c, DOCKER_HOST: 'unix:///var/run/docker.sock' }),
    ],
    ['a missing key', ({ SANDBOX_DOCKER_TLS_KEY: _key, ...c }: Record<string, unknown>) => c],
    [
      'a value that is not a string',
      (c: Record<string, unknown>) => ({ ...c, SANDBOX_DOCKER_HOST: 2376 }),
    ],
  ])('refuses a connection.json with %s', async (_label, change) => {
    const connection = join(delivery, 'connection.json')
    await writeFile(
      connection,
      JSON.stringify(change(JSON.parse(await readFile(connection, 'utf8')))),
    )
    expect(await run('health', configFile)).toBe(1)
    expect(printed).toEqual(['refused: connection.json is not a delivered connection'])
  })
})

describe('teardown', () => {
  it('removes the VM, then exactly the delivered files, and says what it kept', async () => {
    await run('reconcile', configFile)
    await writeFile(join(delivery, 'operator-note.txt'), 'kept')
    expect(await run('teardown', configFile)).toBe(0)
    expect(teardown).toHaveBeenCalledOnce()
    expect(await readdir(delivery).catch(() => [])).toEqual(['operator-note.txt'])
    expect(printed.slice(-2)).toEqual([
      'delivery directory kept: other files remain',
      'dev environment VM torn down; its delivered files are removed',
    ])
    await rm(join(delivery, 'operator-note.txt'))
    await run('reconcile', configFile)
    printed = []
    expect(await run('teardown', configFile)).toBe(0)
    await expect(stat(delivery)).rejects.toThrow()
    expect(printed).toEqual(['dev environment VM torn down; its delivered files are removed'])
    // Nothing left to remove is not a failure: teardown can be re-run.
    expect(await run('teardown', configFile)).toBe(0)
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
