import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { spawn } from 'node:child_process'
import { it, expect, vi } from 'vitest'
import {
  assertProxyNode,
  proxyEnvironment,
  assertEgressSelfTest,
} from '../../../lib/eval-support/hermetic-egress'
it('refuses Node versions that cannot proxy fetch from startup', () => {
  for (const version of ['22.20.0', '24.4.9'])
    expect(() => assertProxyNode(version)).toThrow('24.5')
  expect(() => assertProxyNode('24.5.0')).not.toThrow()
  expect(() => assertProxyNode('25.0.0')).not.toThrow()
})
it.skipIf(
  Number(process.versions.node.split('.')[0]) < 24 ||
    (Number(process.versions.node.split('.')[0]) === 24 &&
      Number(process.versions.node.split('.')[1]) < 5),
)('starts a real child whose Node fetch reaches the recording proxy', async () => {
  assertProxyNode()
  const targets: string[] = []
  const server = createServer((req, res) => {
    targets.push(req.url ?? '')
    res.writeHead(403).end()
  })
  server.on('connect', (req, socket) => {
    targets.push(req.url ?? '')
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const child = spawn(
      process.execPath,
      [
        '-e',
        "fetch('http://egress-selftest.invalid/', {signal:AbortSignal.timeout(1000)}).catch(()=>{}).finally(()=>process.exit(0))",
      ],
      { env: proxyEnvironment(proxy), stdio: 'ignore' },
    )
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', () => resolve())
    })
    expect(targets).toEqual(['egress-selftest.invalid:80'])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
it('refuses a startup self-test with no recorded attempt', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('refused'))
  vi.stubGlobal('fetch', fetch)
  try {
    await expect(assertEgressSelfTest(async () => [])).rejects.toThrow('self-test failed')
    await expect(
      assertEgressSelfTest(async () => [{ target: 'http://egress-selftest.invalid/' }]),
    ).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
  }
})

it('constructs proxy env for the child before spawn, including loopback exemptions', () => {
  const url = 'http://127.0.0.1:19099'
  expect(proxyEnvironment(url)).toMatchObject({
    NODE_USE_ENV_PROXY: '1',
    GENERAL_EVAL_CHILD: '1',
    E2E_EGRESS_BACKSTOP: url,
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    all_proxy: url,
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  })
})
