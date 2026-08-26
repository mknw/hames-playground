/**
 * The two modes, and every knob that distinguishes them.
 *
 * HERMETIC is the default and the one anybody can run: no credential, no
 * network, no bill. Both the inference endpoint and the MCP gateway are fakes
 * started in-process, and the only real infrastructure is the throwaway
 * Postgres the unit suite already provisions (`kgagent_test`).
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
 * never "no Anthropic calls", and after the two 2026-08-26 owner decisions it
 * is: the tier switch moves exactly the roles in `VERDA_CLIENT_BY_ROLE`, which
 * is now EVERY role — the injection screen included. So a live run in the
 * self-hosted position bills Anthropic nothing at all. That is a smaller claim
 * than it sounds, because no scenario here triggers a screen call anyway (no
 * agent enables the opt-in LLM screen), and the bill moved rather than shrank:
 * `router`, `planner`, the title and every describe call now land on the
 * self-hosted box, which is more traffic through a single-replica deployment
 * than the pre-widening shape, and the reason the burst discipline above
 * matters more than it did.
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
 * How long the cold-start scenario withholds the first response.
 *
 * The brief asks for minutes. 90s is the default because it already exceeds
 * every default HTTP timeout in the stack that is NOT the one deliberately
 * sized for a cold start, which is what the scenario is there to find; raise it
 * with `E2E_COLD_START_MS=180000` for the full pre-release shape.
 */
export const COLD_START_MS = Number.parseInt(process.env.E2E_COLD_START_MS ?? '90000', 10)

/** Per-turn timeout. Generous in both modes: the cold-start scenario is the
 *  point of the suite, so a turn budget tighter than the cold start would
 *  make the harness the thing that failed. */
export const TURN_TIMEOUT_MS = Number.parseInt(
  process.env.E2E_TURN_TIMEOUT_MS ?? String(Math.max(COLD_START_MS + 120_000, 300_000)),
  10,
)
