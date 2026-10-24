import { execFileSync } from 'node:child_process'
import { X509Certificate, createHash } from 'node:crypto'
import { createServer, type Server } from 'node:https'
import { createServer as httpServer } from 'node:http'
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  cp,
  chmod,
  symlink,
  stat,
  readdir,
  mkdir,
  realpath,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
// A fixture directory named `root-owned-fixture` pretends its files belong to
// uid 0: an unprivileged test cannot create a root-owned file, and the
// entry point's contract is that the operator stages them as root. The fakes
// apply to the OPEN DESCRIPTOR (handle.stat), which is where the entry point's
// checks run — everything else stats for real, so the negative direction is
// still a real uid. The markers compose, so one fixture can be both
// root-owned and oversized, and `unreadable-ancestor-fixture` makes the
// checkout walk's lstat of its `.git` fail with EACCES instead of answering.
type OpenParams = Parameters<typeof import('node:fs/promises').open>
type OpenRest = OpenParams extends [unknown, ...infer Rest] ? Rest : never
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  open: vi.fn(async (path: OpenParams[0], ...rest: OpenRest) => {
    const real = await original<typeof import('node:fs/promises')>()
    const handle = await real.open(path, ...rest)
    const name = String(path)
    if (!name.includes('root-owned-fixture') && !name.includes('oversized-fixture')) return handle
    const stat = handle.stat.bind(handle)
    handle.stat = async () => {
      const info = await stat()
      return Object.assign(Object.create(Object.getPrototypeOf(info)), info, {
        ...(name.includes('root-owned-fixture') ? { uid: 0 } : {}),
        ...(name.includes('oversized-fixture') ? { size: 64 * 1024 ** 3 } : {}),
      })
    }
    return handle
  }),
  lstat: vi.fn(async (path: Parameters<typeof import('node:fs/promises').lstat>[0]) => {
    const name = String(path)
    if (name.endsWith('/.git') && name.includes('unreadable-ancestor-fixture'))
      throw Object.assign(new Error('Permission denied'), { code: 'EACCES' })
    return (await original<typeof import('node:fs/promises')>()).lstat(path)
  }),
}))
import { createIncusEnvironment, type IncusEnvironmentOptions } from '../incus-environment.server'
import { dockerConnectionFromEnv } from '../docker-connection.server'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- fake API wire objects
let root: string, template: string, server: Server, options: IncusEnvironmentOptions
let managerFingerprint: string
let serverTLS: { key: string; cert: string }, otherServerTLS: { key: string; cert: string }
let project: Json | undefined, certificate: Json | undefined, vm: Json | undefined
let vmStatus = 102
let staged = ''
// Set by the descriptor-shape test: the fake image import unlinks the staged
// disk once the request arrives, so only a stream already reading the checked
// descriptor can still deliver the pinned bytes.
let unlinkDiskOnUpload = false
// Fingerprints of the images Incus holds in this project. The simplestreams
// pin starts present (the pulled image is cached in the project); a local
// import starts empty and gains what the fake computes over received bytes.
let images = new Set<string>()
let unexpectedResource: Json | undefined
let requests: { method: string; url: URL; body: Json; manager: boolean; raw?: Buffer }[]
let fault:
  | ((
      method: string,
      url: URL,
      body: Json,
    ) => { status?: number; raw?: string; data?: Json } | undefined)
  | undefined
let operationStatus: number[] = [],
  asyncNext = false
let asyncCreate = false,
  vmVisible = true
const fingerprint = (pem: string | Buffer) =>
  new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase()
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')
/** The two split-image parts out of the multipart body the client streams. */
const splitImage = (raw: Buffer, contentType: string): Record<string, Buffer> => {
  const boundary = /boundary=([^;\s]+)/.exec(contentType)?.[1]
  if (!boundary) return {}
  const parts: Record<string, Buffer> = {}
  for (const segment of raw.toString('latin1').split(`--${boundary}`)) {
    const name = /name="([^"]+)"/.exec(segment)?.[1]
    const head = segment.indexOf('\r\n\r\n')
    if (!name || head < 0) continue
    parts[name] = Buffer.from(segment.slice(head + 4).replace(/\r\n$/, ''), 'latin1')
  }
  return parts
}
const identity = 'sandbox-demo'
const METADATA_BYTES = Buffer.from('synthetic metadata tarball\n')
const DISK_BYTES = Buffer.from('synthetic disk image\n')

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sandbox-incus-test-'))
  async function serverCertificate(name: string) {
    execFileSync(
      'openssl',
      [
        'req',
        '-new',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-keyout',
        join(root, `${name}-key.pem`),
        '-out',
        join(root, `${name}-cert.pem`),
      ],
      { stdio: 'ignore' },
    )
    return {
      key: await readFile(join(root, `${name}-key.pem`), 'utf8'),
      cert: await readFile(join(root, `${name}-cert.pem`), 'utf8'),
    }
  }
  serverTLS = await serverCertificate('trusted')
  otherServerTLS = await serverCertificate('untrusted')
  const { key, cert } = serverTLS
  managerFingerprint = fingerprint(cert)
  server = createServer(
    { key, cert, ca: cert, requestCert: true, rejectUnauthorized: true },
    async (req, res) => {
      const url = new URL(req.url!, 'https://localhost')
      const method = req.method!
      // The descriptor-shape probe: the staged disk is unlinked as the upload
      // arrives, before this fake reads a body byte — only a stream already
      // reading the checked descriptor can still deliver the pinned bytes.
      if (unlinkDiskOnUpload && method === 'POST' && url.pathname === '/1.0/images')
        await rm(join(staged, 'disk.qcow2'), { force: true })
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks)
      const body: Json =
        raw.length && !/multipart\/form-data/.test(String(req.headers['content-type'] ?? ''))
          ? JSON.parse(raw.toString())
          : {}
      const peer = (req.socket as TLSSocket).getPeerCertificate()
      const manager = peer.raw && fingerprint(peer.raw) === managerFingerprint
      requests.push({ method, url, body, manager: !!manager, raw })
      const send = (status: number, data: Json | null = null) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ type: 'sync', metadata: data }))
      }
      const inject = fault?.(method, url, body)
      if (inject) {
        res.writeHead(inject.status ?? 200)
        res.end(inject.raw ?? JSON.stringify({ type: 'sync', metadata: inject.data ?? {} }))
        return
      }
      // The fake authorizes the TLS identity, not a mocked request method.
      if (
        !manager &&
        (!certificate ||
          !peer.raw ||
          fingerprint(peer.raw) !== certificate.fingerprint ||
          !certificate.restricted ||
          certificate.projects.length !== 1 ||
          url.searchParams.get('project') !== identity)
      )
        return send(403)
      if (/\/instances|\/profiles/.test(url.pathname) && manager) return send(403)
      if (url.pathname === '/1.0/networks/testbr')
        return send(200, {
          type: 'bridge',
          config: { 'ipv4.address': '10.77.0.1/24', 'ipv4.dhcp': 'false', 'dns.mode': 'none' },
        })
      if (url.pathname === '/1.0/projects' && method === 'POST') {
        project = structuredClone(body)
        return send(200)
      }
      if (url.pathname === `/1.0/projects/${identity}`) {
        if (!manager) return send(403)
        if (!project) return send(404)
        if (method === 'DELETE') {
          // Model Incus's nonempty-project refusal, including its unsafe force override.
          if ((vm || images.size || unexpectedResource) && !url.searchParams.has('force'))
            return send(400)
          vm = undefined
          images = new Set()
          unexpectedResource = undefined
          project = undefined
          if (certificate) certificate.projects = []
          return send(200)
        }
        return send(200, project)
      }
      if (url.pathname === '/1.0/certificates' && method === 'POST') {
        const raw = Buffer.from(body.certificate, 'base64')
        certificate = { ...body, fingerprint: fingerprint(raw) }
        // Enrolling a self-signed Incus client also enrolls its TLS trust anchor.
        server.setSecureContext({ key, cert, ca: [cert, new X509Certificate(raw).toString()] })
        return send(200)
      }
      if (url.pathname.startsWith('/1.0/certificates/')) {
        if (!manager) return send(403)
        if (!certificate || !url.pathname.endsWith(certificate.fingerprint)) return send(404)
        if (method === 'DELETE') {
          certificate = undefined
          return send(200)
        }
        return send(200, certificate)
      }
      if (url.pathname === '/1.0/instances' && method === 'POST') {
        if (
          project?.config['restricted.virtual-machines.nesting'] === 'block' &&
          body.config['security.nesting'] !== 'false'
        )
          return send(403)
        vm = structuredClone(body)
        vm!.config['volatile.eth0.hwaddr'] = '00:16:3e:12:34:56'
        vm!.config['volatile.apply_template'] = 'create'
        if (asyncCreate) {
          vmVisible = false
          res.end(
            JSON.stringify({
              type: 'async',
              metadata: null,
              operation: '/1.0/operations/00000000-0000-0000-0000-000000000000',
            }),
          )
          return
        }
        return send(200)
      }
      if (url.pathname === '/1.0/instances/docker') {
        if (!vm || !vmVisible) return send(404)
        if (method === 'PATCH') {
          Object.assign(vm.config, body.config)
          return send(200)
        }
        if (method === 'DELETE') {
          vm = undefined
          return send(200)
        }
        return send(200, vm)
      }
      if (url.pathname === '/1.0/instances/docker/state') {
        if (method === 'PUT') {
          vmStatus = body.action === 'start' ? 103 : 102
          if (body.action === 'start') delete vm!.config['volatile.apply_template']
          if (asyncNext) {
            asyncNext = false
            res.end(
              JSON.stringify({
                type: 'async',
                metadata: {},
                operation: '/1.0/operations/00000000-0000-0000-0000-000000000000',
              }),
            )
            return
          }
        }
        return send(200, { status_code: vmStatus })
      }
      if (url.pathname === '/1.0/images' && method === 'POST') {
        // Incus computes the fingerprint over the received bytes: metadata
        // tarball followed by the disk image, exactly as the pipeline defines it.
        // The disk part must arrive named `rootfs.img`: that field name is what
        // Incus types the image by (`rootfs` names a CONTAINER rootfs and makes
        // every later VM create refuse; cmd/incusd/images.go). Mirroring the
        // server, a wrong name is a 400, not a silent container import.
        const parts = splitImage(raw, String(req.headers['content-type'] ?? ''))
        if (!parts.metadata || !parts['rootfs.img']) return send(400)
        const assigned = createHash('sha256')
          .update(Buffer.concat([parts.metadata, parts['rootfs.img']]))
          .digest('hex')
        images.add(assigned)
        return res.end(
          JSON.stringify({
            type: 'async',
            metadata: null,
            operation: '/1.0/operations/00000000-0000-0000-0000-000000000000',
          }),
        )
      }
      if (url.pathname === '/1.0/images' && method === 'GET')
        return send(
          200,
          [...images].map((fp) => `/1.0/images/${fp}?project=${identity}`),
        )
      if (/^\/1\.0\/images\/[a-f0-9]{64}$/.test(url.pathname)) {
        const named = url.pathname.slice('/1.0/images/'.length)
        if (!images.has(named)) return send(404)
        if (method === 'DELETE') images.delete(named)
        return send(200, {})
      }
      if (url.pathname.endsWith('/wait')) {
        const code = operationStatus.shift() ?? 200
        if (code === 200) vmVisible = true
        return send(200, { status_code: code })
      }
      return send(404)
    },
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  options = {
    environment: 'demo',
    manager: {
      url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
      ca: cert,
      cert,
      key,
    },
    bridge: 'testbr',
    address: '10.77.0.2',
    storagePool: 'pool',
    image: { server: 'https://images.example.test', fingerprint: 'a'.repeat(64) },
    quota: { cpu: 2, memoryMiB: 1024, diskGiB: 12, rootDiskGiB: 8 },
    stateDirectory: join(root, 'initial'),
  }
  requests = []
  // Cache only local credentials; provisioning must happen inside each test,
  // so a broken guard cannot fail setup and masquerade as a discriminating pin.
  fault = () => ({ status: 503 })
  await expect(createIncusEnvironment(options).reconcile()).rejects.toThrow('request failed (503)')
  fault = undefined
  template = options.stateDirectory
}, 30_000)

beforeEach(async () => {
  server.setSecureContext({ ...serverTLS, ca: serverTLS.cert })
  project = undefined
  certificate = undefined
  vm = undefined
  vmStatus = 102
  images = new Set([options.image.fingerprint])
  unexpectedResource = undefined
  requests = []
  fault = undefined
  operationStatus = []
  asyncNext = false
  asyncCreate = false
  vmVisible = true
  unlinkDiskOnUpload = false
  options = {
    ...options,
    stateDirectory: join(root, `state-${Math.random().toString(16).slice(2)}`),
  }
  await cp(template, options.stateDirectory, { recursive: true })
  await chmod(options.stateDirectory, 0o700)
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
})

function controller() {
  return createIncusEnvironment(options)
}
function daemonConfig() {
  const cloud = JSON.parse(vm!.config['cloud-init.user-data'].split('\n').slice(1).join('\n'))
  const file = cloud.write_files.find((f: Json) => f.path === '/etc/docker/daemon.json')
  return { cloud, daemon: JSON.parse(Buffer.from(file.content, 'base64').toString()) }
}

describe('Incus environment wire contract', () => {
  it('seeds a static address by MAC before first boot for predictable and legacy guest names', async () => {
    await controller().reconcile()
    const seed = JSON.parse(vm!.config['cloud-init.network-config'])
    expect(seed).toEqual({
      version: 2,
      ethernets: {
        sandbox: {
          match: { macaddress: '00:16:3e:12:34:56' },
          dhcp4: false,
          dhcp6: false,
          addresses: ['10.77.0.2/24'],
          routes: [{ to: '0.0.0.0/0', via: '10.77.0.1' }],
          optional: true,
        },
      },
    })
    const patch = requests.findIndex((r) => r.method === 'PATCH')
    const start = requests.findIndex((r) => r.body.action === 'start')
    expect(patch).toBeGreaterThan(-1)
    expect(patch).toBeLessThan(start)
    expect(requests[patch].body).toEqual({
      config: { 'cloud-init.network-config': JSON.stringify(seed) },
    })
  })

  it('seeds a static address using the bridge prefix and gateway', async () => {
    fault = (method, url) => {
      if (method === 'GET' && url.pathname === '/1.0/networks/testbr')
        return {
          data: {
            type: 'bridge',
            config: { 'ipv4.address': '10.77.0.254/16', 'ipv4.dhcp': 'false', 'dns.mode': 'none' },
          },
        }
      return undefined
    }
    await controller().reconcile()
    expect(JSON.parse(vm!.config['cloud-init.network-config'])).toEqual({
      version: 2,
      ethernets: {
        sandbox: {
          match: { macaddress: '00:16:3e:12:34:56' },
          dhcp4: false,
          dhcp6: false,
          addresses: ['10.77.0.2/16'],
          routes: [{ to: '0.0.0.0/0', via: '10.77.0.254' }],
          optional: true,
        },
      },
    })
  })

  it('normalizes the generated MAC and reuses the seed without another write', async () => {
    fault = (method, url) => {
      if (method === 'GET' && url.pathname === '/1.0/instances/docker' && vm) {
        vm.config['volatile.eth0.hwaddr'] = '00:16:3E:AB:CD:EF'
      }
      return undefined
    }
    const c = controller()
    await c.reconcile()
    expect(JSON.parse(vm!.config['cloud-init.network-config']).ethernets.sandbox.match).toEqual({
      macaddress: '00:16:3e:ab:cd:ef',
    })
    requests = []
    await c.reconcile()
    vmStatus = 102
    await c.reconcile()
    expect(requests.some((r) => r.method === 'PATCH')).toBe(false)
    expect(requests.filter((r) => r.body.action === 'start')).toHaveLength(1)
  })
  it.each(
    [
      undefined,
      null,
      42,
      '',
      'not-a-mac',
      '00:16:3e:12:34',
      '0:16:3e:12:34:56',
      '00:16:3e:12:34:56\n',
      '00:16:3e:12:34:56;id',
      '00-16-3e-12-34-56',
      '00:16:3e:12:34:5g',
      '00:16:3e:12:34:56\n00:16:3e:ab:cd:ef',
      ['00:16:3e:12:34:56'],
      {},
    ].map((mac) => ({ mac })),
  )('refuses invalid generated MAC $mac before seeding or start', async ({ mac }) => {
    fault = (method, url) => {
      if (method === 'GET' && url.pathname === '/1.0/instances/docker' && vm)
        vm.config['volatile.eth0.hwaddr'] = mac
      return undefined
    }
    await expect(controller().reconcile()).rejects.toThrow('NIC MAC is invalid')
    expect(requests.some((r) => r.method === 'PATCH' || r.body.action === 'start')).toBe(false)
  })
  it.each([
    { status: 103, marker: 'create' },
    { status: 102, marker: undefined },
    { status: 102, marker: 'copy' },
    { status: 102, marker: 'start' },
  ])(
    'refuses unseeded VMs without first-boot proof $status $marker',
    async ({ status, marker }) => {
      fault = (method, url) => {
        if (method === 'GET' && url.pathname === '/1.0/instances/docker' && vm) {
          vmStatus = status
          vm.config['volatile.apply_template'] = marker
        }
        return undefined
      }
      await expect(controller().reconcile()).rejects.toThrow('before first boot')
      expect(requests.some((r) => r.method === 'PATCH' || r.body.action === 'start')).toBe(false)
    },
  )
  it.each(['{}', '', '{"version":2,"ethernets":{"eth0":{"dhcp4":true}}}'])(
    'refuses drifted network seeds without repairing or starting: %s',
    async (seed) => {
      await controller().reconcile()
      vm!.config['cloud-init.network-config'] = seed
      vmStatus = 102
      requests = []
      await expect(controller().reconcile()).rejects.toThrow('VM configuration has drifted')
      expect(requests.some((r) => r.method === 'PATCH' || r.body.action === 'start')).toBe(false)
    },
  )
  it('refuses a changed generated MAC on an existing seeded VM', async () => {
    await controller().reconcile()
    vm!.config['volatile.eth0.hwaddr'] = '00:16:3e:ab:cd:ef'
    vmStatus = 102
    requests = []
    await expect(controller().reconcile()).rejects.toThrow('VM configuration has drifted')
    expect(requests.some((r) => r.method === 'PATCH' || r.body.action === 'start')).toBe(false)
  })
  it.each(['devices', 'config', 'profiles', 'type'])(
    'refuses initial VM drift in %s before writing a seed',
    async (key) => {
      fault = (method, url) => {
        if (method === 'GET' && url.pathname === '/1.0/instances/docker' && vm)
          vm[key] = key === 'type' ? 'container' : {}
        return undefined
      }
      await expect(controller().reconcile()).rejects.toThrow('VM configuration has drifted')
      expect(requests.some((r) => r.method === 'PATCH' || r.body.action === 'start')).toBe(false)
    },
  )
  it('retains an unbooted VM after a failed seed write and retries safely', async () => {
    fault = (method) => (method === 'PATCH' ? { status: 500 } : undefined)
    await expect(controller().reconcile()).rejects.toThrow('request failed (500)')
    expect(vmStatus).toBe(102)
    expect(requests.some((r) => r.body.action === 'start')).toBe(false)
    fault = undefined
    await controller().reconcile()
    expect(
      requests.filter((r) => r.method === 'POST' && r.url.pathname === '/1.0/instances'),
    ).toHaveLength(1)
    expect(vmStatus).toBe(103)
  })
  it('reads back seed and MAC before starting and refuses ignored or changed writes', async () => {
    for (const mode of ['ignored', 'mac', 'config', 'devices']) {
      // Leave the unbooted instance intact to exercise resumable seeding.
      fault = (method) => {
        if (method !== 'PATCH') return undefined
        if (mode === 'ignored') return { data: {} }
        if (mode === 'mac') vm!.config['volatile.eth0.hwaddr'] = '00:16:3e:ab:cd:ef'
        if (mode === 'config') vm!.config['limits.cpu'] = '3'
        if (mode === 'devices') vm!.devices.eth0.network = 'otherbr'
        return undefined
      }
      await expect(controller().reconcile()).rejects.toThrow(
        mode === 'mac' ? 'MAC changed' : 'VM configuration has drifted',
      )
      expect(requests.some((r) => r.body.action === 'start')).toBe(false)
      if (vm) {
        delete vm.config['cloud-init.network-config']
        vm!.config['volatile.eth0.hwaddr'] = '00:16:3e:12:34:56'
        vm.config['limits.cpu'] = '2'
        vm.devices.eth0.network = 'testbr'
      }
    }
    fault = undefined
    await controller().reconcile()
    expect(vmStatus).toBe(103)
  })
  it('recovers an expired completed creation operation by inspecting the owned instance', async () => {
    asyncCreate = true
    operationStatus = Array(10).fill(103)
    await expect(controller().reconcile()).rejects.toThrow('did not finish')
    vmVisible = true
    fault = (_m, u) => (u.pathname.endsWith('/wait') ? { status: 404 } : undefined)
    await controller().reconcile()
    expect(
      requests.filter((r) => r.method === 'POST' && r.url.pathname === '/1.0/instances'),
    ).toHaveLength(1)
  })
  it('resumes a journaled slow creation across controllers without another create', async () => {
    asyncCreate = true
    operationStatus = Array(10).fill(103)
    await expect(controller().reconcile()).rejects.toThrow('did not finish')
    expect(vmVisible).toBe(false)
    expect(
      JSON.parse(await readFile(join(options.stateDirectory, 'creation.json'), 'utf8')).id,
    ).toMatch(/^[a-f0-9-]{36}$/)
    await controller().reconcile()
    expect(
      requests.filter((r) => r.method === 'POST' && r.url.pathname === '/1.0/instances'),
    ).toHaveLength(1)
    await expect(readFile(join(options.stateDirectory, 'creation.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
  it('provisions one restricted project and certificate with all mandatory restrictions', async () => {
    const connection = await controller().reconcile()
    expect(project!.name).toBe(identity)
    expect(project!.config).toMatchObject({
      restricted: 'true',
      'limits.containers': '0',
      'limits.virtual-machines': '1',
      'limits.cpu': '2',
      'limits.memory': '1024MiB',
      'limits.disk': '12GiB',
      'restricted.networks.access': 'testbr',
      'restricted.images.servers': 'images.example.test',
      'restricted.storage-pools.access': 'pool',
      'restricted.virtual-machines.lowlevel': 'block',
      'restricted.virtual-machines.nesting': 'block',
      'restricted.snapshots': 'block',
      'restricted.backups': 'block',
      'restricted.devices.disk': 'block',
      'restricted.devices.nic': 'managed',
    })
    for (const name of [
      'unix-char',
      'unix-block',
      'unix-hotplug',
      'usb',
      'pci',
      'gpu',
      'infiniband',
      'proxy',
    ])
      expect(project!.config[`restricted.devices.${name}`]).toBe('block')
    expect(certificate).toMatchObject({
      type: 'client',
      name: identity,
      restricted: true,
      projects: [identity],
    })
    expect(vm).toMatchObject({
      name: 'docker',
      type: 'virtual-machine',
      profiles: [],
      config: { 'security.nesting': 'false' },
      devices: {
        eth0: {
          network: 'testbr',
          'ipv4.address': options.address,
          'security.mac_filtering': 'true',
          'security.ipv4_filtering': 'true',
          'security.ipv6_filtering': 'true',
        },
        root: { pool: 'pool', size: '8GiB' },
      },
      source: { server: 'https://images.example.test', fingerprint: options.image.fingerprint },
    })
    expect(vmStatus).toBe(103)
    expect(connection.project).toBe(identity)
    expect(dockerConnectionFromEnv(connection.dockerEnv)).toContain('--tlsverify')
    for (const req of requests.filter((r) => /instances|profiles/.test(r.url.pathname))) {
      expect(req.manager).toBe(false)
      expect(req.url.searchParams.get('project')).toBe(identity)
    }
  })
  it('binds Docker TLS only to the guest bridge address with no plaintext or socket listener', async () => {
    await controller().reconcile()
    const { cloud, daemon } = daemonConfig()
    expect(daemon).toEqual({
      hosts: ['tcp://10.77.0.2:2376'],
      tls: true,
      tlsverify: true,
      tlscacert: '/etc/docker/tls/ca.pem',
      tlscert: '/etc/docker/tls/cert.pem',
      tlskey: '/etc/docker/tls/key.pem',
      'storage-driver': 'overlay2',
      features: { 'containerd-snapshotter': false },
    })
    expect(cloud.runcmd).toContainEqual(['systemctl', 'disable', '--now', 'docker.socket'])
    const unit = cloud.write_files.find((f: Json) => f.path.endsWith('/sandbox.conf'))
    expect(Buffer.from(unit.content, 'base64').toString()).toBe(
      '[Unit]\nRequires=\n[Service]\nExecStart=\nExecStart=/usr/bin/dockerd\n',
    )
    expect(cloud.write_files.every((f: Json) => f.permissions === '0600')).toBe(true)
    expect(await readFile(join(options.stateDirectory, 'client-key.pem'), 'utf8')).toContain(
      'PRIVATE KEY',
    )
  })
  it('reconciles idempotently, starts stopped VMs, and polls scoped async operations', async () => {
    const c = controller()
    asyncNext = true
    operationStatus = [103, 200]
    const first = await c.reconcile()
    expect(await c.reconcile()).toEqual(first)
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(3)
    expect(requests.filter((r) => r.url.pathname.endsWith('/wait'))).toHaveLength(2)
    expect(
      requests
        .filter((r) => r.url.pathname.endsWith('/wait'))
        .every((r) => r.url.searchParams.get('project') === identity),
    ).toBe(true)
  })
  it.each([
    'restricted',
    'limits.containers',
    'limits.cpu',
    'restricted.networks.access',
    'restricted.images.servers',
    'restricted.storage-pools.access',
    'restricted.virtual-machines.nesting',
    'restricted.snapshots',
    'restricted.backups',
    'restricted.devices.proxy',
  ])('refuses project drift: %s', async (key) => {
    const c = controller()
    await c.reconcile()
    delete project!.config[key]
    await expect(c.reconcile()).rejects.toThrow('restrictions have drifted')
  })
  it.each([false, undefined])('refuses a non-restricted certificate (%s)', async (restricted) => {
    const c = controller()
    await c.reconcile()
    certificate!.restricted = restricted
    await expect(c.reconcile()).rejects.toThrow('certificate is not confined')
  })
  it.each([[], ['sandbox-other'], [identity, 'sandbox-other']].map((projects) => ({ projects })))(
    'refuses wrong certificate project scope %j',
    async ({ projects }) => {
      const c = controller()
      await c.reconcile()
      certificate!.projects = projects
      await expect(c.reconcile()).rejects.toThrow('certificate is not confined')
    },
  )
  it('refuses a foreign project or certificate name before using it', async () => {
    const c = controller()
    await c.reconcile()
    project!.config['user.sandbox.owner'] = 'foreign'
    await expect(c.reconcile()).rejects.toThrow('not owned')
    project!.config['user.sandbox.owner'] = JSON.parse(
      await readFile(join(options.stateDirectory, 'state.json'), 'utf8'),
    ).id
    certificate!.name = 'foreign'
    await expect(c.reconcile()).rejects.toThrow('not confined')
  })
  it.each(['type', 'devices', 'profiles', 'config'])('refuses VM drift in %s', async (key) => {
    const c = controller()
    await c.reconcile()
    vm![key] = key === 'type' ? 'container' : {}
    await expect(c.reconcile()).rejects.toThrow('VM configuration has drifted')
  })
  it('refuses one changed VM config key even when other keys still match', async () => {
    const c = controller()
    await c.reconcile()
    vm!.config['limits.cpu'] = '3'
    await expect(c.reconcile()).rejects.toThrow('VM configuration has drifted')
  })
  it.each(['security.nesting', 'security.secureboot'])(
    'refuses an extra VM config key: %s',
    async (key) => {
      const c = controller()
      await c.reconcile()
      vm!.config[key] = 'true'
      await expect(c.reconcile()).rejects.toThrow('VM configuration has drifted')
    },
  )
  it('accepts only volatile and image metadata additions to VM config', async () => {
    const c = controller()
    const first = await c.reconcile()
    vm!.config['volatile.uuid'] = 'generated-by-incus'
    vm!.config['image.description'] = 'image metadata'
    expect(await c.reconcile()).toEqual(first)
  })
  it.each([101, 110])('refuses unexpected VM state %s', async (code) => {
    const c = controller()
    await c.reconcile()
    vmStatus = code
    await expect(c.reconcile()).rejects.toThrow('not running or stopped')
  })
  it.each(['0.0.0.0', '10.78.0.2', '10.77.0.1', '10.77.0.0', '10.77.0.255'])(
    'refuses a Docker address outside guest bridge space: %s',
    async (address) => {
      const c = createIncusEnvironment({
        ...options,
        address,
        stateDirectory: join(root, `bad-${address}`),
      })
      await expect(c.reconcile()).rejects.toThrow('guest address')
      expect(requests.some((r) => r.method === 'POST')).toBe(false)
    },
  )
  it.each([
    { type: 'physical', cidr: '10.77.0.1/24' },
    { type: 'bridge', cidr: '10.77.0.1/32' },
  ])('refuses an invalid bridge type/subnet independently: $type $cidr', async ({ type, cidr }) => {
    fault = (_m, u) =>
      u.pathname.includes('/networks/')
        ? { data: { type, config: { 'ipv4.address': cidr } } }
        : undefined
    await expect(controller().reconcile()).rejects.toThrow('guest address')
    expect(requests.some((r) => r.method === 'POST')).toBe(false)
  })
})

describe('Incus local image source', () => {
  const pin = sha256(Buffer.concat([METADATA_BYTES, DISK_BYTES]))
  const localConfig = (fingerprint: string, disk = DISK_BYTES) =>
    createIncusEnvironment({
      ...options,
      image: {
        files: { metadata: join(staged, 'metadata.tar'), disk: join(staged, 'disk.qcow2') },
        fingerprint,
      },
      // A fresh directory, never the copied template: the image option changes
      // the state binding, and an empty directory starts a new state.
      stateDirectory: join(root, `local-${Math.random().toString(16).slice(2)}`),
    })
  const noCreate = () =>
    expect(
      requests.filter(
        (r) =>
          r.method === 'POST' &&
          (r.url.pathname === '/1.0/images' || r.url.pathname === '/1.0/instances'),
      ),
    ).toEqual([])

  beforeEach(async () => {
    images = new Set()
    // The operator stages the two files root-owned; the marker directory is
    // what the lstat mock reads as uid 0, since an unprivileged test cannot
    // create a root-owned file for real.
    staged = join(await realpath(root), 'root-owned-fixture')
    await rm(staged, { recursive: true, force: true })
    await mkdir(staged, { recursive: true })
    await writeFile(join(staged, 'metadata.tar'), METADATA_BYTES)
    await writeFile(join(staged, 'disk.qcow2'), DISK_BYTES, { mode: 0o600 })
  })

  it('imports the pinned files into its own project with the restricted credential, then creates the instance from that image alone', async () => {
    await localConfig(pin).reconcile()
    const upload = requests.find((r) => r.method === 'POST' && r.url.pathname === '/1.0/images')
    expect(upload?.manager).toBe(false)
    expect(upload?.url.searchParams.get('project')).toBe(identity)
    expect([...images]).toEqual([pin])
    const create = requests.find((r) => r.method === 'POST' && r.url.pathname === '/1.0/instances')
    expect(create?.body.source).toEqual({ type: 'image', fingerprint: pin })
    expect(Object.keys(create?.body.source).sort()).toEqual(['fingerprint', 'type'])
    expect(project?.config['restricted.images.servers']).toBeUndefined()
    expect(vmStatus).toBe(103)
  })

  it('reuses the imported image on a later reconcile without another upload', async () => {
    const c = localConfig(pin)
    await c.reconcile()
    vmStatus = 102
    requests = []
    await c.reconcile()
    expect(requests.some((r) => r.method === 'POST' && r.url.pathname === '/1.0/images')).toBe(
      false,
    )
    expect(requests.some((r) => r.body.action === 'start')).toBe(true)
  })

  it('refuses, deletes what Incus assigned and creates no instance when one disk byte is altered', async () => {
    await writeFile(join(staged, 'disk.qcow2'), Buffer.from('synthetic disk imagE\n'), {
      mode: 0o600,
    })
    const assigned = sha256(Buffer.concat([METADATA_BYTES, Buffer.from('synthetic disk imagE\n')]))
    expect(assigned).not.toBe(pin)
    await expect(localConfig(pin).reconcile()).rejects.toThrow(
      'fingerprint other than the pinned one',
    )
    expect(images.size).toBe(0)
    const removed = requests.find(
      (r) => r.method === 'DELETE' && r.url.pathname.startsWith('/1.0/images/'),
    )
    expect(removed?.url.pathname).toBe(`/1.0/images/${assigned}`)
    expect(removed?.url.searchParams.get('project')).toBe(identity)
    expect(requests.some((r) => r.method === 'POST' && r.url.pathname === '/1.0/instances')).toBe(
      false,
    )
  })

  it('keeps an image already verified in the project when a later import mismatches the pin', async () => {
    const earlier = 'b'.repeat(64)
    images = new Set([earlier])
    await writeFile(join(staged, 'disk.qcow2'), Buffer.from('synthetic disk imagE\n'), {
      mode: 0o600,
    })
    const assigned = sha256(Buffer.concat([METADATA_BYTES, Buffer.from('synthetic disk imagE\n')]))
    expect(assigned).not.toBe(pin)
    await expect(localConfig(pin).reconcile()).rejects.toThrow(
      'fingerprint other than the pinned one',
    )
    expect(images.has(earlier)).toBe(true)
    const removed = requests.filter(
      (r) => r.method === 'DELETE' && r.url.pathname.startsWith('/1.0/images/'),
    )
    expect(removed.map((r) => r.url.pathname)).toEqual([`/1.0/images/${assigned}`])
    expect(requests.some((r) => r.method === 'POST' && r.url.pathname === '/1.0/instances')).toBe(
      false,
    )
  })

  it('uploads from the checked descriptor, not a re-opened path', async () => {
    unlinkDiskOnUpload = true
    await localConfig(pin).reconcile()
    expect([...images]).toEqual([pin])
    expect(vmStatus).toBe(103)
  })

  it.each([
    ['63 characters', 'a'.repeat(63)],
    ['a non-hex character', 'a'.repeat(63) + 'g'],
    ['uppercase hex', 'A'.repeat(64)],
  ])('refuses a pin of $0 before any request', (_, bad) => {
    expect(() => localConfig(bad)).toThrow('pinned image fingerprint')
    expect(requests).toEqual([])
  })

  it('refuses image files under an unreadable ancestor instead of reading it as no checkout', async () => {
    // The name carries both markers: root-owned (accepted) and the injected
    // EACCES on the checkout walk's lstat of this directory's `.git`.
    const hidden = join(await realpath(root), 'root-owned-fixture-unreadable-ancestor-fixture')
    await rm(hidden, { recursive: true, force: true })
    await mkdir(hidden, { recursive: true })
    await writeFile(join(hidden, 'metadata.tar'), METADATA_BYTES)
    await writeFile(join(hidden, 'disk.qcow2'), DISK_BYTES)
    staged = hidden
    await expect(localConfig(pin).reconcile()).rejects.toThrow(
      'must have readable parent directories',
    )
    noCreate()
  })

  it('teardown removes the imported image only from its own project', async () => {
    const c = localConfig(pin)
    await c.reconcile()
    requests = []
    await c.teardown()
    const removed = requests.filter(
      (r) => r.method === 'DELETE' && r.url.pathname.startsWith('/1.0/images/'),
    )
    expect(removed.map((r) => r.url.pathname)).toEqual([`/1.0/images/${pin}`])
    expect(removed[0].url.searchParams.get('project')).toBe(identity)
    for (const r of requests) expect(r.url.pathname).not.toContain('sandbox-other')
  })

  it.each([
    [
      'a symlinked file',
      async () => {
        await writeFile(join(staged, 'real-disk'), DISK_BYTES)
        await rm(join(staged, 'disk.qcow2'))
        await symlink(join(staged, 'real-disk'), join(staged, 'disk.qcow2'))
        return 'must not be reached through a symlink'
      },
    ],
    [
      'a symlinked directory',
      async () => {
        const real = join(await realpath(root), 'real-staged')
        await mkdir(real)
        await writeFile(join(real, 'metadata.tar'), METADATA_BYTES)
        await writeFile(join(real, 'disk.qcow2'), DISK_BYTES)
        await rm(staged, { recursive: true })
        await symlink(real, staged)
        return 'must not be reached through a symlink'
      },
    ],
    [
      'a missing file',
      async () => {
        await rm(join(staged, 'disk.qcow2'))
        return 'file is unreadable'
      },
    ],
    [
      'a directory in place of the disk',
      async () => {
        await rm(join(staged, 'disk.qcow2'))
        await mkdir(join(staged, 'disk.qcow2'))
        return 'must be a regular file'
      },
    ],
    [
      'a relative path',
      async () => {
        staged = 'staged-relative'
        return 'must be an absolute path'
      },
    ],
    [
      'a file owned by the running user',
      async () => {
        // A plain directory holds real files of the unprivileged test uid; only
        // the root-owned-fixture marker pretends otherwise.
        const plain = join(await realpath(root), 'plain-staged')
        await rm(plain, { recursive: true, force: true })
        await mkdir(plain, { recursive: true })
        await writeFile(join(plain, 'metadata.tar'), METADATA_BYTES)
        await writeFile(join(plain, 'disk.qcow2'), DISK_BYTES, { mode: 0o600 })
        staged = plain
        return 'must be root-owned'
      },
    ],
    [
      'a group-writable file',
      async () => {
        await chmod(join(staged, 'disk.qcow2'), 0o620)
        return 'must not be group- or other-writable'
      },
    ],
    [
      'an other-writable file',
      async () => {
        await chmod(join(staged, 'metadata.tar'), 0o606)
        return 'must not be group- or other-writable'
      },
    ],
    [
      'an oversized file',
      async () => {
        // The name carries both markers: root-owned (accepted) and oversized.
        const oversized = join(await realpath(root), 'oversized-fixture-root-owned-fixture')
        await rm(oversized, { recursive: true, force: true })
        await mkdir(oversized, { recursive: true })
        await writeFile(join(oversized, 'metadata.tar'), METADATA_BYTES)
        await writeFile(join(oversized, 'disk.qcow2'), DISK_BYTES)
        staged = oversized
        return 'exceeds its size limit'
      },
    ],
    [
      'a file under a checkout',
      async () => {
        const checkout = join(await realpath(root), 'checkout-root-owned-fixture')
        await mkdir(join(checkout, '.git'), { recursive: true })
        await writeFile(join(checkout, 'metadata.tar'), METADATA_BYTES)
        await writeFile(join(checkout, 'disk.qcow2'), DISK_BYTES)
        staged = checkout
        return 'must not live under a checkout'
      },
    ],
  ])('refuses image files that are $0 before any upload', async (_, prepare) => {
    const message = await prepare()
    await expect(localConfig(pin).reconcile()).rejects.toThrow(message)
    noCreate()
  })

  it('refuses an image option naming both sources, or neither, before any request', () => {
    const bad = (image: unknown) =>
      createIncusEnvironment({
        ...options,
        image: image as IncusEnvironmentOptions['image'],
        stateDirectory: join(root, 'bad-image'),
      })
    expect(() =>
      bad({
        server: 'https://images.example.test',
        files: { metadata: staged + '/metadata.tar', disk: staged + '/disk.qcow2' },
        fingerprint: pin,
      }),
    ).toThrow('exactly one source')
    expect(() => bad({ fingerprint: pin })).toThrow('exactly one source')
    expect(() => bad({ files: { metadata: staged + '/metadata.tar' }, fingerprint: pin })).toThrow(
      'metadata and disk paths',
    )
    expect(requests).toEqual([])
  })
})

describe('Incus teardown boundary', () => {
  it('revokes an exact orphaned certificate after Incus removes its project reference', async () => {
    const c = controller()
    await c.reconcile()
    project = undefined
    certificate!.projects = []
    await c.teardown()
    expect(certificate).toBeUndefined()
  })
  it('refuses a foreign scope even when the original project is gone', async () => {
    const c = controller()
    await c.reconcile()
    project = undefined
    certificate!.projects = ['sandbox-other']
    requests = []
    await expect(c.teardown()).rejects.toThrow('not confined')
    expect(requests.some((r) => r.method === 'DELETE')).toBe(false)
  })
  it('waits for an unfinished creation before teardown and can clean up failed creation', async () => {
    asyncCreate = true
    operationStatus = Array(10).fill(103)
    await expect(controller().reconcile()).rejects.toThrow('did not finish')
    operationStatus = [400]
    vm = undefined
    await controller().teardown()
    expect(project).toBeUndefined()
    expect(certificate).toBeUndefined()
  })
  it.each(['features.images', 'features.profiles', 'features.storage.volumes'])(
    'refuses inherited resources during teardown: %s',
    async (key) => {
      const c = controller()
      await c.reconcile()
      project!.config[key] = 'false'
      requests = []
      await expect(c.teardown()).rejects.toThrow('resource isolation has drifted')
      expect(requests.some((r) => r.method === 'DELETE')).toBe(false)
    },
  )
  it('tears down only the own instance, image, project and exact certificate; repeats safely', async () => {
    const c = controller()
    await c.reconcile()
    requests = []
    await c.teardown()
    await c.teardown()
    expect(project).toBeUndefined()
    expect(vm).toBeUndefined()
    expect(certificate).toBeUndefined()
    for (const r of requests) {
      expect(r.url.pathname).not.toContain('sandbox-other')
      if (r.url.pathname.includes('/instances/') || r.url.pathname.includes('/profiles/'))
        expect(r.url.searchParams.get('project')).toBe(identity)
      if (r.method === 'DELETE' && r.url.pathname.includes('/projects/'))
        expect(r.url.pathname).toBe(`/1.0/projects/${identity}`)
      if (r.method === 'DELETE') {
        expect(r.url.searchParams.has('force')).toBe(false)
        const scoped = /\/instances\/|\/images\//.test(r.url.pathname)
        expect(r.url.search).toBe(scoped ? `?project=${identity}` : '')
      }
    }
    expect(requests.filter((r) => r.method === 'DELETE').map((r) => r.url.pathname)).toEqual([
      '/1.0/instances/docker',
      `/1.0/images/${options.image.fingerprint}`,
      `/1.0/projects/${identity}`,
      expect.stringMatching(/^\/1.0\/certificates\/[a-f0-9]{64}$/),
    ])
  })
  it('does nothing without local state', async () => {
    await createIncusEnvironment({ ...options, stateDirectory: join(root, 'no-state') }).teardown()
    expect(requests).toEqual([])
  })
  it('refuses foreign project ownership without deletion', async () => {
    const c = controller()
    await c.reconcile()
    project!.config['user.sandbox.owner'] = 'someone-else'
    requests = []
    await expect(c.teardown()).rejects.toThrow('not owned')
    expect(requests.some((r) => r.method === 'DELETE')).toBe(false)
  })
  it('refuses a foreign VM without deleting it', async () => {
    const c = controller()
    await c.reconcile()
    vm!.config['user.sandbox.owner'] = 'someone-else'
    await expect(c.teardown()).rejects.toThrow('VM is not owned')
  })
  it('refuses missing/foreign certificates during teardown', async () => {
    const c = controller()
    await c.reconcile()
    const cert = certificate
    certificate = undefined
    await expect(c.teardown()).rejects.toThrow('certificate is missing')
    certificate = cert
    certificate!.projects = ['sandbox-other']
    await expect(c.teardown()).rejects.toThrow('not confined')
  })
  it('handles an already-removed VM and refuses force deletion of a nonempty project', async () => {
    const c = controller()
    await c.reconcile()
    vm = undefined
    unexpectedResource = { name: 'operator-volume', contents: 'retain-me' }
    const retainedProject = structuredClone(project)
    const retainedCertificate = structuredClone(certificate)
    await expect(c.teardown()).rejects.toThrow('request failed (400)')
    expect(unexpectedResource).toEqual({ name: 'operator-volume', contents: 'retain-me' })
    expect(project).toEqual(retainedProject)
    expect(certificate).toEqual(retainedCertificate)
    expect(
      requests.filter((r) => r.method === 'DELETE' && r.url.pathname.includes('/projects/')),
    ).toHaveLength(1)
    for (const r of requests.filter((r) => r.method === 'DELETE'))
      expect(r.url.searchParams.has('force')).toBe(false)
    expect(await readFile(join(options.stateDirectory, 'client-key.pem'), 'utf8')).toContain(
      'PRIVATE KEY',
    )
  })
  it('rotates the CA, Docker client key and Incus certificate after complete teardown', async () => {
    const c = controller()
    await c.reconcile()
    const oldCA = fingerprint(await readFile(join(options.stateDirectory, 'ca.pem')))
    const oldClientKey = await readFile(join(options.stateDirectory, 'client-key.pem'), 'utf8')
    const oldIncus = certificate!.fingerprint
    await c.teardown()
    expect(await readdir(options.stateDirectory)).toEqual([])
    await c.reconcile()
    expect(fingerprint(await readFile(join(options.stateDirectory, 'ca.pem')))).not.toBe(oldCA)
    expect(await readFile(join(options.stateDirectory, 'client-key.pem'), 'utf8')).not.toBe(
      oldClientKey,
    )
    expect(certificate!.fingerprint).not.toBe(oldIncus)
  })
})

describe('Incus trust and diagnostics', () => {
  it('keeps the operator-only API outside the root entry point', async () => {
    const rootEntry = await readFile(new URL('../index.ts', import.meta.url), 'utf8')
    expect(rootEntry).not.toContain('incus-environment')
    expect(rootEntry).not.toContain('createIncusEnvironment')
    const { createIncusEnvironment: factory } = await import('../incus-environment.server')
    expect(factory).toBe(createIncusEnvironment)
    expect(Object.keys(await import('../incus-environment.server')).sort()).toEqual([
      'createIncusEnvironment',
      'probeDockerEndpoint',
    ])
  })
  it('generates CA and leaf certificates with explicit roles, issuer, SAN and validity', async () => {
    await controller().reconcile()
    const ca = new X509Certificate(await readFile(join(options.stateDirectory, 'ca.pem')))
    expect(ca.ca).toBe(true)
    expect(ca.issuer).toBe(ca.subject)
    expect(ca.verify(ca.publicKey)).toBe(true)
    for (const role of ['ca', 'server', 'client', 'incus']) {
      const cert = new X509Certificate(await readFile(join(options.stateDirectory, `${role}.pem`)))
      const start = Date.parse(cert.validFrom),
        end = Date.parse(cert.validTo)
      expect(start).toBeLessThanOrEqual(Date.now())
      expect(end).toBeGreaterThan(Date.now())
      expect(end - start).toBe(365 * 24 * 60 * 60 * 1000)
      if (role === 'server' || role === 'client') {
        expect(cert.ca).toBe(false)
        expect(cert.issuer).toBe(ca.subject)
        expect(cert.checkIssued(ca)).toBe(true)
        expect(cert.verify(ca.publicKey)).toBe(true)
        expect(cert.keyUsage).toEqual([
          role === 'server' ? '1.3.6.1.5.5.7.3.1' : '1.3.6.1.5.5.7.3.2',
        ])
        expect(cert.subjectAltName).toBe(
          role === 'server' ? `IP Address:${options.address}` : undefined,
        )
      }
      if (role !== 'incus') {
        const text = execFileSync(
          'openssl',
          ['x509', '-in', join(options.stateDirectory, `${role}.pem`), '-noout', '-text'],
          { encoding: 'utf8' },
        )
        expect(text).toMatch(/Basic Constraints: critical/)
        expect(text).toMatch(role === 'ca' ? /CA:TRUE, pathlen:0/ : /CA:FALSE/)
        expect(text).toMatch(/Key Usage: critical/)
        expect(text).toContain(
          role === 'ca' ? 'Certificate Sign, CRL Sign' : 'Digital Signature, Key Encipherment',
        )
      }
    }
  })
  it('sets all private keys and state journals to 0600 even with a 0644-writing openssl', async () => {
    // Exercise real generation while modelling LibreSSL's keyout permissions on
    // every toolchain, so OpenSSL's safer default cannot hide a missing chmod.
    const openssl = execFileSync('which', ['openssl'], { encoding: 'utf8' }).trim()
    const bin = join(root, 'legacy-openssl')
    await mkdir(bin)
    await writeFile(
      join(bin, 'openssl'),
      '#!/bin/sh\n"$INCUS_TEST_OPENSSL" "$@" || exit $?\nwhile [ "$#" -gt 1 ]; do\n  if [ "$1" = "-keyout" ]; then /bin/chmod 0644 "$2"; break; fi\n  shift\ndone\n',
      { mode: 0o700 },
    )
    vi.stubEnv('INCUS_TEST_OPENSSL', openssl)
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
    options.stateDirectory = join(root, 'private-modes')
    asyncCreate = true
    operationStatus = Array(10).fill(103)
    try {
      await expect(controller().reconcile()).rejects.toThrow('did not finish')
      for (const name of [
        'ca-key.pem',
        'incus-key.pem',
        'server-key.pem',
        'client-key.pem',
        'state.json',
        'creation.json',
      ])
        expect((await stat(join(options.stateDirectory, name))).mode & 0o777, name).toBe(0o600)
    } finally {
      vi.unstubAllEnvs()
    }
  })
  it('refuses non-default image-server ports before any request', () => {
    expect(() =>
      createIncusEnvironment({
        ...options,
        image: { ...options.image, server: 'https://images.example.test:8443' },
      }),
    ).toThrow('default HTTPS port')
    expect(requests).toEqual([])
    expect(() =>
      createIncusEnvironment({
        ...options,
        image: { ...options.image, server: 'https://images.example.test:443' },
      }),
    ).not.toThrow()
  })
  it.each(['not-json', '{"id":"https://other.example.test/operation"}'])(
    'refuses invalid journal state without following a foreign operation',
    async (contents) => {
      const c = controller()
      await c.reconcile()
      await writeFile(join(options.stateDirectory, 'creation.json'), contents)
      await expect(c.reconcile()).rejects.toThrow('creation state is invalid')
    },
  )
  it.each([
    'http://127.0.0.1:1',
    'https://user:secret@example.test',
    'https://example.test/path',
    'bad',
  ])('refuses non-HTTPS origins or embedded secrets: %s', (url) => {
    expect(() =>
      createIncusEnvironment({ ...options, manager: { ...options.manager, url } }),
    ).toThrow('HTTPS origin')
  })
  it('refuses incomplete TLS, malformed names, image pins, quotas and state paths', () => {
    for (const patch of [
      { manager: { ...options.manager, key: '' } },
      { environment: '../other' },
      { bridge: 'all,networks' },
      { storagePool: '../pool' },
      { image: { ...options.image, fingerprint: 'latest' } },
      { address: '::' },
      { stateDirectory: '/' },
      { stateDirectory: 'relative' },
      { quota: { ...options.quota, cpu: 0 } },
      { quota: { ...options.quota, diskGiB: 1 } },
    ])
      expect(() => createIncusEnvironment({ ...options, ...patch })).toThrow()
  })
  it('refuses a different server certificate with a matching SAN before sending API requests', async () => {
    expect(new X509Certificate(otherServerTLS.cert).checkIP('127.0.0.1')).toBe('127.0.0.1')
    expect(fingerprint(otherServerTLS.cert)).not.toBe(fingerprint(serverTLS.cert))
    let received = false
    const impostor = createServer(
      { ...otherServerTLS, ca: serverTLS.cert, requestCert: true, rejectUnauthorized: true },
      (_req, res) => {
        received = true
        res.end(JSON.stringify({ type: 'sync', metadata: {} }))
      },
    )
    await new Promise<void>((resolve) => impostor.listen(0, '127.0.0.1', resolve))
    try {
      const c = createIncusEnvironment({
        ...options,
        manager: {
          ...options.manager,
          url: `https://127.0.0.1:${(impostor.address() as AddressInfo).port}`,
        },
        stateDirectory: join(root, 'different-server'),
      })
      await expect(c.reconcile()).rejects.toThrow('connection failed')
      expect(received).toBe(false)
      expect(requests).toEqual([])
    } finally {
      await new Promise<void>((resolve) => impostor.close(() => resolve()))
    }
  })
  it('never falls back to HTTP, ignores redirects and rejects untrusted server TLS', async () => {
    const cleartext = httpServer((_req, res) => res.end('plaintext'))
    await new Promise<void>((resolve) => cleartext.listen(0, '127.0.0.1', resolve))
    const c = createIncusEnvironment({
      ...options,
      manager: {
        ...options.manager,
        url: `https://127.0.0.1:${(cleartext.address() as AddressInfo).port}`,
      },
      stateDirectory: join(root, 'plaintext'),
    })
    await expect(c.reconcile()).rejects.toThrow('connection failed')
    await new Promise<void>((resolve) => cleartext.close(() => resolve()))
    // Same TLS origin, new state binding, but untrusted CA: a real TLS failure.
    const untrusted = createIncusEnvironment({
      ...options,
      manager: { ...options.manager, ca: 'not-a-ca' },
      stateDirectory: join(root, 'untrusted'),
    })
    await expect(untrusted.reconcile()).rejects.toThrow('connection failed')
    fault = () => ({ status: 302, raw: 'secret-redirection' })
    await expect(controller().reconcile()).rejects.toThrow('request failed (302)')
  })
  it.each([400, 401, 403, 500])(
    'does not expose provider secret bodies or log credentials for status %s',
    async (status) => {
      const log = vi.spyOn(console, 'log'),
        error = vi.spyOn(console, 'error'),
        warn = vi.spyOn(console, 'warn')
      fault = () => ({ status, raw: options.manager.key + 'private-body-value' })
      let caught: unknown
      try {
        await controller().reconcile()
      } catch (e) {
        caught = e
      }
      expect(String(caught)).toBe(`Error: Incus API request failed (${status})`)
      expect(log).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
      log.mockRestore()
      error.mockRestore()
      warn.mockRestore()
    },
  )
  it.each(['not-json-secret', '{}', '{"type":"error","metadata":{"secret":"value"}}'])(
    'refuses malformed API envelopes without reflecting them',
    async (raw) => {
      fault = () => ({ raw })
      await expect(controller().reconcile()).rejects.toThrow('response is invalid')
    },
  )
  it('refuses redirected or invalid operation hrefs without following them', async () => {
    fault = (_m, u) =>
      u.pathname.endsWith('/state')
        ? { raw: '{"type":"async","metadata":{},"operation":"https://other.example.test/secret"}' }
        : undefined
    await expect(controller().reconcile()).rejects.toThrow('operation reference is invalid')
  })
  it('reports operation failures and finite operation exhaustion', async () => {
    asyncNext = true
    operationStatus = [400]
    await expect(controller().reconcile()).rejects.toThrow('operation failed')
    vmStatus = 102
    asyncNext = true
    operationStatus = Array(10).fill(103)
    await expect(controller().reconcile()).rejects.toThrow('did not finish')
  })
  it('rejects concurrent calls and captures options against later mutation', async () => {
    const c = controller()
    options.environment = 'other'
    const pending = c.reconcile()
    await expect(c.teardown()).rejects.toThrow('already running')
    expect((await pending).project).toBe(identity)
    options.environment = 'demo'
  })
  it('refuses broad directory permissions, symlink directories and malformed state', async () => {
    await chmod(options.stateDirectory, 0o755)
    await expect(controller().reconcile()).rejects.toThrow('private')
    await chmod(options.stateDirectory, 0o700)
    await writeFile(join(options.stateDirectory, 'state.json'), 'secret-invalid-json')
    await expect(controller().reconcile()).rejects.toThrow('state is invalid')
    const link = join(root, 'link')
    await symlink(template, link)
    await expect(
      createIncusEnvironment({ ...options, stateDirectory: link }).reconcile(),
    ).rejects.toThrow('private')
  })
  it('refuses state belonging to another configuration', async () => {
    await expect(
      createIncusEnvironment({ ...options, environment: 'other' }).reconcile(),
    ).rejects.toThrow('another configuration')
  })
  it('refuses incomplete local state without overwriting keys', async () => {
    const key = await readFile(join(options.stateDirectory, 'client-key.pem'), 'utf8')
    await rm(join(options.stateDirectory, 'state.json'))
    await expect(controller().reconcile()).rejects.toThrow('operator recovery required')
    expect(await readFile(join(options.stateDirectory, 'client-key.pem'), 'utf8')).toBe(key)
  })
})
