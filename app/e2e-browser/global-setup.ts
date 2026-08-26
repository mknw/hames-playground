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
import provisionTestDatabase from '../src/__tests__/global-setup'
import { startBackend, assertHermetic } from './lib/backend'
import { generateBamlClient, startDevServer } from './lib/server'
import { conversationRows, wipeUserRows } from './lib/db'
import {
  APP_PORT,
  DATA_ENCRYPTION_KEY,
  HANDLES_FILE,
  POISONED_ANTHROPIC_KEY,
  TEST_DATABASE_URL,
  VERDA_SCALEDOWN_SECONDS,
} from './lib/env'

export default async function globalSetup(): Promise<() => Promise<void>> {
  // Shared with the unit suite and `app/e2e/` rather than reimplemented: the
  // three must agree on which database is the throwaway one.
  await provisionTestDatabase()

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
    // AVAILABLE, which is what the header switch's verda position needs — and
    // what makes it the default tier for a user who has never chosen.
    VERDA_INFERENCE_ENDPOINT: backend.llm.baseUrl,
    VERDA_INFERENCE_API_KEY: 'e2e-browser-fake-key',
    // See the constant: with the shipped 180s, the suite's own preflight turn
    // would leave the box "warm" for the whole run and the cold-start notice
    // could never fire again.
    VERDA_SCALEDOWN_SECONDS: String(VERDA_SCALEDOWN_SECONDS),
    // The Anthropic half, which has no such seam. See
    // `src/lib/inference/dev-fake-inference.server.ts`.
    E2E_FAKE_INFERENCE_URL: backend.llm.baseUrl,
    // Poisoned, so a redirect that failed to install fails LOUDLY (a 401)
    // instead of quietly billing a run advertised as hermetic.
    ANTHROPIC_API_KEY: POISONED_ANTHROPIC_KEY,
    // Never the process default: each scenario decides its tier the way the
    // header switch does, so a stray deployment default would mask a broken
    // preference read.
    USE_VERDA_INFERENCE: undefined,

    BAML_LOG: process.env.BAML_LOG ?? 'warn',
  })

  try {
    await wipeUserRows()
    await runPreflight(backend, server.url)
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
 *    row; it has to be visible in `kgagent_test`. If `app/.env` or a stray
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
