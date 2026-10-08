import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test as lifecycleTest } from '@playwright/test'
import { test } from '../lib/egress-fixture'
import { startBackend } from '../lib/backend'
import { startDevServer } from '../lib/server'
import {
  browserServerEnv,
  assertBrowserProxyRuntime,
  bootBrowserBackend,
  finishBrowserBackend,
} from '../global-setup'
import { APP_PORT } from '../lib/env'
import { startEgressBackstop } from '../../e2e/lib/egress-backstop'

// Each lifecycle pin closes its recorder. Do not pool control sockets across
// ephemeral backstop lifetimes: the next drain must open a fresh connection.
http.globalAgent = new http.Agent({ keepAlive: false })

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
    const previousJevKey = process.env.JEV_DECISIONS_API_KEY
    process.env.JEV_DECISIONS_API_KEY = 'sk-or-parent-synthetic-key'
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
        jevKey: string
        key: string
        status: number | null
      }
    } finally {
      await server?.stop()
      if (previousJevKey === undefined) delete process.env.JEV_DECISIONS_API_KEY
      else process.env.JEV_DECISIONS_API_KEY = previousJevKey
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
    expect(observed.jevKey).toBe('e2e-browser-fake-key')
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

// No global beforeAll: these pins own exactly the lifecycle globalSetup uses.
lifecycleTest.describe('layer-3 global setup wiring', () => {
  function preload(report: string, egress: string) {
    return {
      NODE_OPTIONS: `--import=${fileURLToPath(new URL('./dev-server-probe.mjs', import.meta.url))}`,
      E2E_BROWSER_PROBE_FILE: report,
      E2E_BROWSER_PROBE_EGRESS: egress === 'deferred' ? '1' : egress,
      E2E_BROWSER_PROBE_DEFERRED: egress === 'deferred' ? '1' : '0',
    }
  }

  async function expectFinalRefusal(
    handles: Awaited<ReturnType<typeof bootBrowserBackend>>,
    report: string,
  ) {
    let finishing = false
    try {
      writeFileSync(report + '.trigger', '')
      await expect.poll(() => existsSync(report + '.done')).toBe(true)
      finishing = true
      await expect(finishBrowserBackend(handles)).rejects.toThrow(
        'e2e hermetic egress refused CONNECT browser-egress.invalid:443',
      )
    } finally {
      // A failed witness must not leave a dev server holding the next pin's port.
      if (!finishing) await finishBrowserBackend(handles).catch(() => {})
    }
  }

  lifecycleTest('post-warm drain rejects boot-time dev-server egress', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'browser-boot-egress-'))
    let handles: Awaited<ReturnType<typeof bootBrowserBackend>> | undefined
    try {
      await expect(async () => {
        handles = await bootBrowserBackend({
          env: preload(path.join(directory, 'probe.json'), '1'),
          warm: async () => {},
        })
      }).rejects.toThrow('e2e hermetic egress refused CONNECT browser-egress.invalid:443')
    } finally {
      if (handles) await finishBrowserBackend(handles).catch(() => {})
      rmSync(directory, { recursive: true, force: true })
    }
  })

  lifecycleTest('failed spawn drains pre-boot egress before closing', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'browser-spawn-egress-'))
    try {
      await expect(
        bootBrowserBackend({
          env: { ...preload(path.join(directory, 'probe.json'), '1'), E2E_BROWSER_PROBE_EXIT: '1' },
          warm: async () => {},
        }),
      ).rejects.toThrow('e2e hermetic egress refused CONNECT browser-egress.invalid:443')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  lifecycleTest('teardown drain rejects dev-server egress after warm', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'browser-final-egress-'))
    const report = path.join(directory, 'probe.json')
    const handles = await bootBrowserBackend({
      env: preload(report, 'deferred'),
      warm: async () => {},
    })
    try {
      await expectFinalRefusal(handles, report)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  for (const failingStop of ['server', 'backend'] as const) {
    lifecycleTest(`teardown drains even when ${failingStop}.stop throws`, async () => {
      const directory = mkdtempSync(path.join(tmpdir(), 'browser-stop-egress-'))
      const report = path.join(directory, 'probe.json')
      const handles = await bootBrowserBackend({
        env: preload(report, 'deferred'),
        warm: async () => {},
      })
      const stop = handles[failingStop].stop.bind(handles[failingStop])
      handles[failingStop].stop = async () => {
        await stop()
        throw new Error('synthetic stop failure')
      }
      try {
        await expectFinalRefusal(handles, report)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })
  }
})
