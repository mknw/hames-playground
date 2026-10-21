/**
 * Operator entry point for one clone's environment VM (#648). Not package
 * surface: repository tooling, run as a `tsx` script on the operator side.
 *
 *   incus-environment.ts reconcile <config.json>
 *   incus-environment.ts health <config.json> [--wait <seconds>]
 *   incus-environment.ts teardown <config.json>
 *
 * `reconcile` creates or verifies the VM through `createIncusEnvironment`, then
 * delivers only that clone's three Docker client files and prints the root
 * `.env` inputs. `health` probes Docker over mutual TLS with the delivered files,
 * exactly as the app will. `teardown` removes the VM, then the delivered files.
 * Every command is idempotent and safe to re-run after a host reboot: Incus
 * restores the VM's last power state, and the state and delivery directories
 * must live on persistent storage. Output carries paths, the endpoint and status
 * labels only, never file contents.
 */
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createIncusEnvironment,
  probeDockerEndpoint,
  type IncusEnvironmentConnection,
  type IncusEnvironmentOptions,
} from '../incus-environment.server'

type DockerEnv = IncusEnvironmentConnection['dockerEnv']

export interface Deps {
  create: typeof createIncusEnvironment
  probe: typeof probeDockerEndpoint
  out: (line: string) => void
  /** Mount points whose contents do not survive a reboot (tmpfs) or that age out. */
  volatile: readonly string[]
  sleep: (ms: number) => Promise<void>
  now: () => number
}

export const VOLATILE = ['/tmp', '/var/tmp', '/run', '/var/run', '/dev', '/proc', '/sys']
const DELIVERED = {
  SANDBOX_DOCKER_TLS_CA: 'ca.pem',
  SANDBOX_DOCKER_TLS_CERT: 'cert.pem',
  SANDBOX_DOCKER_TLS_KEY: 'key.pem',
} as const
const CONNECTION = 'connection.json'
const POLL_MS = 5_000
const EXPIRY_WARNING_DAYS = 30

// The config is checked against this shape: an unknown or misspelt key is
// refused rather than ignored, so a typo cannot silently drop a setting.
type Shape = 'string' | 'number' | { [key: string]: Shape }
const CONFIG: Shape = {
  environment: 'string',
  manager: { url: 'string', ca: 'string', cert: 'string', key: 'string' },
  bridge: 'string',
  address: 'string',
  storagePool: 'string',
  image: { server: 'string', fingerprint: 'string' },
  quota: { cpu: 'number', memoryMiB: 'number', diskGiB: 'number', rootDiskGiB: 'number' },
  stateDirectory: 'string',
  delivery: { directory: 'string', 'owner?': { uid: 'number', gid: 'number' } },
}

function conform(value: unknown, shape: Shape, name: string): void {
  if (typeof shape === 'string') {
    if (typeof value !== shape) throw new Error(`config ${name} must be a ${shape}`)
    return
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`config ${name} must be an object`)
  const record = value as Record<string, unknown>
  const at = (key: string) => (name === 'file' ? key : `${name}.${key}`)
  const known = Object.keys(shape).map((key) => key.replace(/\?$/, ''))
  for (const key of Object.keys(record))
    if (!known.includes(key)) throw new Error(`config ${at(key)} is not a known setting`)
  for (const [key, inner] of Object.entries(shape)) {
    const field = key.replace(/\?$/, '')
    if (key !== field && record[field] === undefined) continue
    conform(record[field], inner, at(field))
  }
}

interface Config extends Omit<IncusEnvironmentOptions, 'manager'> {
  manager: { url: string; ca: string; cert: string; key: string }
  delivery: { directory: string; owner?: { uid: number; gid: number } }
}

async function load(file: string): Promise<Config> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    throw new Error('config file is unreadable or not JSON')
  }
  conform(value, CONFIG, 'file')
  return value as Config
}

/** Resolve through the nearest existing ancestor, so a symlink cannot hide a tmpfs. */
async function persistent(
  path: string,
  label: string,
  volatile: readonly string[],
): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`)
  const rest: string[] = []
  let existing = path
  for (;;) {
    try {
      existing = await realpath(existing)
      break
    } catch {
      if (existing === dirname(existing)) throw new Error(`${label} cannot be resolved`)
      rest.unshift(basename(existing))
      existing = dirname(existing)
    }
  }
  const resolved = join(existing, ...rest)
  const mount = volatile.find((root) => resolved === root || resolved.startsWith(`${root}/`))
  if (mount) throw new Error(`${label} must survive a host reboot, and ${mount} does not`)
  return resolved
}

const within = (inner: string, outer: string) => inner === outer || inner.startsWith(`${outer}/`)

/** One operation per state directory at a time, across processes too. */
async function locked<T>(stateDirectory: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${stateDirectory}.lock`
  let handle
  try {
    handle = await open(lock, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error(`cannot create ${lock}`)
    throw new Error(`${lock} exists: another operation may be running; remove it only once none is`)
  }
  try {
    await handle.writeFile(`${process.pid}\n`)
    await handle.close()
    return await fn()
  } finally {
    await rm(lock, { force: true })
  }
}

async function privateDirectory(
  directory: string,
  owner?: Config['delivery']['owner'],
): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error('delivery directory must be a private (0700) directory, not a link')
  if (owner) await chown(directory, owner.uid, owner.gid)
}

/** Write only what changed, atomically: a file bind keeps the inode it was given,
 * so an unchanged file must stay the same file for a running app. */
async function place(
  target: string,
  data: Buffer,
  owner?: Config['delivery']['owner'],
): Promise<void> {
  const current = await readFile(target).catch(() => undefined)
  if (!current?.equals(data)) {
    const staged = `${target}.${process.pid}.tmp`
    await writeFile(staged, data, { mode: 0o600, flag: 'wx' })
    await rename(staged, target)
  }
  await chmod(target, 0o600)
  if (owner) await chown(target, owner.uid, owner.gid)
}

async function deliver(config: Config, dockerEnv: DockerEnv): Promise<DockerEnv> {
  const { directory, owner } = config.delivery
  await privateDirectory(directory, owner)
  const delivered = { ...dockerEnv }
  for (const [key, name] of Object.entries(DELIVERED) as [keyof typeof DELIVERED, string][]) {
    const target = join(directory, name)
    await place(target, await readFile(dockerEnv[key]), owner)
    delivered[key] = target
  }
  await place(
    join(directory, CONNECTION),
    Buffer.from(`${JSON.stringify(delivered, null, 2)}\n`),
    owner,
  )
  return delivered
}

async function delivered(config: Config): Promise<DockerEnv> {
  let value: Record<string, unknown>
  try {
    value = JSON.parse(await readFile(join(config.delivery.directory, CONNECTION), 'utf8'))
  } catch {
    throw new Error('nothing delivered yet: run reconcile first')
  }
  const keys = ['SANDBOX_DOCKER_HOST', ...Object.keys(DELIVERED)]
  if (
    Object.keys(value).sort().join() !== [...keys].sort().join() ||
    keys.some((key) => typeof value[key] !== 'string')
  )
    throw new Error(`${CONNECTION} is not a delivered connection`)
  return value as unknown as DockerEnv
}

async function manager(config: Config): Promise<IncusEnvironmentOptions['manager']> {
  const [ca, cert, key] = await Promise.all(
    [config.manager.ca, config.manager.cert, config.manager.key].map((file) =>
      readFile(file, 'utf8').catch(() => {
        throw new Error('Incus manager TLS files are unreadable')
      }),
    ),
  )
  return { url: config.manager.url, ca, cert, key }
}

async function health(config: Config, waitSeconds: number, deps: Deps): Promise<number> {
  const dockerEnv = await delivered(config)
  const deadline = deps.now() + waitSeconds * 1000
  for (;;) {
    const probe = await deps.probe(dockerEnv)
    if (probe.ready) {
      const days = Math.floor(
        (Date.parse(probe.clientCertificateValidTo) - deps.now()) / 86_400_000,
      )
      deps.out(
        `Docker ready at ${dockerEnv.SANDBOX_DOCKER_HOST}; client certificate valid for ${days} more days`,
      )
      if (days < EXPIRY_WARNING_DAYS)
        deps.out('WARNING: rotate soon (teardown, then reconcile, then recreate the app)')
      return 0
    }
    // An untrusted daemon is a wrong endpoint or CA: waiting cannot fix it.
    if (probe.reason === 'untrusted-server' || deps.now() >= deadline) {
      deps.out(`Docker not ready at ${dockerEnv.SANDBOX_DOCKER_HOST}: ${probe.reason}`)
      return 1
    }
    await deps.sleep(POLL_MS)
  }
}

export async function main(argv: string[], deps: Deps): Promise<number> {
  const [command, file, ...rest] = argv
  if (!['reconcile', 'health', 'teardown'].includes(command) || !file) {
    deps.out(
      'usage: incus-environment.ts reconcile|health|teardown <config.json> [--wait <seconds>]',
    )
    return 2
  }
  let wait = 0
  if (rest.length) {
    wait = Number(rest[1])
    if (
      command !== 'health' ||
      rest.length !== 2 ||
      rest[0] !== '--wait' ||
      !Number.isInteger(wait) ||
      wait < 0
    ) {
      deps.out('only health takes --wait <seconds>')
      return 2
    }
  }
  try {
    const config = await load(file)
    config.stateDirectory = await persistent(config.stateDirectory, 'stateDirectory', deps.volatile)
    config.delivery.directory = await persistent(
      config.delivery.directory,
      'delivery.directory',
      deps.volatile,
    )
    if (
      within(config.delivery.directory, config.stateDirectory) ||
      within(config.stateDirectory, config.delivery.directory)
    )
      throw new Error('delivery.directory and stateDirectory must not contain each other')
    if (command === 'health') return await health(config, wait, deps)
    return await locked(config.stateDirectory, async () => {
      const environment = deps.create({ ...config, manager: await manager(config) })
      if (command === 'teardown') {
        await environment.teardown()
        for (const name of [...Object.values(DELIVERED), CONNECTION])
          await rm(join(config.delivery.directory, name), { force: true })
        await rmdir(config.delivery.directory).catch(() => undefined)
        deps.out(`${config.environment} environment VM torn down; its delivered files are removed`)
        return 0
      }
      const { project, dockerEnv } = await environment.reconcile()
      const env = await deliver(config, dockerEnv)
      const prefix = config.environment.toUpperCase().replaceAll('-', '_')
      deps.out(`${config.environment} environment VM reconciled (Incus project ${project}).`)
      deps.out('Root .env inputs for this clone (docs/PREVIEW.md §12):')
      for (const [key, value] of Object.entries(env)) deps.out(`${prefix}_${key}=${value}`)
      if (!config.delivery.owner && process.getuid?.() === 0)
        deps.out(
          'NOTE: delivered files are root-owned; the clone preflight runs as the operator user (set delivery.owner)',
        )
      deps.out('Docker may still be booting: run health --wait 600 before recreating the app.')
      return 0
    })
  } catch (error) {
    // Messages here name settings and paths; the library's omit file contents and
    // TLS details by contract, and JSON errors are replaced before they get here.
    deps.out(`refused: ${error instanceof Error ? error.message : 'operation failed'}`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), {
    create: createIncusEnvironment,
    probe: probeDockerEndpoint,
    out: (line) => console.log(line),
    volatile: VOLATILE,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => Date.now(),
  }).then((code) => {
    process.exitCode = code
  })
}
