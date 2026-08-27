/**
 * The two modes, and every knob that distinguishes them.
 *
 * HERMETIC is the default and the one anybody can run: no credential, no
 * network, no bill. Both the inference endpoint and the MCP gateway are fakes
 * started in-process, and the only real infrastructure is the throwaway
 * Postgres this suite provisions for itself (`kgagent_test_apppath` — its own since
 * #280; see `docs/testing/pyramid.md`).
 *
 * LIVE (`E2E_LIVE=verda`) points the same scenarios at the real self-hosted
 * deployment. It is a pre-release check, not a routine one: the endpoint scales
 * to zero and pays a multi-minute cold start, so the run is burst-disciplined
 * — one process, one file at a time, at most two turns in flight (the
 * deployment is a single replica, where concurrency is queueing rather than
 * scaling; measured 2026-08-25 by `smoke-verda-load.ts`) — and the
 * fault-injection scenarios, which have no live analogue that is safe to
 * cause, are skipped rather than faked.
 *
 * There is deliberately no third mode. A "live Anthropic" mode would mean
 * running the whole suite against a metered API, which is the line
 * `app/evals/README.md` draws for the eval runner and this suite has no reason
 * to cross.
 *
 * WHAT LIVE MODE STILL BILLS, stated rather than implied. `E2E_LIVE=verda` was
 * never "no Anthropic calls", and after the 2026-08-26 owner decisions it is:
 * the tier switch moves exactly the roles in `VERDA_CLIENT_BY_ROLE`, which is
 * now EVERY role — the injection screen included. So a live run in the
 * self-hosted position bills Anthropic nothing at all. That is a smaller claim
 * than it sounds, because no scenario here triggers a screen call anyway (no
 * agent enables the opt-in LLM screen).
 *
 * WHERE THE TRAFFIC GOES changed again with the describe flip, and it went the
 * helpful way: `router`, `planner` and the controller land on the self-hosted
 * box, while every describe call — the title, the intent compaction, and one per
 * tool result, i.e. the majority by count — lands on `SMALL_LLM_BASE_URL`
 * instead. A live run therefore puts LESS through the single-replica deployment
 * than the pre-flip shape did, though the burst discipline above still holds:
 * the calls that remain are the slow ones.
 *
 * What is still avoidable is running each scenario a second time with the
 * switch in the anthropic position, which would put every one of those roles
 * on the metered API and roughly double the bill for no live-route
 * information. So the per-tier legs collapse to the self-hosted tier in live
 * mode — see {@link TIERS}, which is the single definition all three
 * multi-tier scenarios read.
 */

export type E2eMode = 'hermetic' | 'live-verda'

/** `E2E_LIVE=verda` opts into the real endpoint. Anything else is hermetic. */
export function resolveMode(): E2eMode {
  const raw = process.env.E2E_LIVE?.trim().toLowerCase()
  if (!raw || raw === '0' || raw === 'false') return 'hermetic'
  if (raw === 'verda') return 'live-verda'
  throw new Error(
    `E2E_LIVE=${raw} is not a mode. Use E2E_LIVE=verda for the self-hosted endpoint, or ` +
      'unset it for the hermetic run.',
  )
}

export const MODE: E2eMode = resolveMode()
export const IS_HERMETIC = MODE === 'hermetic'
export const IS_LIVE = MODE === 'live-verda'

/** The two positions of the header switch. */
export type Tier = 'anthropic' | 'verda'

/**
 * The tiers a multi-tier scenario runs its legs over — one definition, read by
 * scenarios 1, 2 and 7 rather than each spelling out its own pair.
 *
 * Hermetic runs both: the anthropic leg costs nothing there and it is the only
 * way to tell "the app works" from "the app works on one route". Live mode runs
 * the self-hosted tier only, for the billing reason in the header.
 */
export const TIERS: readonly Tier[] = IS_HERMETIC ? ['anthropic', 'verda'] : ['verda']

/**
 * The `api_key` the hermetic run puts in `ANTHROPIC_API_KEY`.
 *
 * FAIL-CLOSED, and the reason is the whole design of `baml-route.ts`: the
 * anthropic tier is re-pointed by a test-only client registry rather than by an
 * env var, and a registry that silently failed to install would leave every
 * anthropic-tier call going to the real provider with the developer's own key —
 * billing a "hermetic" suite and sending it prompts. Overwriting the key means
 * the worst case is a loud 401 instead. `assertHermeticRouting()` is the belt;
 * this is the braces.
 */
export const HERMETIC_ANTHROPIC_KEY = 'e2e-hermetic-no-real-anthropic-calls'

/** The model id the fake anthropic-tier client reports. Scenarios read it back
 *  off the fake's recorded calls to tell the two tiers apart. */
export const FAKE_ANTHROPIC_TIER_MODEL = 'e2e-fake-anthropic-tier'

/** The model id `VerdaQwen` declares in `baml_src/verda-client.baml`. Not
 *  re-derived here on purpose: a scenario asserting "this call took the
 *  self-hosted route" should fail if the declaration changes under it. */
export const VERDA_MODEL = 'Qwen/Qwen3.8-27B-FP8'

/**
 * The model id `LocalQwenSmall` declares in `baml_src/local-client.baml` — the
 * 4B the private tier routes the `describe` role to since 2026-08-26.
 *
 * Hardcoded for VERDA_MODEL's reason, and it buys something extra here: the fake
 * records each request's `model` field, so this is how a scenario tells a
 * private-tier SUMMARY apart from a private-tier CONTROLLER call. Before the flip
 * those were the same model and indistinguishable on the wire.
 */
export const SMALL_MODEL = 'qwen3.5-4b-instruct'

/**
 * How long the slow-response scenarios withhold a response.
 *
 * 90s because it already exceeds every default HTTP timeout in the stack that is
 * NOT deliberately sized for a slow model call, which is what those scenarios
 * are there to find.
 *
 * IT HAS A CEILING NOW, and it is 180s — `VerdaQwen`'s `request_timeout_ms`.
 * Since wake-then-run the cold start is paid by the wake poll (bounded
 * separately, at `VERDA_WAKE_TIMEOUT_MS` = 600s overall) and scenario 4 aims its
 * delay PAST the wake, at a real BAML call. So a value at or above 180 000 no longer
 * asks "does the stack survive a slow call" — it asks the client to break its
 * own budget, and scenario 4 would go red for the one reason that is not a
 * finding. The old advice here was `E2E_COLD_START_MS=180000` for a
 * pre-release run; that number is now exactly the wrong one.
 */
export const COLD_START_MS = Number.parseInt(process.env.E2E_COLD_START_MS ?? '90000', 10)

/**
 * What the hermetic run sets `VERDA_WAKE_ATTEMPT_TIMEOUT_MS` to.
 *
 * The wake became a POLL on 2026-08-27 — short attempts, retried until one
 * answers — because the live platform was observed ABANDONING every request
 * that arrived while the container was starting. The fake endpoint does not do
 * that: a `cold-start` fault withholds a response and then answers it, i.e. the
 * fake is a pure queue-and-answer deployment. Under the shipped 30s attempt
 * bound the poll would abandon the fake's 90s delay at second 30 and the next
 * attempt (the fault spent) would answer instantly — so scenario 8 would stop
 * observing a 90s wait, scenario 4's `wake: false` filter would be doing work
 * the timeout had already done, and both would be measuring the poll's cadence
 * rather than the budget each was written for.
 *
 * So the hermetic attempt bound is set ABOVE the injected delay, which makes the
 * fake's one-shot behaviour and the poll's first attempt line up: one attempt,
 * one wait, exactly the shape those scenarios assert. The poll's RETRY behaviour
 * is not configured away — it has fake-timer unit coverage in
 * `verda-wake.test.ts`, and scenario 8's "keeps polling until the box answers"
 * lowers this var itself for the one test that is about it.
 *
 * Derived from {@link COLD_START_MS} rather than fixed, so raising
 * `E2E_COLD_START_MS` cannot silently push the delay past the attempt bound.
 */
export const WAKE_ATTEMPT_TIMEOUT_MS = COLD_START_MS + 30_000

/** Per-turn timeout. Generous in both modes: the cold-start scenario is the
 *  point of the suite, so a turn budget tighter than the cold start would
 *  make the harness the thing that failed. */
export const TURN_TIMEOUT_MS = Number.parseInt(
  process.env.E2E_TURN_TIMEOUT_MS ?? String(Math.max(COLD_START_MS + 120_000, 300_000)),
  10,
)
