import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as httpServer, type Server as HttpServer } from 'node:http'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
import { probeDockerEndpoint } from '../incus-environment.server'

// Real TLS in both directions against local fakes of an environment VM's dockerd.
let root: string
const servers: (Server | HttpServer)[] = []
const file = (name: string) => join(root, name)
const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: root, stdio: 'ignore' })
function authority(name: string) {
  openssl(
    ...['req', '-new', '-x509', '-nodes', '-days', '1', '-subj', `/CN=${name}`],
    ...['-newkey', 'rsa:2048', '-keyout', `${name}-key.pem`, '-out', `${name}.pem`],
    ...['-addext', 'basicConstraints=critical,CA:TRUE'],
  )
}
function leaf(name: string, ca: string) {
  openssl(
    ...['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${name}`],
    ...['-keyout', `${name}-key.pem`, '-out', `${name}.csr`],
  )
  openssl(
    ...['x509', '-req', '-days', '1', '-in', `${name}.csr`, '-CA', `${ca}.pem`],
    ...[
      '-CAkey',
      `${ca}-key.pem`,
      '-CAcreateserial',
      '-out',
      `${name}.pem`,
      '-extfile',
      `${name}.ext`,
    ],
  )
}
async function issue(name: string, ca: string, role: 'server' | 'client') {
  await writeFile(
    file(`${name}.ext`),
    `basicConstraints=critical,CA:FALSE\nextendedKeyUsage=${role === 'server' ? 'serverAuth' : 'clientAuth'}\n` +
      (role === 'server' ? 'subjectAltName=IP:127.0.0.1\n' : ''),
  )
  leaf(name, ca)
}
const pem = (name: string) => readFile(file(`${name}.pem`), 'utf8')

type Answer = (path: string) => { status: number; body: string }
const ok: Answer = (path) =>
  path === '/_ping' ? { status: 200, body: 'OK' } : { status: 404, body: '' }
async function docker(server: string, answer: Answer = ok, tls12 = false): Promise<string> {
  const instance = createServer(
    {
      ...(tls12 ? { maxVersion: 'TLSv1.2' as const } : {}),
      key: await readFile(file(`${server}-key.pem`), 'utf8'),
      cert: await pem(server),
      ca: await pem('env-ca'),
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      const { status, body } = answer(req.url ?? '')
      if (body !== 'endless') return void res.writeHead(status).end(body)
      res.writeHead(status)
      const timer = setInterval(() => res.write('x'.repeat(16)), 5)
      res.on('close', () => clearInterval(timer))
    },
  )
  return listen(instance)
}
async function listen(instance: Server | HttpServer): Promise<string> {
  servers.push(instance)
  await new Promise<void>((done) => instance.listen(0, '127.0.0.1', done))
  return `tcp://127.0.0.1:${(instance.address() as AddressInfo).port}`
}
const env = (host: string, client = 'env-client') => ({
  SANDBOX_DOCKER_HOST: host,
  SANDBOX_DOCKER_TLS_CA: file('env-ca.pem'),
  SANDBOX_DOCKER_TLS_CERT: file(`${client}.pem`),
  SANDBOX_DOCKER_TLS_KEY: file(`${client}-key.pem`),
})

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sandbox-docker-probe-'))
  authority('env-ca')
  authority('other-ca')
  await issue('env-server', 'env-ca', 'server')
  await issue('env-client', 'env-ca', 'client')
  await issue('other-server', 'other-ca', 'server')
  await issue('other-client', 'other-ca', 'client')
})
afterAll(async () => {
  for (const instance of servers) instance.close()
  await rm(root, { recursive: true, force: true })
})

describe('probeDockerEndpoint (#648)', () => {
  it("answers ready with this environment's files and reports the client certificate expiry", async () => {
    const probe = await probeDockerEndpoint(env(await docker('env-server')))
    expect(probe).toEqual({ ready: true, clientCertificateValidTo: expect.any(String) })
    if (probe.ready) expect(Date.parse(probe.clientCertificateValidTo)).toBeGreaterThan(Date.now())
  })

  it("refuses to trust a daemon whose certificate is not this environment's, finally", async () => {
    expect(await probeDockerEndpoint(env(await docker('other-server')))).toEqual({
      ready: false,
      reason: 'untrusted-server',
    })
  })

  it("is refused by the daemon with another environment's client certificate", async () => {
    const host = await docker('env-server')
    expect(await probeDockerEndpoint(env(host, 'other-client'))).toEqual({
      ready: false,
      reason: 'refused',
    })
    // A TLS 1.2 daemon refuses during the handshake, indistinguishable from a
    // listener that drops connections: never ready, and never final.
    const legacy = await docker('env-server', ok, true)
    expect(await probeDockerEndpoint(env(legacy, 'other-client'))).toEqual({
      ready: false,
      reason: 'unreachable',
    })
  })

  it('never answers ready from plaintext or from a closed port', async () => {
    const plaintext = httpServer((_req, res) => res.writeHead(200).end('OK'))
    expect(await probeDockerEndpoint(env(await listen(plaintext)))).toEqual({
      ready: false,
      reason: 'unreachable',
    })
    const closed = createServer()
    const host = await listen(closed)
    await new Promise((done) => closed.close(done))
    expect(await probeDockerEndpoint(env(host))).toEqual({ ready: false, reason: 'unreachable' })
  })

  it.each([
    ['an error status', () => ({ status: 500, body: 'OK' })],
    ['another body', () => ({ status: 200, body: 'NOT OK' })],
    ['an endless body, without reading it all', () => ({ status: 200, body: 'endless' })],
  ])('is not ready on %s', async (_label, answer) => {
    expect(await probeDockerEndpoint(env(await docker('env-server', answer)))).toEqual({
      ready: false,
      reason: 'not-ready',
    })
  })

  it('probes only a TLS tcp endpoint and keeps file errors silent', async () => {
    await expect(
      probeDockerEndpoint({ SANDBOX_DOCKER_HOST: 'unix:///var/run/docker.sock' } as never),
    ).rejects.toThrow(/TLS tcp endpoint/)
    const missing = { ...env('tcp://127.0.0.1:2376'), SANDBOX_DOCKER_TLS_KEY: file('absent.pem') }
    await expect(probeDockerEndpoint(missing)).rejects.toThrow(/^Docker TLS files are unreadable$/)
  })
})
