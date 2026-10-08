// Test-only preload in the actual vinxi process, before any app imports.
import { writeFileSync, existsSync } from 'node:fs'
import process from 'node:process'

if (process.env.E2E_BROWSER_PROBE_FILE) {
  if (process.env.E2E_BROWSER_PROBE_DEFERRED === '1') {
    const timer = globalThis.setInterval(async () => {
      if (!existsSync(process.env.E2E_BROWSER_PROBE_FILE + '.trigger')) return
      globalThis.clearInterval(timer)
      try {
        await globalThis.fetch('https://browser-egress.invalid/probe', {
          signal: globalThis.AbortSignal.timeout(3000),
        })
      } catch {
        /* application code may swallow the refusal */
      }
      writeFileSync(process.env.E2E_BROWSER_PROBE_FILE + '.done', '')
    }, 50)
    timer.unref()
  }
  let status = null
  if (
    process.env.E2E_BROWSER_PROBE_EGRESS === '1' &&
    process.env.E2E_BROWSER_PROBE_DEFERRED !== '1'
  ) {
    try {
      status = (
        await globalThis.fetch('https://browser-egress.invalid/probe', {
          signal: globalThis.AbortSignal.timeout(3000),
        })
      ).status
    } catch {
      // CONNECT is refused by the backstop; application code may swallow it too.
    }
  }
  if (process.env.E2E_BROWSER_PROBE_EXIT === '1') process.exit(17)
  writeFileSync(
    process.env.E2E_BROWSER_PROBE_FILE,
    JSON.stringify({
      pid: process.pid,
      jevUrl: process.env.JEV_DECISIONS_URL,
      key: process.env.OPENROUTER_API_KEY,
      jevKey: process.env.JEV_DECISIONS_API_KEY,
      status,
    }),
  )
}
