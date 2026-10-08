import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from '@playwright/test'
import { test } from '../lib/egress-fixture'
import { startBackend } from '../lib/backend'
import { startDevServer } from '../lib/server'
import { browserServerEnv, assertBrowserProxyRuntime } from '../global-setup'
import { APP_PORT } from '../lib/env'
import { startEgressBackstop } from '../../e2e/lib/egress-backstop'

test.describe('layer-3 dev server transport', () => {
  let backend: Awaited<ReturnType<typeof startBackend>>
  let backstop: Awaited<ReturnType<typeof startEgressBackstop>>
  test.beforeAll(async () => {
    backend = await startBackend()
    backstop = await startEgressBackstop()
    process.env.E2E_EGRESS_BACKSTOP = backstop.url
  })
  test.afterAll(async () => {
    await backend.stop()
    await backstop.close()
  })

  test('runtimes without env-proxy support refuse before boot', () => {
    expect(() => assertBrowserProxyRuntime('24.4.0')).toThrow('Node >=24.5')
    expect(() => assertBrowserProxyRuntime('22.22.0')).toThrow('Node >=24.5')
    expect(() => assertBrowserProxyRuntime('24.5.0')).not.toThrow()
  })

  async function probe(egress = false) {
    const directory = mkdtempSync(path.join(tmpdir(), 'browser-egress-'))
    const report = path.join(directory, 'probe.json')
    const previousKey = process.env.OPENROUTER_API_KEY
    const previousUrl = process.env.JEV_DECISIONS_URL
    process.env.OPENROUTER_API_KEY = 'sk-or-parent-synthetic-key'
    process.env.JEV_DECISIONS_URL = 'https://parent-decisions.invalid/api/alpha/decisions'
    const env = browserServerEnv(backend, backstop.url)
    env.NODE_OPTIONS = `--import=${fileURLToPath(new URL('./dev-server-probe.mjs', import.meta.url))}`
    env.E2E_BROWSER_PROBE_FILE = report
    env.E2E_BROWSER_PROBE_EGRESS = egress ? '1' : '0'
    let server: Awaited<ReturnType<typeof startDevServer>> | undefined
    try {
      server = await startDevServer(APP_PORT, env)
      return JSON.parse(readFileSync(report, 'utf8')) as {
        pid: number
        jevUrl: string
        key: string
        status: number | null
      }
    } finally {
      await server?.stop()
      if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY
      else process.env.OPENROUTER_API_KEY = previousKey
      if (previousUrl === undefined) delete process.env.JEV_DECISIONS_URL
      else process.env.JEV_DECISIONS_URL = previousUrl
      rmSync(directory, { recursive: true, force: true })
    }
  }

  test('explicit fake Jev URL and key win in the dev server process', async () => {
    const observed = await probe()
    expect(observed.pid).not.toBe(process.pid)
    expect(observed.jevUrl).toBe(backend.llm.baseUrl.replace(/\/v1$/, '') + '/api/alpha/decisions')
    expect(observed.key).toBe('e2e-browser-fake-key')
  })

  test('a swallowed dev-server egress attempt fails the run', async () => {
    await probe(true)
    // Check the witness BEFORE marking this an expected failure. Without proxy
    // env, .invalid fails DNS but records nothing, so the pin must go red.
    expect(backstop.recorded).toContainEqual({
      method: 'CONNECT',
      target: 'browser-egress.invalid:443',
    })
    // Only the automatic fixture's drain may produce this expected failure.
    test.fail(true, 'the shared fixture must fail this test on the recorded attempt')
  })
})
