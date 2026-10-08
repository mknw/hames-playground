/** A dead-end transport: records attempted targets and never opens an upstream socket. */
import { createServer, get } from 'node:http'
import { IS_HERMETIC } from './mode'
import type { AddressInfo } from 'node:net'

export interface EgressAttempt {
  method: string
  target: string
}

export async function startEgressBackstop() {
  let pending: EgressAttempt[] = []
  const recorded: EgressAttempt[] = []
  const record = (method: string, target: string) => {
    const attempt = { method, target }
    pending.push(attempt)
    recorded.push(attempt)
  }
  const server = createServer((req, res) => {
    // Only origin-form requests to this loopback control endpoint can drain
    // the log. Proxy requests use absolute-form URLs and are always refused.
    if (req.method === 'GET' && req.url === '/record') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(pending))
      pending = []
      return
    }
    record(req.method ?? 'UNKNOWN', req.url ?? '')
    res.writeHead(403).end('e2e hermetic egress refused')
  })
  server.on('connect', (req, socket) => {
    record('CONNECT', req.url ?? '')
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url,
    recorded,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      )
    },
  }
}

/** Direct loopback control request, independent of fetch's proxy dispatcher. */
export async function takeEgressAttempts(): Promise<EgressAttempt[]> {
  const url = process.env.E2E_EGRESS_BACKSTOP
  if (!url) {
    if (!IS_HERMETIC) return []
    throw new Error('e2e hermetic egress backstop was not started')
  }
  return new Promise((resolve, reject) => {
    get(`${url}/record`, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body) as EgressAttempt[])
        } catch (err) {
          reject(err)
        }
      })
      res.on('error', reject)
    }).on('error', reject)
  })
}

/** Drain and fail even when application error handling swallowed the refusal. */
export async function assertNoUnexpectedEgress(): Promise<void> {
  const attempts = await takeEgressAttempts()
  if (attempts.length > 0) {
    throw new Error(
      attempts
        .map((attempt) => `e2e hermetic egress refused ${attempt.method} ${attempt.target}`)
        .join('\n'),
    )
  }
}
