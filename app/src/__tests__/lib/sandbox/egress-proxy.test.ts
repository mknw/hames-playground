/**
 * egress-proxy tests — the allowlist CONNECT proxy that enforces the
 * `pypi` / `github-trusted` egress profiles (#116).
 *
 * Hermetic but REAL at the socket layer: the proxy module is imported straight
 * from rootfs/egress-proxy/proxy.mjs and driven in-process over loopback
 * sockets — no Docker, no LLM. This is the only test that can prove the two
 * properties the whole design rests on: an allowed host tunnels, and a
 * non-allowlisted host is refused at the proxy (the internal network has no
 * other way out).
 *
 * The audit log is part of the contract (#116: "outbound audit logging"):
 * every request, allowed or denied, must appear in the audit stream.
 */

import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import http from 'node:http'
import {
  hostAllowed,
  parseArgs,
  createProxyServer,
} from '../../../../../rootfs/egress-proxy/proxy.mjs'

interface AuditRecord {
  kind: string
  host: string
  allowed: boolean
  [k: string]: unknown
}

const openServers: Array<net.Server> = []

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      openServers.push(server)
      resolve((server.address() as { port: number }).port)
    })
  })
}

afterEach(() => {
  for (const s of openServers.splice(0)) s.close()
})

/** Start the proxy with an audit sink; returns { port, audit }. */
async function startProxy(allowlist: string[]) {
  const audit: AuditRecord[] = []
  const server = createProxyServer(allowlist, { onAudit: (r) => void audit.push(r) })
  const port = await listen(server)
  return { port, audit }
}

/** Open a CONNECT tunnel through the proxy; resolve the raw socket + first response line. */
function connect(
  proxyPort: number,
  target: string,
): Promise<{ statusLine: string; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
    })
    socket.once('error', reject)
    let buf = ''
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf-8')
      if (buf.includes('\r\n\r\n') || buf.includes('\r\n')) {
        socket.off('data', onData)
        resolve({ statusLine: buf.split('\r\n')[0], socket })
      }
    }
    socket.on('data', onData)
  })
}

describe('hostAllowed', () => {
  const allowlist = ['pypi.org', 'files.pythonhosted.org', 'githubusercontent.com']
  it('allows exact matches, case-insensitively', () => {
    expect(hostAllowed('pypi.org', allowlist)).toBe(true)
    expect(hostAllowed('PYPI.org', allowlist)).toBe(true)
  })
  it('allows subdomains of an entry (dot-suffix, not substring)', () => {
    expect(hostAllowed('objects.githubusercontent.com', allowlist)).toBe(true)
    expect(hostAllowed('notpypi.org', allowlist)).toBe(false) // substring ≠ subdomain
  })
  it('denies everything else, and an empty allowlist denies all', () => {
    expect(hostAllowed('evil.test', allowlist)).toBe(false)
    expect(hostAllowed('pypi.org.evil.test', allowlist)).toBe(false)
    expect(hostAllowed('pypi.org', [])).toBe(false)
    expect(hostAllowed('', allowlist)).toBe(false)
  })
})

describe('parseArgs', () => {
  it('reads --port once and --host repeatedly', () => {
    expect(parseArgs(['--port', '3129', '--host', 'a.test', '--host', 'b.test'])).toEqual({
      hosts: ['a.test', 'b.test'],
      port: 3129,
    })
    expect(parseArgs([])).toEqual({ hosts: [], port: 3128 })
  })
})

describe('createProxyServer — CONNECT tunneling', () => {
  it('tunnels an allowlisted host end-to-end', async () => {
    // A stand-in "upstream" the allowlist points at, via the loopback IP.
    const upstream = net.createServer((sock) => sock.write('HELLO-FROM-UPSTREAM'))
    const upstreamPort = await listen(upstream)
    const { port, audit } = await startProxy(['127.0.0.1'])

    const { statusLine, socket } = await connect(port, `127.0.0.1:${upstreamPort}`)
    expect(statusLine).toBe('HTTP/1.1 200 Connection Established')
    const first = await new Promise<string>((resolve) =>
      socket.once('data', (d: Buffer) => resolve(d.toString())),
    )
    expect(first).toBe('HELLO-FROM-UPSTREAM')
    socket.destroy()

    // The allowed connection is in the audit trail.
    await new Promise((r) => setTimeout(r, 10))
    expect(audit).toContainEqual(
      expect.objectContaining({ kind: 'CONNECT', host: '127.0.0.1', allowed: true }),
    )
  })

  it('REFUSES a non-allowlisted host — the allowlist is the policy', async () => {
    const { port, audit } = await startProxy(['pypi.org'])
    const { statusLine, socket } = await connect(port, 'evil.test:443')
    expect(statusLine).toBe('HTTP/1.1 403 Forbidden')
    socket.destroy()
    await new Promise((r) => setTimeout(r, 10))
    expect(audit).toContainEqual(
      expect.objectContaining({ kind: 'CONNECT', host: 'evil.test', allowed: false }),
    )
  })

  it('refuses upstream connect failures with 502 (no silent tunnel)', async () => {
    const { port } = await startProxy(['127.0.0.1'])
    // Port 1 on loopback: nothing listening there in a test env.
    const { statusLine, socket } = await connect(port, '127.0.0.1:1')
    expect(statusLine).toBe('HTTP/1.1 502 Bad Gateway')
    socket.destroy()
  })
})

describe('createProxyServer — plain-HTTP proxying', () => {
  it('denies absolute-URI requests with 405 (HTTPS CONNECT only)', async () => {
    const { port, audit } = await startProxy(['127.0.0.1'])
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: 'http://pypi.org/simple/', method: 'GET' },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(405)
    expect(audit).toContainEqual(expect.objectContaining({ kind: 'http', allowed: false }))
  })
})
