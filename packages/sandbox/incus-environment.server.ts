/** Operator-side Incus provisioning. Never put the manager credential in an app. */
import { execFile } from 'node:child_process'
import { X509Certificate, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  mkdir,
  open,
  readFile,
  writeFile,
  lstat,
  chmod,
  readdir,
  rm,
  realpath,
} from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { request } from 'node:https'
import { isIP } from 'node:net'
import { isAbsolute, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { dockerConnectionFromEnv } from './docker-connection.server'

assertServerOnImport()

/** PEM contents, not filenames. TLS verification is always enabled. */
export interface IncusCredential {
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
  /** Pinned VM image containing Docker, systemd, cloud-init and the Incus agent.
   * Exactly one source: an HTTPS simplestreams origin on port 443, or the two
   * local files of a split image, imported into this environment's project
   * before the instance is created from them. */
  image:
    | { server: string; fingerprint: string }
    | { files: { metadata: string; disk: string }; fingerprint: string }
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

export interface IncusEnvironment {
  reconcile(): Promise<IncusEnvironmentConnection>
  teardown(): Promise<void>
}

/** What one Docker readiness probe found. Only `untrusted-server` is final: the
 * daemon's certificate failed verification against this environment's CA (a
 * foreign, self-signed, misnamed, expired or not-yet-valid one), so waiting
 * cannot help.
 * `refused` means TLS completed and no answer followed: the daemon dropped the
 * connection, which is how a refused client certificate looks under TLS 1.3, or
 * stayed silent past the timeout. */
export type DockerProbe =
  | { ready: true; clientCertificateValidTo: string }
  | { ready: false; reason: 'unreachable' | 'refused' | 'untrusted-server' | 'not-ready' }

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

/** Local-image import bounds. The disk cap mirrors the image pipeline's own
 * ceiling (an 8 GiB export plus headroom); the metadata cap is orders of
 * magnitude above its five small files. The upload timeout must move a
 * full-cap disk over a loopback TLS connection: 16 GiB at a conservative
 * 20 MiB/s is about 14 minutes. */
const IMAGE_METADATA_MAX_BYTES = 64 * 1024 * 1024
const IMAGE_DISK_MAX_BYTES = 16 * 1024 ** 3
const IMAGE_UPLOAD_TIMEOUT_MS = 900_000

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
function readEnvelope(
  req: import('node:http').ClientRequest,
  res: import('node:http').IncomingMessage,
): Promise<Envelope> {
  return new Promise((resolve, reject) => {
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
  })
}

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
      (res) => readEnvelope(req, res).then(resolve, reject),
    )
    req.setTimeout(35_000, () => req.destroy(new EnvironmentError('timeout')))
    req.on('error', () => reject(new EnvironmentError('Incus API connection failed')))
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

/** One image import (POST /1.0/images): the two split-image parts Incus names
 * `metadata` and `rootfs`, streamed, never buffered, over the credential the
 * caller hands in — the project-restricted one, never the manager credential.
 * Each part is read from the OPEN DESCRIPTOR its checks ran on, not re-opened
 * by path: a swap between check and stream cannot change what moves. */
function uploadImage(
  url: URL,
  tls: IncusCredential,
  boundary: string,
  files: { name: string; handle: FileHandle; limit: number }[],
  contentLength: number,
): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    async function* multipart(): AsyncGenerator<Buffer> {
      for (const part of files) {
        yield Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        )
        let sent = 0
        // The path argument is ignored once `fd` is provided (Node's documented
        // ReadStream contract), so the empty path keeps the typed overload.
        for await (const chunk of createReadStream('', { fd: part.handle.fd, autoClose: true })) {
          sent += chunk.length
          if (sent > part.limit)
            throw new EnvironmentError('Incus image file exceeded its size limit')
          yield chunk
        }
        yield Buffer.from('\r\n')
      }
      yield Buffer.from(`--${boundary}--\r\n`)
    }
    const req = request(
      url,
      {
        method: 'POST',
        ...tls,
        rejectUnauthorized: true,
        signal: AbortSignal.timeout(IMAGE_UPLOAD_TIMEOUT_MS),
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(contentLength),
        },
      },
      (res) => readEnvelope(req, res).then(resolve, reject),
    )
    req.setTimeout(IMAGE_UPLOAD_TIMEOUT_MS, () => req.destroy(new EnvironmentError('timeout')))
    req.on('error', () => reject(new EnvironmentError('Incus API connection failed')))
    // The stream ends the request. A file that grew past its checked size, or a
    // mid-upload read failure, destroys the request; nothing is retried here.
    pipeline(multipart(), req).then(
      () => undefined,
      (error) =>
        reject(
          error instanceof EnvironmentError
            ? error
            : new EnvironmentError('Incus image upload failed'),
        ),
    )
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

function requireImageFiles(value: unknown): { metadata: string; disk: string } {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as { metadata?: unknown }).metadata !== 'string' ||
    typeof (value as { disk?: unknown }).disk !== 'string'
  )
    throw new EnvironmentError('Incus local image files require metadata and disk paths')
  return value as { metadata: string; disk: string }
}

function operationId(response: Envelope): string {
  const match = /^\/1\.0\/operations\/([a-f0-9-]{36})(?:\?.*)?$/.exec(response.operation ?? '')
  if (!match) throw new EnvironmentError('Incus operation reference is invalid')
  return match[1]
}

/** A daemon that accepts and then stays silent must not hold a wait past its deadline. */
const PROBE_TIMEOUT_MS = 10_000

// A server certificate this client refused to trust, classified by category so
// that every verification failure is final. Transport errors, timeouts and peer
// alerts (`ERR_SSL_*`) stay retryable.
const untrustedServer = (code: string) =>
  code.startsWith('CERT_') ||
  code.startsWith('UNABLE_TO_') ||
  code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
  code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
  code === 'ERR_TLS_CERT_ALTNAME_INVALID'

/** One mutual-TLS `GET /_ping` with exactly the four settings an app receives,
 * bounded by `timeoutMs`. Both sides are verified and nothing falls back to
 * plaintext. Docker must answer `OK`. Results and errors never carry file
 * contents or TLS error text. */
export async function probeDockerEndpoint(
  dockerEnv: IncusEnvironmentConnection['dockerEnv'],
  { timeoutMs = PROBE_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<DockerProbe> {
  if (!dockerConnectionFromEnv(dockerEnv).includes('--tlsverify'))
    throw new EnvironmentError('Docker probes require a TLS tcp endpoint')
  let tls: IncusCredential
  try {
    const [ca, cert, key] = await Promise.all(
      [
        dockerEnv.SANDBOX_DOCKER_TLS_CA,
        dockerEnv.SANDBOX_DOCKER_TLS_CERT,
        dockerEnv.SANDBOX_DOCKER_TLS_KEY,
      ].map((file) => readFile(file, 'utf8')),
    )
    tls = { ca, cert, key }
  } catch {
    throw new EnvironmentError('Docker TLS files are unreadable')
  }
  const url = new URL(`https://${new URL(dockerEnv.SANDBOX_DOCKER_HOST).host}/_ping`)
  const outcome = await new Promise<'ready' | Extract<DockerProbe, { ready: false }>['reason']>(
    (resolve) => {
      const req = request(
        url,
        // A fresh connection every time: each probe is its own handshake.
        { ...tls, rejectUnauthorized: true, agent: false, signal: AbortSignal.timeout(timeoutMs) },
        (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            body += chunk
            if (body.length > 64) req.destroy()
          })
          res.on('end', () =>
            resolve(res.statusCode === 200 && body === 'OK' ? 'ready' : 'not-ready'),
          )
        },
      )
      // Under TLS 1.3 the daemon checks the client certificate only after this
      // side's handshake completes, so its refusal arrives as a later failure.
      let secured = false
      req.on('socket', (socket) => socket.once('secureConnect', () => (secured = true)))
      req.on('error', (error: NodeJS.ErrnoException) => {
        if (untrustedServer(error.code ?? '')) resolve('untrusted-server')
        else resolve(secured ? 'refused' : 'unreachable')
      })
      req.on('close', () => resolve('not-ready'))
      req.end()
    },
  )
  if (outcome !== 'ready') return { ready: false, reason: outcome }
  return { ready: true, clientCertificateValidTo: new X509Certificate(tls.cert).validTo }
}

/** Create a controller, without network access. Serialize calls per state directory.
 * Reconcile refuses drift/foreign resources; teardown never enumerates other projects.
 * The operator owns bridge, pool, images, routing and firewall installation. */
export function createIncusEnvironment(options: IncusEnvironmentOptions): IncusEnvironment {
  // Capture configuration, so later caller mutation cannot widen scope mid-operation.
  const o = structuredClone(options)
  const origin = httpsUrl(o.manager.url)
  // Exactly one image source, decided once at construction: a config naming
  // both, or neither, is refused before any request.
  const hasFiles = 'files' in o.image
  const hasServer = 'server' in o.image
  if (hasFiles === hasServer)
    throw new EnvironmentError('Incus image requires exactly one source: a server or local files')
  const files = hasFiles ? requireImageFiles((o.image as { files: unknown }).files) : undefined
  const imageServer = hasServer ? httpsUrl((o.image as { server: string }).server) : undefined
  if (imageServer?.port)
    throw new EnvironmentError('Incus image servers require the default HTTPS port (443)')
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
    const id = operationId(response)
    const creating = method === 'POST' && pathname === '/1.0/instances'
    if (creating)
      await writeFile(path('creation.json'), JSON.stringify({ id }), {
        mode: 0o600,
        flag: 'wx',
      })
    return waitOperation(tls, id, creating)
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
      '-addext',
      'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
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
        `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=${role === 'server' ? 'serverAuth' : 'clientAuth'}\n${role === 'server' ? `subjectAltName=IP:${o.address}\n` : ''}`,
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
      'restricted.virtual-machines.nesting': 'block',
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
      'restricted.storage-pools.access': o.storagePool,
      // An empty value (the key unset) allows no remote image server at all,
      // which is what a locally imported image needs. Never widen it back.
      ...(imageServer ? { 'restricted.images.servers': imageServer.hostname } : {}),
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
  /** The operator stages the reviewed build's two files root-owned, outside
   * every checkout (the install plan's I8). Refuse anything else before a byte
   * moves. The file is OPENED ONCE: the symlink refusal runs on the path
   * (`realpath`, before any open), every remaining check runs on the open
   * descriptor (`fstat`: regular file, root-owned, no group/other write, size
   * bound) and the `.git` ancestor walk distinguishes not-found from a parent
   * it cannot even ask. Returns the handle and its checked size, so the upload
   * streams the very bytes that were checked and declares exactly their length. */
  async function openImageFile(
    label: string,
    file: string,
    limit: number,
  ): Promise<{ handle: FileHandle; size: number }> {
    if (!isAbsolute(file) || file.includes('\0'))
      throw new EnvironmentError(`Incus image ${label} file must be an absolute path`)
    const real = await realpath(file).catch(() => undefined)
    if (!real) throw new EnvironmentError(`Incus image ${label} file is unreadable`)
    if (real !== file)
      throw new EnvironmentError(`Incus image ${label} file must not be reached through a symlink`)
    const handle = await open(file, 'r').catch(() => {
      throw new EnvironmentError(`Incus image ${label} file is unreadable`)
    })
    try {
      const info = await handle.stat()
      if (!info.isFile())
        throw new EnvironmentError(`Incus image ${label} file must be a regular file`)
      if (info.uid !== 0) throw new EnvironmentError(`Incus image ${label} file must be root-owned`)
      if (info.mode & 0o022)
        throw new EnvironmentError(`Incus image ${label} file must not be group- or other-writable`)
      if (info.size > limit)
        throw new EnvironmentError(`Incus image ${label} file exceeds its size limit`)
      for (let dir = dirname(real); ; dir = dirname(dir)) {
        const git = join(dir, '.git')
        let present = false
        try {
          await lstat(git)
          present = true
        } catch (error) {
          // Only a proven absence passes: an unreadable parent must not be read
          // as "no checkout here".
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw new EnvironmentError(
              `Incus image ${label} file must have readable parent directories`,
            )
        }
        if (present)
          throw new EnvironmentError(`Incus image ${label} file must not live under a checkout`)
        if (dir === dirname(dir)) break
      }
      return { handle, size: info.size }
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
  }

  /** Every fingerprint Incus currently holds in this environment's own project. */
  async function listProjectImages(tls: IncusCredential): Promise<string[]> {
    const listed = await api(tls, 'GET', '/1.0/images')
    if (!Array.isArray(listed)) throw new EnvironmentError('Incus image list is invalid')
    const fingerprints: string[] = []
    for (const entry of listed) {
      const match =
        typeof entry === 'string' && /^\/1\.0\/images\/([a-f0-9]{64})(?:\?.*)?$/.exec(entry)
      if (!match) throw new EnvironmentError('Incus image list is invalid')
      fingerprints.push(match[1])
    }
    return fingerprints
  }

  /** Import the pinned split image into this environment's own project, or
   * verify an earlier import. The instance is never created unless Incus's own
   * fingerprint over the received bytes equals the pin: on any other value
   * exactly what this import added is removed first — an earlier verified image
   * in the project is kept — so a substituted image leaves no instance and only
   * its own import behind. The upload rides the project-restricted certificate,
   * never the manager credential, and is scoped to this project. */
  async function ensurePinnedImage(tls: IncusCredential): Promise<void> {
    const pin = (o.image as { fingerprint: string }).fingerprint
    if (await optional(tls, `/1.0/images/${pin}`)) return
    const parts = [
      {
        label: 'metadata',
        name: 'metadata',
        file: files!.metadata,
        limit: IMAGE_METADATA_MAX_BYTES,
      },
      { label: 'disk', name: 'rootfs', file: files!.disk, limit: IMAGE_DISK_MAX_BYTES },
    ]
    // Snapshot what the project already holds before the upload, so the
    // mismatch cleanup below deletes only the delta this import added.
    const before = new Set(await listProjectImages(tls))
    const opened: FileHandle[] = []
    try {
      const checked: { name: string; handle: FileHandle; limit: number; size: number }[] = []
      for (const part of parts) {
        const result = await openImageFile(part.label, part.file, part.limit)
        opened.push(result.handle)
        checked.push({
          name: part.name,
          handle: result.handle,
          limit: part.limit,
          size: result.size,
        })
      }
      const boundary = `sandbox${randomUUID().replaceAll('-', '')}`
      const preamble = (name: string) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`
      const url = new URL('/1.0/images', origin)
      url.searchParams.set('project', project)
      const contentLength =
        checked.reduce(
          (total, part) => total + Buffer.byteLength(preamble(part.name)) + part.size + 2,
          0,
        ) + Buffer.byteLength(`--${boundary}--\r\n`)
      const response = await uploadImage(url, tls, boundary, checked, contentLength)
      if (response.type !== 'async')
        throw new EnvironmentError('Incus image import response is invalid')
      await waitOperation(tls, operationId(response), false)
      if (await optional(tls, `/1.0/images/${pin}`)) return
      // Incus computed a fingerprint other than the pin: remove what it did
      // assign — present now but absent before the upload — then refuse. A
      // scoped DELETE never touches another project.
      for (const fingerprint of await listProjectImages(tls))
        if (!before.has(fingerprint)) await api(tls, 'DELETE', `/1.0/images/${fingerprint}`)
      throw new EnvironmentError(
        'Incus assigned the imported image a fingerprint other than the pinned one',
      )
    } finally {
      // The streams close their own descriptors; a handle whose stream never
      // started (a size refusal mid-batch, an upload aborted early) is closed here.
      for (const handle of opened) await handle.close().catch(() => undefined)
    }
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
          // The VM image preloads the classic overlay2 store; Docker 29's
          // default containerd store would boot with none of its images.
          'storage-driver': 'overlay2',
          features: { 'containerd-snapshotter': false },
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
        if (files) await ensurePinnedImage(c.tls)
        await resumeCreation(c.tls)
        const config = {
          'user.sandbox.owner': s.id,
          'security.nesting': 'false',
          'limits.cpu': String(o.quota.cpu),
          'limits.memory': `${o.quota.memoryMiB}MiB`,
          'cloud-init.user-data': await cloudConfig(),
        }
        const devices = {
          root: { type: 'disk', path: '/', pool: o.storagePool, size: `${o.quota.rootDiskGiB}GiB` },
          eth0: {
            type: 'nic',
            network: o.bridge,
            'ipv4.address': o.address,
            name: 'eth0',
            'security.mac_filtering': 'true',
            'security.ipv4_filtering': 'true',
            'security.ipv6_filtering': 'true',
          },
        }
        let vm = await optional(c.tls, `/1.0/instances/${instance}`)
        if (!vm) {
          await api(c.tls, 'POST', '/1.0/instances', {
            name: instance,
            type: 'virtual-machine',
            profiles: [],
            config,
            devices,
            // A locally imported image is addressed by its fingerprint alone:
            // no remote server, protocol or pull mode, and the fingerprint was
            // verified against the pin before this create is submitted.
            source: files
              ? { type: 'image', fingerprint: o.image.fingerprint }
              : {
                  type: 'image',
                  mode: 'pull',
                  protocol: 'simplestreams',
                  server: imageServer!.origin,
                  fingerprint: o.image.fingerprint,
                },
          })
          vm = await api(c.tls, 'GET', `/1.0/instances/${instance}`)
        }
        function checkVm(value: Entity, expectedConfig: Record<string, string>): void {
          if (
            value.type !== 'virtual-machine' ||
            !same(value.profiles, []) ||
            !same(value.devices, devices) ||
            !same(
              Object.fromEntries(
                Object.entries(value.config ?? {}).filter(
                  ([k]) => !k.startsWith('volatile.') && !k.startsWith('image.'),
                ),
              ),
              expectedConfig,
            )
          )
            throw new EnvironmentError('Incus VM configuration has drifted')
        }
        const networkKey = 'cloud-init.network-config'
        const existingSeed = vm.config?.[networkKey]
        checkVm(vm, existingSeed === undefined ? config : { ...config, [networkKey]: existingSeed })
        // eth0 is the Incus device key, not necessarily the guest interface name.
        const mac = vm.config?.['volatile.eth0.hwaddr']
        if (typeof mac !== 'string' || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac))
          throw new EnvironmentError('Incus guest NIC MAC is invalid')
        const networkConfig = JSON.stringify({
          version: 2,
          ethernets: {
            sandbox: {
              match: { macaddress: mac.toLowerCase() },
              dhcp4: false,
              dhcp6: false,
              addresses: [`${o.address}/${prefix}`],
              routes: [{ to: '0.0.0.0/0', via: gateway }],
              optional: true,
            },
          },
        })
        const seededConfig = { ...config, [networkKey]: networkConfig }
        const status = await api(c.tls, 'GET', `/1.0/instances/${instance}/state`)
        if (existingSeed === undefined) {
          // A stopped VM may already have booted. Only a pending create template
          // proves the seed can still be installed before cloud-init's first run.
          if (status.status_code !== 102 || vm.config?.['volatile.apply_template'] !== 'create')
            throw new EnvironmentError('Incus VM requires network seeding before first boot')
          await api(c.tls, 'PATCH', `/1.0/instances/${instance}`, {
            config: { [networkKey]: networkConfig },
          })
          vm = await api(c.tls, 'GET', `/1.0/instances/${instance}`)
          if (vm.config?.['volatile.eth0.hwaddr'] !== mac)
            throw new EnvironmentError('Incus guest NIC MAC changed during seeding')
        }
        checkVm(vm, seededConfig)
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
        // Only retire credentials once project deletion and exact revocation succeeded.
        // Failed teardown retains them for recovery; a later reconcile generates new keys.
        for (const name of await readdir(o.stateDirectory))
          if (/\.(pem|csr|ext|srl)$/.test(name) || name === 'creation.json') await rm(path(name))
        await rm(path('state.json'))
      }),
  }
}
