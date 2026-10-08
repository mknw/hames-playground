// Test-only preload in the actual vinxi process, before any app imports.
import { writeFileSync } from 'node:fs'
import process from 'node:process'

if (process.env.E2E_BROWSER_PROBE_FILE) {
  let status = null
  if (process.env.E2E_BROWSER_PROBE_EGRESS === '1') {
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
  writeFileSync(
    process.env.E2E_BROWSER_PROBE_FILE,
    JSON.stringify({
      pid: process.pid,
      jevUrl: process.env.JEV_DECISIONS_URL,
      key: process.env.OPENROUTER_API_KEY,
      status,
    }),
  )
}
