/**
 * Every constant the browser layer's two processes have to agree on.
 *
 * There are two of them, which is the whole reason this file exists. The fakes
 * and the app run in DIFFERENT processes here — the app behind a real dev
 * server, the fakes beside the Playwright runner — so nothing can be shared by
 * importing a live object the way `app/e2e/` shares `bootApp()`. What crosses
 * the boundary is env vars and one HTTP control plane, and both ends have to
 * name the same things.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** `app/` — the working directory the dev server is spawned in. */
export const APP_DIR = fileURLToPath(new URL('../..', import.meta.url))

/** `app/e2e-browser/` */
export const SUITE_DIR = path.join(APP_DIR, 'e2e-browser')

/**
 * Where global setup parks the handles workers need (the control-plane URL,
 * the app's base URL).
 *
 * A file rather than `process.env`: Playwright forks workers, and while an env
 * var set in global setup does reach them, a file is what makes a failed setup
 * legible — a missing handle names itself instead of surfacing as a worker
 * connecting to `undefined`. Gitignored; written on every run.
 */
export const HANDLES_FILE = path.join(SUITE_DIR, '.runtime', 'handles.json')

/**
 * The dev server's port. NOT 3444: a developer's own `pnpm dev` is very often
 * up while this suite runs, and a suite that silently drove THAT server would
 * be driving a process pointed at the dev database with real credentials.
 */
export const APP_PORT = Number.parseInt(process.env.E2E_BROWSER_PORT ?? '3446', 10)

export const APP_URL = `http://127.0.0.1:${APP_PORT}`

/**
 * This suite's OWN throwaway database.
 *
 * It was `kgagent_test`, shared with the unit suite and `app/e2e/`, until #280.
 * Sharing was survivable while nothing ran concurrently and became a source of
 * false reds the moment something did: all three drive real turns, two of them
 * wipe "their" rows by dev-bypass user id, and the id was one literal — so a
 * concurrent app-path run deleted this suite's conversations mid-scenario and the
 * failure named a scenario rather than the collision. That is exactly what
 * happened during #277's fix round.
 *
 * `provisionDatabase` (`src/__tests__/global-setup.ts`) creates it on demand, so
 * separating cost one `CREATE DATABASE` on a first run. The code is still shared;
 * only the target is not. {@link BYPASS_USER_ID} is the second, independent
 * separation — see it for why both exist.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:password@localhost:5432/kgagent_test_browser'

/** The same key the unit suite and `app/e2e/` use. The databases are separate
 *  now, so this is no longer forced — but a second key would be a second thing
 *  to know when reading a row by hand, and nothing here tests key handling. */
export const DATA_ENCRYPTION_KEY = 'unit-test-data-encryption-key'

/**
 * The `api_key` the dev server is given for Anthropic.
 *
 * FAIL-CLOSED, same reasoning as `e2e/lib/mode.ts`: the redirect that keeps
 * this suite hermetic is installed inside the server process
 * (`dev-fake-inference.server.ts`), and a redirect that silently failed to
 * install would leave every un-overridden call going to the real provider with
 * the developer's own key. Poisoning the key means the worst case is a loud 401
 * instead of a bill. `assertHermetic()` in `backend.ts` is the belt; this is
 * the braces.
 */
export const POISONED_ANTHROPIC_KEY = 'e2e-browser-no-real-anthropic-calls'

/** The `model` the redirected Anthropic-chain calls report. Mirrors
 *  `DEV_FAKE_MODEL` in `src/lib/inference/dev-fake-inference.server.ts`; the
 *  browser suite reads it off the fake to tell the two tiers apart. */
export const FAKE_ANTHROPIC_TIER_MODEL = 'e2e-fake-anthropic-tier'

/** The model id `VerdaQwen` declares in `baml_src/verda-client.baml`. Not
 *  re-derived: a scenario asserting "this call took the self-hosted route"
 *  should fail if the declaration changes under it. */
export const VERDA_MODEL = 'Qwen/Qwen3.8-27B-FP8'

/**
 * The dev-bypass user every turn in THIS suite runs as.
 *
 * Handed to the dev server as `VITE_DEV_BYPASS_USER_ID`, which
 * `src/lib/auth/dev-bypass.ts` reads through `import.meta.env` — so one value
 * moves both halves of the app, the browser bundle's `AuthProvider` and the
 * server's turn path.
 *
 * Distinct from the other suites' (#280) as DEFENCE IN DEPTH rather than as the
 * fix: {@link TEST_DATABASE_URL} is what actually keeps the suites apart, and
 * this is what keeps them apart anyway when someone deliberately points two of
 * them at one database to reproduce a cross-suite bug. `wipeUserRows()` deletes
 * by this id, so getting it wrong is how one suite comes to delete another's
 * rows.
 */
export const BYPASS_USER_ID = 'e2e-browser-user'

/** The answer `fake-llm.ts` puts in every synthesized reply. A scenario
 *  asserting on it is asserting the reply came from the fake. */
export const FAKE_ANSWER_MARK = 'E2E-FAKE-ANSWER'

/** The title `GenerateConversationTitle` answers with, i.e. the sidebar row's
 *  accessible name once the first turn's title lands. */
export const FAKE_TITLE = 'E2E Fake Conversation'

/** The cold-start notice's headline (`src/lib/cold-start-format.ts`). Imported
 *  rather than restated wherever a scenario can; kept here for the one place
 *  that needs it before any app module is reachable. */
export const COLD_START_HEADLINE = 'starting GPU'

/**
 * `VERDA_SCALEDOWN_SECONDS` for the dev server under test.
 *
 * Two seconds instead of the shipped default (300 since 2026-08-26, when the
 * owner set it to match the live box; it was 180 when this suite was written,
 * and the exact figure has never been what matters here). This is not a
 * shortcut around the feature — it is the only way to REACH it more than once.
 * The cold-start notice fires when nothing says the box is up, and a completed
 * self-hosted call marks it warm for the whole scale-down window
 * (`inference/verda-activity.server.ts`). The suite's own preflight turn makes
 * such a call, so with the shipped value every later scenario would run against
 * a box this process believes is warm, and the notice would never fire — the
 * first draft of scenario 2 failed exactly that way.
 *
 * It is an operator-facing env var the app already reads per call, clamped and
 * warned about on garbage, so setting it is configuration rather than a test
 * hook. What it costs: this suite cannot say anything about the shipped window
 * itself, only about what happens on either side of it.
 */
export const VERDA_SCALEDOWN_SECONDS = 2

/** How long to wait for the app to consider the self-hosted box cold again:
 *  the configured scale-down window, plus a margin for the clock. */
export const GO_COLD_MS = VERDA_SCALEDOWN_SECONDS * 1000 + 750

/**
 * How long scenario 2's fake box withholds its first self-hosted answer.
 *
 * Short by the standards of `app/e2e` (which sits through 90s to prove no
 * timeout in the stack fires). This layer's claim is different and does not
 * need duration: it is that the SPINNER APPEARS ON SCREEN and then CLEARS.
 * Eight seconds is comfortably longer than the bar's 350 ms mount delay and
 * than any assertion's wait, and keeps the suite's wall clock honest.
 */
export const COLD_START_MS = Number.parseInt(process.env.E2E_BROWSER_COLD_MS ?? '8000', 10)

/** How long a scenario waits for a whole turn to land in the transcript. */
export const TURN_TIMEOUT_MS = Number.parseInt(
  process.env.E2E_BROWSER_TURN_TIMEOUT_MS ?? '90000',
  10,
)

/** How long global setup waits for the dev server to answer `/api/health`.
 *  A cold vite dev start with `baml-generate` behind it is not fast. */
export const SERVER_BOOT_TIMEOUT_MS = Number.parseInt(
  process.env.E2E_BROWSER_BOOT_TIMEOUT_MS ?? '180000',
  10,
)
