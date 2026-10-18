/** Operator-side Incus provisioning. Never put the manager credential in an app. */
import { execFile } from 'node:child_process'
import { X509Certificate, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, lstat, chmod, readdir, rm } from 'node:fs/promises'
import { request } from 'node:https'
import { isIP } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { dockerConnectionFromEnv } from './docker-connection.server'

assertServerOnImport()

/** PEM contents, not filenames. TLS verification is always enabled. */
interface IncusCredential {
  ca: string
  cert: string
  key: string
}

export interface IncusEnvironmentOptions {
  /** A short environment slug. The package owns only `sandbox-<environment>`. */
  environment: string
  /** Operator credential permitted to create projects and register restricted certificates. */
  manager: IncusCredential & { url: string }
  /** Existing operator-managed Incus bridge; its IPv4 subnet is checked through the API. */
  bridge: string
  /** Reserved IPv4 address on that bridge. Never a wildcard or bridge gateway. */
  address: string
  /** Existing operator-managed storage pool. */
  storagePool: string
  /** Pinned VM image containing Docker, systemd, cloud-init and the Incus agent. */
  image: { server: string; fingerprint: string }
  /** Project totals; the one VM has the same CPU/memory cap. Disk includes images. */
  quota: { cpu: number; memoryMiB: number; diskGiB: number; rootDiskGiB: number }
  /** Absolute operator-only directory, created mode 0700. Keep it across restarts. */
  stateDirectory: string
}

export interface IncusEnvironmentConnection {
  project: string
  /** Pass these four settings to the existing Docker backend before constructing it.
   * Copy only these files to the app, remapping the three paths when necessary. */
  dockerEnv: {
    SANDBOX_DOCKER_HOST: string
    SANDBOX_DOCKER_TLS_CA: string
    SANDBOX_DOCKER_TLS_CERT: string
    SANDBOX_DOCKER_TLS_KEY: string
  }
}

interface State {
  id: string
  binding: string
}
interface Entity {
  name?: string
  type?: string
  config?: Record<string, string>
  devices?: Record<string, Record<string, string>>
  profiles?: string[]
  restricted?: boolean
  projects?: string[]
  certificate?: string
  status_code?: number
}
interface Envelope {
  type: string
  metadata: Entity
  operation?: string
}
class EnvironmentError extends Error {}
class ApiError extends EnvironmentError {
  constructor(readonly status: number) {
    super(`Incus API request failed (${status})`)
  }
}

function httpsUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new EnvironmentError('Incus requires an HTTPS origin')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new EnvironmentError('Incus requires an HTTPS origin')
  }
  return url
}

// No redirects, no response bodies, no TLS/child-process errors in diagnostics.
function exchange(
  url: URL,
  tls: IncusCredential,
  method: string,
  body?: unknown,
): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method,
        ca: tls.ca,
        cert: tls.cert,
        key: tls.key,
        rejectUnauthorized: true,
        signal: AbortSignal.timeout(35_000),
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 2_000_000) req.destroy(new EnvironmentError('response limit'))
          else chunks.push(chunk)
        })
        res.on('error', () => reject(new EnvironmentError('Incus API response failed')))
        res.on('end', () => {
          const status = res.statusCode ?? 0
          if (status < 200 || status >= 300) return reject(new ApiError(status))
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString()) as Envelope
            if (!data || !['sync', 'async'].includes(data.type)) throw new EnvironmentError()
            resolve({ ...data, metadata: data.metadata ?? {} })
          } catch {
            reject(new EnvironmentError('Incus API response is invalid'))
          }
        })
      },
    )
    req.setTimeout(35_000, () => req.destroy(new EnvironmentError('timeout')))
    req.on('error', () => reject(new EnvironmentError('Incus API connection failed')))
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

function same(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual) !== Array.isArray(expected)) return false
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const a = actual as Record<string, unknown>,
      b = expected as Record<string, unknown>
    return (
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(b).every((k) => same(a[k], b[k]))
    )
  }
  return actual === expected
}

function ipv4(value: string): number {
  if (isIP(value) !== 4) throw new EnvironmentError('Incus requires an IPv4 bridge address')
  return value.split('.').reduce((n, octet) => (n * 256 + Number(octet)) >>> 0, 0)
}

/** Create a controller, without network access. Serialize calls per state directory.
 * Reconcile refuses drift/foreign resources; teardown never enumerates other projects.
 * The operator owns bridge, pool, images, routing and firewall installation. */
export function createIncusEnvironment(options: IncusEnvironmentOptions): {
  reconcile(): Promise<IncusEnvironmentConnection>
  teardown(): Promise<void>
} {
  // Capture configuration, so later caller mutation cannot widen scope mid-operation.
  const o = structuredClone(options)
  const origin = httpsUrl(o.manager.url)
  const imageServer = httpsUrl(o.image.server)
  if (
    !/^[a-z][a-z0-9-]{0,39}$/.test(o.environment) ||
    !/^[a-zA-Z0-9_-]{1,63}$/.test(o.bridge) ||
    !/^[a-zA-Z0-9_-]{1,63}$/.test(o.storagePool)
  ) {
    throw new EnvironmentError('Invalid Incus environment, bridge or storage pool name')
  }
  if (!/^[a-f0-9]{64}$/.test(o.image.fingerprint))
    throw new EnvironmentError('Incus requires a pinned image fingerprint')
  ipv4(o.address)
  if (!isAbsolute(o.stateDirectory) || o.stateDirectory === '/' || o.stateDirectory.includes('\0'))
    throw new EnvironmentError('Incus requires an absolute state directory')
  for (const n of [o.quota.cpu, o.quota.memoryMiB, o.quota.diskGiB, o.quota.rootDiskGiB])
    if (!Number.isSafeInteger(n) || n < 1)
      throw new EnvironmentError('Incus quotas must be positive integers')
  if (o.quota.rootDiskGiB >= o.quota.diskGiB)
    throw new EnvironmentError('Incus disk quota must leave space for the image')
  if (!o.manager.ca || !o.manager.cert || !o.manager.key)
    throw new EnvironmentError('Incus manager mTLS material is required')
  const project = `sandbox-${o.environment}`
  const instance = 'docker'
  const binding = JSON.stringify({
    project,
    bridge: o.bridge,
    address: o.address,
    storagePool: o.storagePool,
    image: o.image,
    quota: o.quota,
    origin: origin.origin,
  })
  const path = (name: string) => join(o.stateDirectory, name)
  const read = (name: string) => readFile(path(name), 'utf8')
  let busy = false
  async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (busy) throw new EnvironmentError('Incus environment operation already running')
    busy = true
    try {
      return await fn()
    } catch (error) {
      if (error instanceof EnvironmentError) throw error
      throw new EnvironmentError('Incus environment operation failed')
    } finally {
      busy = false
    }
  }
  async function api(
    tls: IncusCredential,
    method: string,
    pathname: string,
    body?: unknown,
    scoped = true,
  ): Promise<Entity> {
    const url = new URL(pathname, origin)
    if (scoped) url.searchParams.set('project', project)
    const response = await exchange(url, tls, method, body)
    if (response.type !== 'async') return response.metadata
    // Never follow a server-supplied href/origin or project query with credentials.
    const match = /^\/1\.0\/operations\/([a-f0-9-]{36})(?:\?.*)?$/.exec(response.operation ?? '')
    if (!match) throw new EnvironmentError('Incus operation reference is invalid')
    const creating = method === 'POST' && pathname === '/1.0/instances'
    if (creating)
      await writeFile(path('creation.json'), JSON.stringify({ id: match[1] }), {
        mode: 0o600,
        flag: 'wx',
      })
    return waitOperation(tls, match[1], creating)
  }
  async function waitOperation(
    tls: IncusCredential,
    id: string,
    creating: boolean,
    cleaning = false,
  ): Promise<Entity> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const wait = new URL(`/1.0/operations/${id}/wait`, origin)
      wait.searchParams.set('project', project)
      wait.searchParams.set('timeout', '30')
      let result: Envelope
      try {
        result = await exchange(wait, tls, 'GET')
      } catch (error) {
        // Completed operations eventually expire from Incus. The instance GET
        // after replay decides whether to reuse or recreate the owned VM.
        if (creating && error instanceof ApiError && error.status === 404) {
          await rm(path('creation.json'))
          return {}
        }
        throw error
      }
      if (result.metadata.status_code === 200) {
        if (creating) await rm(path('creation.json'))
        return result.metadata
      }
      if (![100, 103].includes(result.metadata.status_code ?? 0)) {
        if (creating) await rm(path('creation.json'))
        if (cleaning) return result.metadata
        throw new EnvironmentError('Incus operation failed')
      }
    }
    throw new EnvironmentError('Incus operation did not finish')
  }
  async function resumeCreation(tls: IncusCredential, cleaning = false): Promise<void> {
    let pending: { id: string }
    try {
      pending = JSON.parse(await read('creation.json')) as { id: string }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new EnvironmentError('Incus creation state is invalid')
    }
    if (!/^[a-f0-9-]{36}$/.test(pending?.id))
      throw new EnvironmentError('Incus creation state is invalid')
    await waitOperation(tls, pending.id, true, cleaning)
  }
  async function optional(
    tls: IncusCredential,
    pathname: string,
    scoped = true,
  ): Promise<Entity | undefined> {
    try {
      return await api(tls, 'GET', pathname, undefined, scoped)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return undefined
      throw error
    }
  }
  async function state(create: boolean): Promise<State | undefined> {
    try {
      await mkdir(o.stateDirectory, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new EnvironmentError('Incus state directory unavailable')
    }
    const info = await lstat(o.stateDirectory)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
      throw new EnvironmentError('Incus state directory must be private (0700)')
    let stored: State
    try {
      stored = JSON.parse(await read('state.json')) as State
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new EnvironmentError('Incus state is invalid')
      if (!create) return undefined
      if ((await readdir(o.stateDirectory)).length)
        throw new EnvironmentError(
          'Incus state directory is incomplete; operator recovery required',
        )
      stored = { id: randomUUID(), binding }
      await credentials()
      await writeFile(path('state.json'), JSON.stringify(stored), { mode: 0o600, flag: 'wx' })
    }
    if (stored.binding !== binding || !/^[a-f0-9-]{36}$/.test(stored.id))
      throw new EnvironmentError('Incus state belongs to another configuration')
    return stored
  }
  async function credentials(): Promise<void> {
    // openssl is an operator-side prerequisite, never invoked in the app.
    const run = async (args: string[]) => {
      try {
        await promisify(execFile)('openssl', args, { cwd: o.stateDirectory, timeout: 30_000 })
      } catch {
        throw new EnvironmentError('Incus TLS generation failed')
      }
    }
    const req = ['req', '-new', '-newkey', 'rsa:2048', '-nodes']
    await run([
      ...req,
      '-x509',
      '-days',
      '365',
      '-subj',
      '/CN=sandbox-ca',
      '-keyout',
      'ca-key.pem',
      '-out',
      'ca.pem',
    ])
    await run([
      ...req,
      '-x509',
      '-days',
      '365',
      '-subj',
      '/CN=sandbox-incus',
      '-keyout',
      'incus-key.pem',
      '-out',
      'incus.pem',
    ])
    for (const role of ['server', 'client']) {
      await run([
        ...req,
        '-subj',
        `/CN=sandbox-${role}`,
        '-keyout',
        `${role}-key.pem`,
        '-out',
        `${role}.csr`,
      ])
      await writeFile(
        path(`${role}.ext`),
        `extendedKeyUsage=${role === 'server' ? 'serverAuth' : 'clientAuth'}\n${role === 'server' ? `subjectAltName=IP:${o.address}\n` : ''}`,
        { mode: 0o600, flag: 'wx' },
      )
      await run([
        'x509',
        '-req',
        '-days',
        '365',
        '-in',
        `${role}.csr`,
        '-CA',
        'ca.pem',
        '-CAkey',
        'ca-key.pem',
        '-CAcreateserial',
        '-extfile',
        `${role}.ext`,
        '-out',
        `${role}.pem`,
      ])
    }
    for (const name of ['ca-key.pem', 'incus-key.pem', 'server-key.pem', 'client-key.pem'])
      await chmod(path(name), 0o600)
  }
  const projectPath = `/1.0/projects/${project}`
  function restrictions(id: string): Record<string, string> {
    return {
      'user.sandbox.owner': id,
      'features.images': 'true',
      'features.profiles': 'true',
      'features.storage.volumes': 'true',
      'features.networks': 'false',
      restricted: 'true',
      'limits.containers': '0',
      'limits.virtual-machines': '1',
      'limits.cpu': String(o.quota.cpu),
      'limits.memory': `${o.quota.memoryMiB}MiB`,
      'limits.disk': `${o.quota.diskGiB}GiB`,
      'restricted.virtual-machines.lowlevel': 'block',
      'restricted.devices.disk': 'block',
      'restricted.devices.nic': 'managed',
      'restricted.devices.unix-char': 'block',
      'restricted.devices.unix-block': 'block',
      'restricted.devices.unix-hotplug': 'block',
      'restricted.devices.usb': 'block',
      'restricted.devices.pci': 'block',
      'restricted.devices.gpu': 'block',
      'restricted.devices.infiniband': 'block',
      'restricted.devices.proxy': 'block',
      'restricted.snapshots': 'block',
      'restricted.backups': 'block',
      'restricted.networks.access': o.bridge,
      'restricted.images.servers': imageServer.host,
    }
  }
  function ownProject(value: Entity, id: string): void {
    if (value.name !== project || value.config?.['user.sandbox.owner'] !== id)
      throw new EnvironmentError('Incus project is not owned by this environment')
    // With an inherited image/profile namespace, a scoped DELETE could affect
    // the default project's resources. Refuse that before any cleanup request.
    if (
      !['features.images', 'features.profiles', 'features.storage.volumes'].every(
        (key) => value.config?.[key] === 'true',
      )
    )
      throw new EnvironmentError('Incus project resource isolation has drifted')
  }
  async function certificate(): Promise<{
    fingerprint: string
    cert: string
    tls: IncusCredential
  }> {
    const cert = await read('incus.pem')
    return {
      cert,
      fingerprint: new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase(),
      tls: { ca: o.manager.ca, cert, key: await read('incus-key.pem') },
    }
  }
  function ownCertificate(value: Entity, orphan = false): void {
    // Incus removes the project reference when deleting a project. An empty
    // scope is accepted only to revoke that exact orphaned certificate.
    if (
      value.restricted !== true ||
      value.name !== project ||
      !(same(value.projects, [project]) || (orphan && same(value.projects, [])))
    )
      throw new EnvironmentError('Incus certificate is not confined to this environment')
  }
  async function cloudConfig(): Promise<string> {
    const files = []
    for (const [source, target] of [
      ['ca.pem', 'ca.pem'],
      ['server.pem', 'cert.pem'],
      ['server-key.pem', 'key.pem'],
    ]) {
      files.push({
        path: `/etc/docker/tls/${target}`,
        permissions: '0600',
        encoding: 'b64',
        content: Buffer.from(await read(source)).toString('base64'),
      })
    }
    files.push({
      path: '/etc/docker/daemon.json',
      permissions: '0600',
      encoding: 'b64',
      content: Buffer.from(
        JSON.stringify({
          hosts: [`tcp://${o.address}:2376`],
          tls: true,
          tlsverify: true,
          tlscacert: '/etc/docker/tls/ca.pem',
          tlscert: '/etc/docker/tls/cert.pem',
          tlskey: '/etc/docker/tls/key.pem',
        }),
      ).toString('base64'),
    })
    files.push({
      path: '/etc/systemd/system/docker.service.d/sandbox.conf',
      permissions: '0600',
      encoding: 'b64',
      content: Buffer.from(
        '[Unit]\nRequires=\n[Service]\nExecStart=\nExecStart=/usr/bin/dockerd\n',
      ).toString('base64'),
    })
    return (
      '#cloud-config\n' +
      JSON.stringify({
        write_files: files,
        runcmd: [
          ['systemctl', 'disable', '--now', 'docker.socket'],
          ['systemctl', 'daemon-reload'],
          ['systemctl', 'restart', 'docker.service'],
        ],
      })
    )
  }
  return {
    reconcile: () =>
      exclusive(async () => {
        const s = (await state(true))!
        const network = await api(o.manager, 'GET', `/1.0/networks/${o.bridge}`, undefined, false)
        const [gateway, bits] = (network.config?.['ipv4.address'] ?? '').split('/')
        const prefix = Number(bits),
          address = ipv4(o.address),
          bridge = ipv4(gateway)
        const mask = (0xffffffff << (32 - prefix)) >>> 0
        if (
          network.type !== 'bridge' ||
          !Number.isInteger(prefix) ||
          prefix < 1 ||
          prefix > 30 ||
          address === bridge ||
          (address & mask) !== (bridge & mask) ||
          (address & ~mask) === 0 ||
          (address & ~mask) === ~mask >>> 0
        )
          throw new EnvironmentError(
            'Incus Docker address must be a guest address on the configured bridge',
          )
        let p = await optional(o.manager, projectPath, false)
        if (!p) {
          await api(
            o.manager,
            'POST',
            '/1.0/projects',
            { name: project, config: restrictions(s.id) },
            false,
          )
          p = await api(o.manager, 'GET', projectPath, undefined, false)
        }
        ownProject(p, s.id)
        const expected = restrictions(s.id)
        if (!Object.entries(expected).every(([k, v]) => p.config?.[k] === v))
          throw new EnvironmentError('Incus project restrictions have drifted')
        const c = await certificate()
        const certPath = `/1.0/certificates/${c.fingerprint}`
        let trusted = await optional(o.manager, certPath, false)
        if (!trusted) {
          await api(
            o.manager,
            'POST',
            '/1.0/certificates',
            {
              type: 'client',
              name: project,
              certificate: new X509Certificate(c.cert).raw.toString('base64'),
              restricted: true,
              projects: [project],
            },
            false,
          )
          trusted = await api(o.manager, 'GET', certPath, undefined, false)
        }
        ownCertificate(trusted)
        await resumeCreation(c.tls)
        const config = {
          'user.sandbox.owner': s.id,
          'limits.cpu': String(o.quota.cpu),
          'limits.memory': `${o.quota.memoryMiB}MiB`,
          'cloud-init.user-data': await cloudConfig(),
        }
        const devices = {
          root: { type: 'disk', path: '/', pool: o.storagePool, size: `${o.quota.rootDiskGiB}GiB` },
          eth0: { type: 'nic', network: o.bridge, 'ipv4.address': o.address, name: 'eth0' },
        }
        let vm = await optional(c.tls, `/1.0/instances/${instance}`)
        if (!vm) {
          await api(c.tls, 'POST', '/1.0/instances', {
            name: instance,
            type: 'virtual-machine',
            profiles: [],
            config,
            devices,
            source: {
              type: 'image',
              mode: 'pull',
              protocol: 'simplestreams',
              server: imageServer.origin,
              fingerprint: o.image.fingerprint,
            },
          })
          vm = await api(c.tls, 'GET', `/1.0/instances/${instance}`)
        }
        if (
          vm.type !== 'virtual-machine' ||
          !same(vm.profiles, []) ||
          !same(vm.devices, devices) ||
          !Object.entries(config).every(([k, v]) => vm.config?.[k] === v)
        )
          throw new EnvironmentError('Incus VM configuration has drifted')
        const status = await api(c.tls, 'GET', `/1.0/instances/${instance}/state`)
        if (status.status_code === 102)
          await api(c.tls, 'PUT', `/1.0/instances/${instance}/state`, {
            action: 'start',
            timeout: 30,
          })
        else if (status.status_code !== 103)
          throw new EnvironmentError('Incus VM is not running or stopped')
        const dockerEnv = {
          SANDBOX_DOCKER_HOST: `tcp://${o.address}:2376`,
          SANDBOX_DOCKER_TLS_CA: path('ca.pem'),
          SANDBOX_DOCKER_TLS_CERT: path('client.pem'),
          SANDBOX_DOCKER_TLS_KEY: path('client-key.pem'),
        }
        dockerConnectionFromEnv(dockerEnv)
        return { project, dockerEnv }
      }),
    teardown: () =>
      exclusive(async () => {
        const s = await state(false)
        if (!s) return
        const p = await optional(o.manager, projectPath, false)
        if (p) {
          ownProject(p, s.id)
          const c = await certificate()
          const cert = await optional(o.manager, `/1.0/certificates/${c.fingerprint}`, false)
          if (!cert) throw new EnvironmentError('Incus restricted certificate is missing')
          ownCertificate(cert)
          await resumeCreation(c.tls, true)
          const vm = await optional(c.tls, `/1.0/instances/${instance}`)
          if (vm) {
            if (vm.config?.['user.sandbox.owner'] !== s.id)
              throw new EnvironmentError('Incus VM is not owned by this environment')
            const status = await api(c.tls, 'GET', `/1.0/instances/${instance}/state`)
            if (status.status_code !== 102)
              await api(c.tls, 'PUT', `/1.0/instances/${instance}/state`, {
                action: 'stop',
                force: true,
                timeout: 30,
              })
            await api(c.tls, 'DELETE', `/1.0/instances/${instance}`)
          }
          const imagePath = `/1.0/images/${o.image.fingerprint}`
          if (await optional(c.tls, imagePath)) await api(c.tls, 'DELETE', imagePath)
          // Incus removes the project's empty default profile with the project.
          // Never force-delete a project: unexpected instances, images or volumes block deletion.
          await api(o.manager, 'DELETE', projectPath, undefined, false)
        }
        const c = await certificate()
        const certPath = `/1.0/certificates/${c.fingerprint}`
        const cert = await optional(o.manager, certPath, false)
        if (cert) {
          ownCertificate(cert, true)
          await api(o.manager, 'DELETE', certPath, undefined, false)
        }
        // Preserve local credentials for explicit operator disposal and repeat teardown.
      }),
  }
}
