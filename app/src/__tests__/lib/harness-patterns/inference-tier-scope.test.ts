/**
 * The per-user inference-tier switch, at the seam it actually acts on.
 *
 * `clients-verda.test.ts` pins the process-wide flag. This pins what the header
 * control adds on top: a PER-RUN scope, and the guarantee that both of its
 * positions reach the right client override.
 *
 * The failures worth pinning, in the order they would ship:
 *   - a scope that widens OR narrows the role set. The switch must move exactly
 *     the roles `USE_VERDA_INFERENCE` moves, which after the two 2026-08-26
 *     owner decisions is all of them, `screen` included. That was the inverse
 *     until the second decision, and the reason the pin is per-role either way:
 *     a user-facing control is the easiest place for a security control's client
 *     to end up somewhere nobody decided (SA-M5). The two halves are now "the
 *     scope moves the screen too" and "the anthropic position moves it back".
 *   - the `'anthropic'` position failing to *undo* the deployment default. A
 *     user who opts out while `USE_VERDA_INFERENCE=1` must actually leave.
 *   - a scope leaking past its own callback, which would make one user's choice
 *     the next request's routing.
 *   - `'verda'` accepted while the endpoint is unset. The fall-through to
 *     Anthropic that would follow is the one failure this whole route exists to
 *     prevent, and it is no less dangerous for coming from a preference row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import type { BamlRole } from '@hames-ai/harness-baml/clients.server'

const ENV_KEYS = [
  'USE_VERDA_INFERENCE',
  'VERDA_INFERENCE_ENDPOINT',
  'VERDA_INFERENCE_API_KEY',
  // The private tier is TWO models since 2026-08-26 — `describe` runs on the 4B
  // `LocalQwenSmall`, reached through this — so it is part of the tier's
  // configuration and a scope naming `verda` without it is refused. The KEY is
  // saved/restored too, because one test deletes it to pin that it is NOT
  // required, and a leaked deletion would change another file's outcome.
  'SMALL_LLM_BASE_URL',
  'SMALL_LLM_API_KEY',
] as const

/** The roles the map routes — all of them, since 2026-08-26. `router` /
 *  `planner` / `describe` joined on the widening; `screen` on the owner's rule
 *  that no call made under the private tier may be sent to any public AI
 *  provider. */
const ROUTED: BamlRole[] = [
  'controller',
  'critic',
  'compactExecution',
  'router',
  'planner',
  'describe',
  'screen',
]
/** Nothing is held back. Kept as an empty list rather than deleted so a future
 *  exception is added in one place and asserted in both scope positions. */
const UNROUTED: [BamlRole, string][] = []

let saved: Record<string, string | undefined>

/** BOTH endpoints present and shaped correctly, flag NOT set — the preview's
 *  normal deployment posture once the per-user switch exists. */
function configureEndpointOnly(): void {
  process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/v1'
  process.env.VERDA_INFERENCE_API_KEY = 'test-key'
  process.env.SMALL_LLM_BASE_URL = 'https://example.invalid/small/v1'
}

/** What each routed role's client is under a `verda` scope. NOT one value any
 *  more: the tier is the 27B for the heavy roles and the 4B for summarization,
 *  and a test that asserted one client for all of them would pass with the
 *  describe flip reverted. */
const PRIVATE_CLIENT: Record<string, string> = {
  controller: 'VerdaQwen',
  critic: 'VerdaQwen',
  compactExecution: 'VerdaQwen',
  router: 'VerdaQwen',
  planner: 'VerdaQwen',
  describe: 'LocalQwenSmall',
  screen: 'VerdaQwen',
}

async function load() {
  vi.resetModules()
  // The composition root registers the seam (tier policy, model tables, cost
  // rates) and its defaultTier reads USE_VERDA_INFERENCE — the wiring every
  // production path takes.
  await import('../../../lib/inference/config.server')
  const clients = await import('@hames-ai/harness-baml/clients.server')
  const { withRunFrame, amendRunFrame, currentRunFrame } =
    await import('@hames-ai/harness-patterns/run-frame.server')
  // The tier is a SLOT of the run frame since #374, and the fail-closed
  // reachability check that used to guard the way into the scope is now
  // `assertInferenceTier` — called by the HOST before it puts a tier in a
  // frame, because core's frame is generic and cannot know what 'verda' means.
  // Bound together here so every assertion below reads as the one act a user's
  // stored preference still performs, and stays byte-identical.
  const runWithInferenceTier = async <T>(
    tier: 'verda' | 'anthropic',
    fn: () => Promise<T>,
  ): Promise<T> => {
    clients.assertInferenceTier(tier)
    // Open-or-amend, because one of the cases below nests a tier inside
    // another: a nested run ENTRY brings no slots, but scoping a tier below an
    // open run is `amendRunFrame`'s job and is exactly what this asserts.
    return currentRunFrame()
      ? amendRunFrame({ inference: { tier } }, fn)
      : withRunFrame({ inference: { tier } }, fn)
  }
  return { ...clients, runWithInferenceTier }
}

/** `verdaConfigured` moved to its own leaf (#225 Lane A2); this module is its
 *  home now, and the tests below pin the same four deployment postures
 *  against it. */
async function loadTierConfig() {
  vi.resetModules()
  return await import('../../../lib/inference/config.server')
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('runWithInferenceTier — both positions reach the right override', () => {
  beforeEach(configureEndpointOnly)

  it('the verda position routes exactly the mapped roles', async () => {
    const { runWithInferenceTier, clientOverrideFor, resolveClientForRole } = await load()

    await runWithInferenceTier('verda', async () => {
      for (const role of ROUTED) {
        expect(clientOverrideFor(role)).toEqual({ client: PRIVATE_CLIENT[role] })
        expect(resolveClientForRole(role)).toBe(PRIVATE_CLIENT[role])
      }
      // Not vacuous, and this is the line that makes the loop above mean
      // something: the tier really does route two DIFFERENT clients, so a
      // fixture collapsed back to one value would be caught here.
      expect(new Set(Object.values(PRIVATE_CLIENT)).size).toBe(2)
    })
  })

  it('the verda position moves the injection screen too, and holds nothing back', async () => {
    const { runWithInferenceTier, clientOverrideFor, resolveClientForRole } = await load()

    await runWithInferenceTier('verda', async () => {
      for (const [role, chain] of UNROUTED) {
        expect(clientOverrideFor(role)).toBeUndefined()
        expect(resolveClientForRole(role)).toBe(chain)
      }
      // SA-M5, stated separately because it is the one role whose client is a
      // security decision rather than a routing preference. It used to be
      // asserted as `DescribeAnthropic` here; the owner moved it on 2026-08-26
      // and a user-facing control is exactly where that has to be visible, in
      // both directions, rather than inferred from the map.
      expect(clientOverrideFor('screen')).toEqual({ client: 'VerdaQwen' })
      expect(resolveClientForRole('screen')).toBe('VerdaQwen')
      // AND ITS NEIGHBOUR ON THE SAME BAML CHAIN GOES SOMEWHERE ELSE. `describe`
      // and `screen` both declare `DescribeAnthropic` in `baml_src/`, so a chain
      // edit could only ever move them together; the tier map moves them apart,
      // which is the whole reason `screen` is a role of its own (SA-M5 / SD-4).
      // Asserted as an inequality as well as two values, because "the screen
      // stayed off the 4B" is the property, not "the screen is on VerdaQwen".
      expect(resolveClientForRole('describe')).toBe('LocalQwenSmall')
      expect(resolveClientForRole('screen')).not.toBe(resolveClientForRole('describe'))
    })
  })

  it('the anthropic position adds no override at all', async () => {
    const { runWithInferenceTier, clientOverrideFor } = await load()

    await runWithInferenceTier('anthropic', async () => {
      for (const role of [...ROUTED, ...UNROUTED.map(([r]) => r)]) {
        expect(clientOverrideFor(role)).toBeUndefined()
      }
    })
  })

  it('the anthropic position UNDOES the deployment default', async () => {
    // A user opting out while the process default is Verda is the whole point
    // of the control. A scope that could only widen would silently ignore them.
    process.env.USE_VERDA_INFERENCE = '1'
    const { runWithInferenceTier, clientOverrideFor, activeInferenceTier } = await load()

    expect(activeInferenceTier()).toBe('verda')
    expect(clientOverrideFor('controller')).toEqual({ client: 'VerdaQwen' })

    await runWithInferenceTier('anthropic', async () => {
      expect(activeInferenceTier()).toBe('anthropic')
      expect(clientOverrideFor('controller')).toBeUndefined()
    })
  })

  it('trims a scoped Verda run against the 131K server window', async () => {
    const { runWithInferenceTier, resolveClientForRole } = await load()
    const { getContextWindow } = await import('@hames-ai/harness-baml/clients.server')

    await runWithInferenceTier('verda', async () => {
      expect(getContextWindow(resolveClientForRole('controller'))).toBe(131_072)
      // …but NOT the describe role, which is the point of the flip: it runs on
      // the 4B, whose server was started with `--ctx-size 32768`. Budgeting
      // follows routing because `resolveClientForRole` reports the override — a
      // describe batch still sized for 131K would overflow the summarizer on the
      // first busy turn, which is the mirror's whole job (`compactBulkData`'s
      // batches and the retriever's history trim both read this).
      expect(getContextWindow(resolveClientForRole('describe'))).toBe(32_768)
      // …and the screen, which moved on 2026-08-26. This is the half of that
      // move easiest to forget: the guard hands the screen up to 20 000
      // characters of fetched content, so a screen still budgeted for 200K
      // against a 131K server would be the switch working and the control
      // failing on exactly the payload it exists to read.
      expect(getContextWindow(resolveClientForRole('screen'))).toBe(131_072)
    })
  })
})

describe('scope isolation — one user’s choice is not another’s routing', () => {
  beforeEach(configureEndpointOnly)

  it('does not leak past its own callback', async () => {
    const { runWithInferenceTier, clientOverrideFor } = await load()

    await runWithInferenceTier('verda', async () => {
      expect(clientOverrideFor('controller')).toEqual({ client: 'VerdaQwen' })
    })
    expect(clientOverrideFor('controller')).toBeUndefined()
  })

  it('keeps concurrent runs on their own tier', async () => {
    // Two turns interleaved in one process is the ordinary case for a preview
    // with more than one user; an AsyncLocalStorage that lost its store across
    // an await would cross them.
    const { runWithInferenceTier, clientOverrideFor } = await load()
    const seen: Record<string, unknown> = {}

    await Promise.all([
      runWithInferenceTier('verda', async () => {
        await new Promise((r) => setTimeout(r, 5))
        seen.verda = clientOverrideFor('controller')
      }),
      runWithInferenceTier('anthropic', async () => {
        await new Promise((r) => setTimeout(r, 1))
        seen.anthropic = clientOverrideFor('controller')
      }),
    ])

    expect(seen.verda).toEqual({ client: 'VerdaQwen' })
    expect(seen.anthropic).toBeUndefined()
  })

  it('restores the outer tier after a nested scope', async () => {
    const { runWithInferenceTier, activeInferenceTier } = await load()

    await runWithInferenceTier('verda', async () => {
      await runWithInferenceTier('anthropic', async () => {
        expect(activeInferenceTier()).toBe('anthropic')
      })
      expect(activeInferenceTier()).toBe('verda')
    })
  })
})

describe('the verda position fails closed when the endpoint is unset', () => {
  it('throws instead of opening a scope that would fall through to Anthropic', async () => {
    const { runWithInferenceTier } = await load()
    const ran = vi.fn()

    await expect(runWithInferenceTier('verda', async () => ran())).rejects.toThrow(
      /VERDA_INFERENCE_ENDPOINT and VERDA_INFERENCE_API_KEY/,
    )
    // The callback must not have run at all: the check is before any prompt is
    // built, not after the first call 404s.
    expect(ran).not.toHaveBeenCalled()
  })

  it('rejects a root URL the same way the flag does', async () => {
    process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/'
    process.env.VERDA_INFERENCE_API_KEY = 'test-key'
    const { runWithInferenceTier } = await load()

    await expect(runWithInferenceTier('verda', async () => 1)).rejects.toThrow(
      /must be the OpenAI-compatible base URL/,
    )
  })

  it('throws, rather than descaling describe, when the 4B endpoint is unset', async () => {
    // THE FAILURE POLICY, named (SD-4's "an unexamined one is the defect"). The
    // private tier routes `describe` to LocalQwenSmall; with no
    // SMALL_LLM_BASE_URL there are three options and only one is honest:
    //   - fall back to Anthropic — the one thing the whole route exists to
    //     prevent, and worse here than anywhere because `describe` is handed tool
    //     results VERBATIM (SD-10);
    //   - descale to the 27B — plausible, harmless-looking, and a routing change
    //     nobody asked for, invisible in every log, moving the tier's
    //     highest-frequency role onto the model the flip moved it off;
    //   - refuse the tier. Owner decision 2026-08-26, and this is the pin.
    // Asserted through the SCOPE rather than through the assert function
    // directly, because the scope is what a user's stored preference opens.
    process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/v1'
    process.env.VERDA_INFERENCE_API_KEY = 'test-key'
    const { runWithInferenceTier } = await load()
    const ran = vi.fn()

    await expect(runWithInferenceTier('verda', async () => ran())).rejects.toThrow(
      /SMALL_LLM_BASE_URL is not set/,
    )
    expect(ran).not.toHaveBeenCalled()
  })

  it('rejects a 4B endpoint that is not a /v1 base', async () => {
    // Same reason as the 27B's: BAML hands `base_url` to openai-generic
    // verbatim, so a root URL 404s every describe call mid-conversation.
    configureEndpointOnly()
    process.env.SMALL_LLM_BASE_URL = 'https://example.invalid/small'
    const { runWithInferenceTier } = await load()

    await expect(runWithInferenceTier('verda', async () => 1)).rejects.toThrow(
      /SMALL_LLM_BASE_URL must be the OpenAI-compatible base URL/,
    )
  })

  it('does NOT require the 4B api key — llama-server authenticates nothing', async () => {
    // A local `make llm-small` has no key to set. Refusing the tier for a
    // missing one would refuse it for the common case, and a remote endpoint
    // that checks a key fails loudly on its own with a 401.
    configureEndpointOnly()
    delete process.env.SMALL_LLM_API_KEY
    const { runWithInferenceTier, resolveClientForRole } = await load()

    await expect(
      runWithInferenceTier('verda', async () => resolveClientForRole('describe')),
    ).resolves.toBe('LocalQwenSmall')
  })

  it('never blocks the anthropic position — it needs no endpoint', async () => {
    const { runWithInferenceTier, clientOverrideFor } = await load()

    await expect(
      runWithInferenceTier('anthropic', async () => clientOverrideFor('controller')),
    ).resolves.toBeUndefined()
  })
})

describe('verdaConfigured — the non-throwing sibling', () => {
  it('is false with nothing set, and does not throw', async () => {
    const { verdaConfigured } = await loadTierConfig()
    expect(verdaConfigured()).toBe(false)
  })

  it('is true once BOTH endpoints are present and shaped as /v1 bases', async () => {
    configureEndpointOnly()
    const { verdaConfigured } = await loadTierConfig()
    expect(verdaConfigured()).toBe(true)
  })

  it('is false with the 27B configured and the 4B missing', async () => {
    // What this controls is user-visible: `verdaConfigured()` is what disables
    // the switch's private position and what `defaultInferenceTier()`
    // reads. A half-configured deployment must not OFFER a tier whose first
    // tool-result summary would fail — offering it and failing per turn is
    // strictly worse than showing one disabled control.
    process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/v1'
    process.env.VERDA_INFERENCE_API_KEY = 'test-key'
    const { verdaConfigured } = await loadTierConfig()
    expect(verdaConfigured()).toBe(false)
  })

  it('is false for a root URL — offering a tier that throws is worse than hiding it', async () => {
    process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/'
    process.env.VERDA_INFERENCE_API_KEY = 'test-key'
    const { verdaConfigured } = await loadTierConfig()
    expect(verdaConfigured()).toBe(false)
  })
})

describe('activeInferenceTier — what runs outside any scope', () => {
  it('is anthropic with no flag, even when the endpoint is configured', async () => {
    // The endpoint being reachable is what makes the tier OFFERABLE to a user;
    // it is deliberately not what re-points background work that has no user.
    configureEndpointOnly()
    const { activeInferenceTier } = await load()
    expect(activeInferenceTier()).toBe('anthropic')
  })

  it('follows USE_VERDA_INFERENCE when it is set', async () => {
    configureEndpointOnly()
    process.env.USE_VERDA_INFERENCE = '1'
    const { activeInferenceTier } = await load()
    expect(activeInferenceTier()).toBe('verda')
  })
})

// ============================================================================
// The RUN FRAME's `inference` slot (#374) — the fifth slot's reader.
//
// The other four slots' "reads the frame, not a module global" pins live in
// `packages/harness-patterns/__tests__/run-frame.test.ts`. This one cannot: its
// reader is in `@hames-ai/harness-baml`, which core must not import (the
// dependency arrow runs the other way, and that package has no test host of its
// own). So it lives here, beside the rest of that module's suite.
// ============================================================================

describe("the run frame's inference slot — the reader reads the frame", () => {
  it('the frame beats the module-level tier policy', async () => {
    // Mutation: restore `tierStore.getStore() ?? tierPolicy.defaultTier()` — a
    // store of this module's own, which is what the frame replaced — and the
    // frame's tier becomes invisible: `activeInferenceTier()` answers
    // 'anthropic' inside the frame and this goes red.
    configureEndpointOnly()
    const clients = await load()
    const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')

    // The module global — the decoy this reader must not prefer.
    expect(clients.activeInferenceTier()).toBe('anthropic')

    const inside = await withRunFrame({ inference: { tier: 'verda' } }, async () =>
      clients.activeInferenceTier(),
    )
    expect(inside).toBe('verda')
    // And the frame closed behind itself.
    expect(clients.activeInferenceTier()).toBe('anthropic')
  })

  it('an unrecognised tier string falls back to the default rather than routing blind', async () => {
    // Core carries the tier as an OPAQUE STRING — it cannot know what 'verda'
    // means — so the narrowing happens here, and a host that writes a typo into
    // the slot gets the safe tier rather than an unrouted one.
    configureEndpointOnly()
    const clients = await load()
    const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')

    const seen = await withRunFrame({ inference: { tier: 'verdaa' } }, async () => ({
      tier: clients.activeInferenceTier(),
      override: clients.clientOverrideFor('controller'),
    }))
    expect(seen.tier).toBe('anthropic')
    expect(seen.override).toBeUndefined()
  })

  it('a per-run clientOverride is keyed by ROLE, so mapping describe never moves screen', async () => {
    // SA-M5 / SD-4, for the PER-RUN layer. #380 pinned exactly this for its
    // module-level twin (`consumer-clients.test.ts`); the frame layer had no
    // such pin, and "it cannot happen by construction" is the claim that pin
    // exists to keep true. A consumer re-pointing summarization at a cheap
    // model must not carry prompt-injection screening along with it — the
    // accident the two roles were separated to prevent, and the one that is
    // live for anyone who edits the shared BAML chain instead.
    //
    // MUTATION: key the override on anything but the role (e.g. return the same
    // bag unconditionally) → the screen moves and the second assertion reddens.
    configureEndpointOnly()
    const clients = await load()
    const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')

    const describeOnly = (role: string) =>
      role === 'describe' ? { client: 'SomeCheapModel' } : undefined

    const seen = await withRunFrame(
      { inference: { tier: 'verda', clientOverride: describeOnly } },
      async () => ({
        describe: clients.clientOverrideFor('describe'),
        screen: clients.clientOverrideFor('screen'),
      }),
    )

    expect(seen.describe).toEqual({ client: 'SomeCheapModel' })
    // The screen stayed on the tier's own client — it did not follow.
    expect(seen.screen).toEqual({ client: 'VerdaQwen' })
  })

  it("a per-run clientOverride in the generic slot pre-empts this package's tier map", async () => {
    // D1's "bring your own provider or model": the slot is generic and the
    // consumer's own client layer wins. Mutation: drop the `supplied` branch at
    // the top of `clientOverrideFor` and the tier map answers instead.
    configureEndpointOnly()
    const clients = await load()
    const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')

    const picked = await withRunFrame(
      { inference: { tier: 'verda', clientOverride: () => ({ client: 'ConsumerModel' }) } },
      async () => clients.clientOverrideFor('controller'),
    )
    expect(picked).toEqual({ client: 'ConsumerModel' })

    // Without the override the same frame takes the tier map — so the assertion
    // above is about precedence, not about an empty map.
    const mapped = await withRunFrame({ inference: { tier: 'verda' } }, async () =>
      clients.clientOverrideFor('controller'),
    )
    expect(mapped).toEqual({ client: 'VerdaQwen' })
  })
})
