/**
 * Everything that has to exist before the first browser opens, in order.
 *
 * ORDER IS THE POINT, the same way it is in `e2e/lib/app.ts` — for a different
 * reason. There, app modules freeze configuration at import, so the fakes must
 * be listening before the first dynamic `import()`. Here the app is a separate
 * PROCESS, so the fakes must be listening before it is spawned: its environment
 * is fixed at spawn time and there is no second chance to point it anywhere.
 *
 * The teardown is the function this returns — Playwright calls it after the
 * last test — rather than a sibling `globalTeardown` file, so the handles never
 * have to be shared through module state or re-derived from a file.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { chromium } from '@playwright/test'
import { provisionDatabase } from '../src/__tests__/global-setup'
import { startBackend, assertHermetic } from './lib/backend'
import { generateBamlClient, startDevServer } from './lib/server'
import { conversationRows, wipeUserRows } from './lib/db'
import {
  APP_PORT,
  BYPASS_USER_ID,
  DATA_ENCRYPTION_KEY,
  HANDLES_FILE,
  POISONED_ANTHROPIC_KEY,
  SERVER_BOOT_TIMEOUT_MS,
  TEST_DATABASE_URL,
  VERDA_SCALEDOWN_SECONDS,
} from './lib/env'

export default async function globalSetup(): Promise<() => Promise<void>> {
  // The provisioning CODE is shared with the unit suite rather than
  // reimplemented; the TARGET is this suite's own since #280 — see
  // `lib/env.ts#TEST_DATABASE_URL` for what sharing it cost.
  await provisionDatabase(TEST_DATABASE_URL)

  // `pnpm dev`'s own `predev` hook, which spawning vinxi directly skips.
  generateBamlClient()

  const backend = await startBackend()

  const server = await startDevServer(APP_PORT, {
    // ---- The database, and only the throwaway one --------------------------
    // `vinxi dev` loads `app/.env` through dotenv, which does NOT override keys
    // already present in the environment — so these win. The preflight below
    // proves it rather than trusting it, because the failure mode is the one
    // `src/__tests__/global-setup.ts` was written to prevent: a test run
    // rewriting a developer's real conversations under the unit-test key.
    DATABASE_URL: TEST_DATABASE_URL,
    TEST_DATABASE_URL,
    DATA_ENCRYPTION_KEY,
    // This suite's identity, not the literal every bypassed request used to
    // share. `lib/auth/dev-bypass.ts` reads it through `import.meta.env`, so one
    // line moves the browser bundle's `AuthProvider` and the server's turn path
    // together — and `wipeUserRows()` deletes only rows this suite created.
    VITE_DEV_BYPASS_USER_ID: BYPASS_USER_ID,

    // ---- Auth --------------------------------------------------------------
    // The same gate `app/e2e/` uses (`SD-15`). Both halves are required, and
    // one of them (`import.meta.env.DEV`) is why this layer runs `vinxi dev`
    // rather than a build — see `lib/server.ts`.
    VITE_DEV_BYPASS_AUTH: 'true',

    // ---- The fakes ---------------------------------------------------------
    MCP_GATEWAY_URL: backend.gateway.url,
    // The SHIPPED seam: `VerdaQwen` declares `base_url env.VERDA_INFERENCE_ENDPOINT`
    // and BAML resolves `env.*` at call time. Pointing it at the fake is what a
    // developer does to run the deployment locally; `assertVerdaConfigured()`
    // still runs its `/v1` check. Setting it also makes the self-hosted tier
    // AVAILABLE, which is what the switch's verda position needs — and
    // what makes it the default tier for a user who has never chosen.
    VERDA_INFERENCE_ENDPOINT: backend.llm.baseUrl,
    VERDA_INFERENCE_API_KEY: 'e2e-browser-fake-key',
    // The private tier's SECOND model (2026-08-26): `describe` runs on the 4B
    // `LocalQwenSmall` over this var, and `verdaConfigured()` asks about BOTH
    // endpoints — so without this line the switch renders its private
    // position DISABLED and every scenario that clicks it fails on the click,
    // not on anything it was written to test. Same fake as above: it records
    // the request's `model`, which is what lets a scenario tell the 4B's calls
    // from the 27B's. The API key is optional in production (llama-server
    // authenticates nothing) and set here only for symmetry with the 27B.
    SMALL_LLM_BASE_URL: backend.llm.baseUrl,
    SMALL_LLM_API_KEY: 'e2e-browser-fake-key',
    // See the constant: with the shipped 180s, the suite's own preflight turn
    // would leave the box "warm" for the whole run and the cold-start notice
    // could never fire again.
    VERDA_SCALEDOWN_SECONDS: String(VERDA_SCALEDOWN_SECONDS),
    // The wake is a POLL since 2026-08-27, and its shipped 30s per-attempt bound
    // would put a clock back into the one scenario #280 took the clocks OUT of.
    // Scenario 2 PARKS the wake ping and then makes several browser assertions
    // against a turn that provably cannot advance; with a 30s bound, a machine
    // slow enough to spend 30s on those assertions would see the poll abandon the
    // parked request and send a second, and `held.length === 1` would go red for
    // the load on the box rather than for anything about the app. Ten minutes is
    // longer than any scenario holds a request (the fake's own fuse is 60s), so
    // one parked wake stays one parked wake. What the poll RETRIES is covered a
    // layer down, in `app/e2e/scenarios/08-cold-start-ux` and `verda-wake.test.ts`.
    VERDA_WAKE_ATTEMPT_TIMEOUT_MS: String(10 * 60 * 1000),
    // The Anthropic half, which has no such seam. See
    // `src/lib/inference/dev-fake-inference.server.ts`.
    E2E_FAKE_INFERENCE_URL: backend.llm.baseUrl,
    // Poisoned, so a redirect that failed to install fails LOUDLY (a 401)
    // instead of quietly billing a run advertised as hermetic.
    ANTHROPIC_API_KEY: POISONED_ANTHROPIC_KEY,
    // Never the process default: each scenario decides its tier the way the
    // switch does, so a stray deployment default would mask a broken
    // preference read.
    USE_VERDA_INFERENCE: undefined,

    BAML_LOG: process.env.BAML_LOG ?? 'warn',
  })

  try {
    await wipeUserRows()
    await runPreflight(backend, server.url)
    await warmTheClientBundle(server.url)
    await wipeUserRows()
  } catch (err) {
    await server.stop()
    await backend.stop()
    throw err
  }

  mkdirSync(path.dirname(HANDLES_FILE), { recursive: true })
  writeFileSync(
    HANDLES_FILE,
    JSON.stringify({ appUrl: server.url, controlUrl: backend.controlUrl }, null, 2),
  )

  return async () => {
    await server.stop()
    await backend.stop()
  }
}

/**
 * Two claims, both by observation, both refusing to run when false.
 *
 * 1. **The run is hermetic.** A real turn's BAML calls have to arrive at the
 *    fake — including at least one on an Anthropic-chain role, which is the
 *    half the shipped `VERDA_INFERENCE_ENDPOINT` seam cannot cover.
 * 2. **The server is on the throwaway database.** The turn above persists a
 *    row; it has to be visible in this suite's own database. If `app/.env` or a stray
 *    shell export won the `DATABASE_URL` race, this suite would be writing to a
 *    developer's dev database — and `initSchema()`'s backfill would re-encrypt
 *    their real conversations under the unit-test key, after which `pnpm dev`
 *    refuses to boot. That is not a failure worth discovering from a scenario.
 */
async function runPreflight(
  backend: Awaited<ReturnType<typeof startBackend>>,
  appUrl: string,
): Promise<void> {
  await assertHermetic(backend, appUrl)

  const rows = await conversationRows()
  if (rows.length === 0) {
    throw new Error(
      'e2e-browser preflight: a turn completed but no conversation row landed in ' +
        `${TEST_DATABASE_URL}. The dev server is persisting somewhere else — check that ` +
        'DATABASE_URL reached it and that app/.env is not overriding it. Refusing to run: ' +
        'the suite would be writing to (and wiping rows from) a database it does not own.',
    )
  }
}

/**
 * Open the app in a browser ONCE, before any scenario, and wait for the composer.
 *
 * `/api/health` proves the dev server is serving HTTP; `runPreflight` proves the
 * SERVER half of a turn works. Neither touches the CLIENT module graph, and under
 * `vinxi dev` that graph is transformed ON DEMAND, on the first request for it.
 * On a cold vite cache that first paint took over 20 seconds on this repo
 * (measured 2026-08-26, first run in a fresh worktree) — so scenarios 1 and 2
 * both failed inside `open()`, on the project's 20s expect timeout, with the nav
 * rendered and the chat column not yet compiled. Nothing was wrong with the app.
 *
 * That is a determinism bug of exactly the #280 shape, and widening the expect
 * timeout would be the wrong fix twice over: it would hide a genuinely slow first
 * paint behind the same budget every real assertion uses, and it would leave the
 * cost in whichever scenario happens to run first, so the suite would keep
 * reporting the bundler as an app failure.
 *
 * So the cost is paid here instead, once, against `SERVER_BOOT_TIMEOUT_MS` — the
 * budget that already exists for "a cold vite start is not fast" — and every
 * scenario's own 20s then measures the app rather than the transform pipeline.
 *
 * It asserts nothing else on purpose: the claim is only "the client bundle is
 * built and the shell paints". Everything a person can see is a scenario's job.
 */
async function warmTheClientBundle(appUrl: string): Promise<void> {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    // The BUDGET HAS TO COVER THE NAVIGATION TOO, not only the wait after it.
    // Left at Playwright's 30s default this line was the first thing a fresh
    // worktree hit: `goto` waits for `load`, which under `vinxi dev` means the
    // whole on-demand module graph, and it timed out at 30s while the message
    // below blamed the client bundle for being broken. The budget for "a cold
    // vite start is not fast" already exists — this is the same one every other
    // step of the boot uses.
    await page.goto(appUrl, { timeout: SERVER_BOOT_TIMEOUT_MS })
    await page
      .getByPlaceholder('Type your message')
      .waitFor({ state: 'visible', timeout: SERVER_BOOT_TIMEOUT_MS })
  } catch (err) {
    throw new Error(
      'e2e-browser: the app shell never painted in a browser, so no scenario could have ' +
        `run. The dev server answered /api/health and served a whole turn, so this is the ` +
        'CLIENT half — a compile error in the module graph, or a first transform slower ' +
        `than E2E_BROWSER_BOOT_TIMEOUT_MS (${SERVER_BOOT_TIMEOUT_MS}ms). Re-run with ` +
        `E2E_BROWSER_SERVER_LOG=1 to see which. (${
          err instanceof Error ? err.message : String(err)
        })`,
    )
  } finally {
    await browser.close()
  }
}
