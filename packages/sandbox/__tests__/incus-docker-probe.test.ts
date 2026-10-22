import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as httpServer, type Server as HttpServer } from 'node:http'
import { createServer, type Server } from 'node:https'
import { createServer as netServer, type AddressInfo, type Server as NetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
import { probeDockerEndpoint } from '../incus-environment.server'

// Real TLS in both directions against local fakes of an environment VM's dockerd.
let root: string
const servers: (Server | HttpServer | NetServer)[] = []
const file = (name: string) => join(root, name)
const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: root, stdio: 'ignore' })
function authority(name: string) {
  openssl(
    ...['req', '-new', '-x509', '-nodes', '-days', '1', '-subj', `/CN=${name}`],
    ...['-newkey', 'rsa:2048', '-keyout', `${name}-key.pem`, '-out', `${name}.pem`],
    ...['-addext', 'basicConstraints=critical,CA:TRUE'],
  )
}
function csr(name: string) {
  openssl(
    ...['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${name}`],
    ...['-keyout', `${name}-key.pem`, '-out', `${name}.csr`],
  )
}
function leaf(name: string, ca: string) {
  csr(name)
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
async function issue(name: string, ca: string, role: 'server' | 'client', san = 'IP:127.0.0.1') {
  await writeFile(
    file(`${name}.ext`),
    `basicConstraints=critical,CA:FALSE\nextendedKeyUsage=${role === 'server' ? 'serverAuth' : 'clientAuth'}\n` +
      (role === 'server' ? `subjectAltName=${san}\n` : ''),
  )
  leaf(name, ca)
}
// A server leaf from this environment's CA with fixed past or future dates:
// `openssl ca` takes explicit dates, where `-days` cannot reach the past.
function dated(name: string, start: string, end: string) {
  csr(name)
  openssl(
    ...['ca', '-batch', '-notext', '-config', 'dated.cnf', '-in', `${name}.csr`],
    ...['-out', `${name}.pem`, '-startdate', start, '-enddate', end],
    ...['-cert', 'env-ca.pem', '-keyfile', 'env-ca-key.pem', '-extensions', 'server'],
  )
}
const pem = (name: string) => readFile(file(`${name}.pem`), 'utf8')

type Answer = (path: string) => { status: number; body: string }
const ok: Answer = (path) =>
  path === '/_ping' ? { status: 200, body: 'OK' } : { status: 404, body: '' }
async function docker(
  server: string,
  answer: Answer = ok,
  tls12 = false,
  chain: string[] = [],
): Promise<string> {
  const instance = createServer(
    {
      ...(tls12 ? { maxVersion: 'TLSv1.2' as const } : {}),
      key: await readFile(file(`${server}-key.pem`), 'utf8'),
      cert: [await pem(server), ...(await Promise.all(chain.map(pem)))].join(''),
      ca: await pem('env-ca'),
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      const { status, body } = answer(req.url ?? '')
      if (body === 'silent') return
      if (body === 'cut')
        return void res
          .writeHead(status, { 'content-length': '2' })
          .write('O', () => req.socket.destroy())
      if (body !== 'endless') return void res.writeHead(status).end(body)
      res.writeHead(status)
      const timer = setInterval(() => res.write('x'.repeat(16)), 5)
      res.on('close', () => clearInterval(timer))
    },
  )
  return listen(instance)
}
async function listen(instance: Server | HttpServer | NetServer): Promise<string> {
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
  authority('self-signed-server')
  await issue('env-server', 'env-ca', 'server')
  await issue('env-client', 'env-ca', 'client')
  await issue('other-server', 'other-ca', 'server')
  await issue('other-client', 'other-ca', 'client')
  await issue('misnamed-server', 'env-ca', 'server', 'DNS:docker.example.test')
  await writeFile(
    file('dated.cnf'),
    [
      '[ca]\ndefault_ca = dated\n[dated]\ndatabase = index.txt\nnew_certs_dir = .',
      'serial = serial.txt\ndefault_md = sha256\npolicy = any\nunique_subject = no',
      '[any]\ncommonName = supplied\n[server]\nbasicConstraints = critical,CA:FALSE',
      'extendedKeyUsage = serverAuth\nsubjectAltName = IP:127.0.0.1\n',
    ].join('\n'),
  )
  await writeFile(file('index.txt'), '')
  await writeFile(file('serial.txt'), '01\n')
  dated('expired-server', '20200101000000Z', '20200102000000Z')
  dated('future-server', '20990101000000Z', '20990102000000Z')
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

  // Every server-certificate verification failure is final, by category.
  it.each([
    ["another environment's CA", () => docker('other-server')],
    ['an untrusted root in its chain', () => docker('other-server', ok, false, ['other-ca'])],
    ['a self-signed certificate', () => docker('self-signed-server')],
    ['a certificate for another name', () => docker('misnamed-server')],
    ['an expired certificate', () => docker('expired-server')],
    ['a certificate not yet valid', () => docker('future-server')],
  ])('refuses to trust a daemon with %s, finally', async (_label, daemon) => {
    expect(await probeDockerEndpoint(env(await daemon()))).toEqual({
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

  it('gives up on a daemon that accepts and then stays silent', async () => {
    // Silent before TLS: nothing has answered, so nothing is known.
    const mute = await listen(netServer(() => undefined))
    expect(await probeDockerEndpoint(env(mute), { timeoutMs: 200 })).toEqual({
      ready: false,
      reason: 'unreachable',
    })
    // Silent after TLS completed: the same label as a dropped connection.
    const silent = await docker('env-server', () => ({ status: 200, body: 'silent' }))
    expect(await probeDockerEndpoint(env(silent), { timeoutMs: 200 })).toEqual({
      ready: false,
      reason: 'refused',
    })
  })

  it('bounds every probe, by default at ten seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      await probeDockerEndpoint(env(await docker('env-server')))
      expect(timeout).toHaveBeenCalledWith(10_000)
    } finally {
      timeout.mockRestore()
    }
  })

  it('opens a fresh connection for every probe', async () => {
    const host = await docker('env-server')
    let connections = 0
    servers.at(-1)!.on('secureConnection', () => connections++)
    for (let i = 0; i < 2; i++)
      expect(await probeDockerEndpoint(env(host))).toMatchObject({ ready: true })
    expect(connections).toBe(2)
  })

  it.each([
    ['an error status', () => ({ status: 500, body: 'OK' })],
    ['another body', () => ({ status: 200, body: 'NOT OK' })],
    ['an endless body, without reading it all', () => ({ status: 200, body: 'endless' })],
    ['a body cut off mid-answer', () => ({ status: 200, body: 'cut' })],
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
