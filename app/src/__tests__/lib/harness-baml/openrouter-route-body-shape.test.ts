/**
 * The OpenRouter route for the 27B leaves — the route switch and the two
 * declared twins' body shapes.
 *
 * `self-deployed-body-shape.test.ts` pins the DEFAULT path (the declared
 * `LargeQwen` / `LargeQwenThink` clients, the box, the kwarg form). This file
 * pins the OTHER route, which that file cannot see:
 *
 *  - **The switch is explicit and never sniffs.** `LARGE_LLM_ROUTE=openrouter`
 *    is the one route authority; the base URL plays no part in the decision.
 *    Unset (or `modal`) is the byte-identical default; any other value refuses.
 *  - **The declared OR twins carry the NATIVE reasoning object.** Verified
 *    live against OpenRouter for `qwen/qwen3.8-27b`: `reasoning{enabled:false}`
 *    suppresses reasoning generation outright; `enabled:true` routes the trace
 *    to the separate field, leaving `content` as leading blank lines plus the
 *    answer envelope — which must parse through the twin functions' own parse
 *    path. The kwarg form (`chat_template_kwargs`) is accepted-but-NOT-honoured
 *    on OpenRouter, so it must appear NOWHERE in these bodies.
 *  - **`provider { zdr: true }` rides along**, the owner's recorded
 *    zero-retention choice for OpenRouter traffic, on the same
 *    verbatim-forwarding mechanism as every unrecognised option.
 *  - **The route is invisible to the reasoning setting.** One per-pattern
 *    setting (`PRIVATE_REASONING_ROLES`), provider-independent; the route only
 *    chooses WHICH twin the client seam names.
 *
 * Rendered offline via `b.request.*`: no socket is opened, so this runs in CI.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_LARGE_LLM_MODEL,
  applyLegacyInferenceEnv,
  assertLargeLlmRouteConfigured,
  largeLlmRoute,
  largeOnOpenRouter,
  LARGE_LLM_ROUTE_ENV,
} from '@hames-ai/harness-baml/inference-env.server'
import {
  clientOverrideFor,
  selfDeployedNonThinkingClientFor,
  THINKING_ROLES,
} from '@hames-ai/harness-baml/clients.server'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import { b } from '@hames-ai/harness-baml/baml_client'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const OPENROUTER_MODEL = 'qwen/qwen3.8-27b'
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'

type Body = Record<string, unknown>

/** The env bag shape the private tier's renders use; `env` merges over
 *  process.env per call, so each render below is isolated from the others. */
const OR_ENV = {
  LARGE_LLM_BASE_URL: OPENROUTER_BASE,
  LARGE_LLM_API_KEY: 'offline-render-test',
  LARGE_LLM_MODEL: OPENROUTER_MODEL,
}
const MODAL_ENV = {
  LARGE_LLM_BASE_URL: 'https://example.invalid/deployment/v1',
  LARGE_LLM_API_KEY: 'offline-render-test',
  LARGE_LLM_MODEL: DEFAULT_LARGE_LLM_MODEL,
}

afterEach(() => {
  delete process.env[LARGE_LLM_ROUTE_ENV]
  delete process.env.PRIVATE_REASONING_ROLES
})

describe('the route switch — explicit, never sniffed', () => {
  it('reads unset and modal as the modal route, and openrouter as OpenRouter', () => {
    expect(largeLlmRoute()).toBe('modal')
    expect(largeOnOpenRouter()).toBe(false)
    process.env[LARGE_LLM_ROUTE_ENV] = 'modal'
    expect(largeLlmRoute()).toBe('modal')
    process.env[LARGE_LLM_ROUTE_ENV] = 'openrouter'
    expect(largeLlmRoute()).toBe('openrouter')
    expect(largeOnOpenRouter()).toBe(true)
  })

  it('refuses an unknown route value instead of guessing', () => {
    // A typo'd route silently routing confidential traffic to the wrong kind
    // of endpoint is the one failure this var must never have.
    process.env[LARGE_LLM_ROUTE_ENV] = 'OpenRouter'
    expect(() => largeLlmRoute()).toThrow(/LARGE_LLM_ROUTE/)
    process.env[LARGE_LLM_ROUTE_ENV] = 'verda'
    expect(() => largeLlmRoute()).toThrow(/LARGE_LLM_ROUTE/)
  })

  it('the OpenRouter route requires an explicit model id at boot', () => {
    // The default id is the vLLM deployment's HF path; OpenRouter refuses it
    // on every call. Refuse at boot, not on the first turn. The explicitness
    // the assert reads is a BOOT-TIME fact — captured at the env seam's module
    // load — so this process (which booted without one) refuses until
    // normalization records a value it did not apply itself.
    process.env[LARGE_LLM_ROUTE_ENV] = 'openrouter'
    delete process.env.LARGE_LLM_MODEL
    expect(() => assertLargeLlmRouteConfigured()).toThrow(/LARGE_LLM_MODEL/)
    // An id set later and re-normalized counts as explicit: the env seam's
    // normalization records a value it did not apply itself.
    process.env.LARGE_LLM_MODEL = OPENROUTER_MODEL
    applyLegacyInferenceEnv()
    expect(() => assertLargeLlmRouteConfigured()).not.toThrow()
    delete process.env.LARGE_LLM_MODEL
    process.env[LARGE_LLM_ROUTE_ENV] = 'modal'
    expect(() => assertLargeLlmRouteConfigured()).not.toThrow()
  })

  it('the base URL plays no part in the route decision', () => {
    // The host the old eval switch sniffed on is now just an endpoint value.
    process.env.LARGE_LLM_BASE_URL = OPENROUTER_BASE
    process.env.LARGE_LLM_API_KEY = 'offline-render-test'
    expect(largeOnOpenRouter()).toBe(false)
    process.env[LARGE_LLM_ROUTE_ENV] = 'openrouter'
    expect(largeOnOpenRouter()).toBe(true)
  })
})

describe('the declared OR twins — body shapes', () => {
  it('LargeQwenOR carries the native reasoning object, zdr, and no kwarg', async () => {
    const req = await b.request.ScreenUntrustedContent(
      'web/fetch',
      'page text',
      '0123456789abcdef',
      {
        client: 'LargeQwenOR',
        env: OR_ENV,
      },
    )
    expect(req.url).toBe(`${OPENROUTER_BASE}/chat/completions`)
    const body = req.body.json() as Body
    expect(body.model).toBe(OPENROUTER_MODEL)
    expect(body.reasoning).toEqual({ enabled: false })
    expect(body.provider).toEqual({ zdr: true })
    expect(body.chat_template_kwargs).toBeUndefined()
    expect(body.max_tokens).toBe(4096)
    expect(body.temperature).toBe(0.2)
    expect(req.body.text()).not.toContain('cache_control')
  })

  it('LargeQwenThinkOR mirrors its box twin sampling, thinking on natively', async () => {
    const req = await b.request.ScreenUntrustedContent(
      'web/fetch',
      'page text',
      '0123456789abcdef',
      {
        client: 'LargeQwenThinkOR',
        env: OR_ENV,
      },
    )
    const body = req.body.json() as Body
    expect(body.model).toBe(OPENROUTER_MODEL)
    expect(body.reasoning).toEqual({ enabled: true })
    expect(body.provider).toEqual({ zdr: true })
    expect(body.chat_template_kwargs).toBeUndefined()
    expect(body.max_tokens).toBe(4096)
    expect(body).toMatchObject({
      temperature: 1,
      top_p: 0.95,
      top_k: 20,
      min_p: 0,
      presence_penalty: 0,
      repetition_penalty: 1,
    })
    expect(req.body.text()).not.toContain('cache_control')
  })

  it('differs from the box twin in exactly the reasoning and provider fields', async () => {
    // The OR twins mirror the declared clients' options; this comparison is
    // what keeps the copies honest. Same prompt, same arguments: the bodies
    // must be equal except `model` (the eval id), the reasoning REPRESENTATION
    // (native object vs template kwarg) and the provider block.
    const renderBox = () =>
      b.request.ScreenUntrustedContent('web/fetch', 'page text', '0123456789abcdef', {
        client: 'LargeQwen',
        env: MODAL_ENV,
      })
    const renderOR = () =>
      b.request.ScreenUntrustedContent('web/fetch', 'page text', '0123456789abcdef', {
        client: 'LargeQwenOR',
        env: OR_ENV,
      })
    const strip = (body: Body) => {
      const {
        model: _model,
        reasoning: _reasoning,
        provider: _provider,
        chat_template_kwargs: _kwarg,
        ...rest
      } = body
      return rest
    }
    expect(strip((await renderOR()).body.json() as Body)).toEqual(
      strip((await renderBox()).body.json() as Body),
    )
    const or = (await renderOR()).body.json() as Body
    const box = (await renderBox()).body.json() as Body
    // ...and not vacuously: the two really do differ in the intended fields.
    expect(or.reasoning).toEqual({ enabled: false })
    expect(box.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(or.provider).toEqual({ zdr: true })
    expect(box.provider).toBeUndefined()
  })

  it('resolves the model id from the env default when the var is unset', async () => {
    delete process.env.LARGE_LLM_MODEL
    applyLegacyInferenceEnv()
    const req = await b.request.ScreenUntrustedContent(
      'web/fetch',
      'page text',
      '0123456789abcdef',
      {
        client: 'LargeQwenOR',
        env: {
          LARGE_LLM_BASE_URL: OPENROUTER_BASE,
          LARGE_LLM_API_KEY: 'offline-render-test',
        },
      },
    )
    expect((req.body.json() as Body).model).toBe(DEFAULT_LARGE_LLM_MODEL)
  })

  it('the thinking-on content shape parses through the twin parse path', () => {
    // Verified live against OpenRouter: with reasoning enabled, `content` is a
    // leading blank-line pair followed by the envelope — the trace lives in
    // the separate field. The parse must take that shape untrimmed.
    const envelope = JSON.stringify({
      tool_name: 'search',
      tool_args: '{"query":"x"}',
      status: 'Searching',
      is_final: false,
    })
    expect(b.parse.ControllerThinking(`\n\n${envelope}`)).toEqual({
      tool_name: 'search',
      tool_args: '{"query":"x"}',
      additional_calls: null,
      status: 'Searching',
      is_final: false,
    })
    expect(b.parse.PlannerThinking('\n\n{"plan":"1. search","n_steps":1}')).toEqual({
      plan: '1. search',
      n_steps: 1,
    })
  })
})

describe('the route is invisible to the reasoning setting — the seam resolves twins', () => {
  it('modal route, setting unset: the byte-identical posture', async () => {
    await withRunFrame({ inference: { tier: 'self_deployed' } }, async () => {
      expect(clientOverrideFor('controller')).toEqual({ client: 'LargeQwen' })
      expect(clientOverrideFor('describe')).toEqual({ client: 'SmallQwen' })
    })
  })

  it('reasoning configured on the modal route names the box think twin', async () => {
    process.env.PRIVATE_REASONING_ROLES = 'controller'
    await withRunFrame({ inference: { tier: 'self_deployed' } }, async () => {
      expect(clientOverrideFor('controller')).toEqual({ client: 'LargeQwenThink' })
      expect(THINKING_ROLES().has('controller')).toBe(true)
      expect(selfDeployedNonThinkingClientFor('controller')).toBe('LargeQwen')
    })
  })

  it('reasoning configured on the OpenRouter route names the OR think twin', async () => {
    process.env[LARGE_LLM_ROUTE_ENV] = 'openrouter'
    process.env.PRIVATE_REASONING_ROLES = 'controller,critic,planner'
    await withRunFrame({ inference: { tier: 'self_deployed' } }, async () => {
      expect(clientOverrideFor('controller')).toEqual({ client: 'LargeQwenThinkOR' })
      expect(clientOverrideFor('critic')).toEqual({ client: 'LargeQwenThinkOR' })
      expect(clientOverrideFor('planner')).toEqual({ client: 'LargeQwenThinkOR' })
      // The small box and the decision transport have no route twins.
      expect(clientOverrideFor('describe')).toEqual({ client: 'SmallQwen' })
      expect(clientOverrideFor('decide')).toEqual({ client: 'PrivateSystemOne' })
    })
  })

  it('the OpenRouter route maps every 27B role onto its OR twin, thinking or not', async () => {
    process.env[LARGE_LLM_ROUTE_ENV] = 'openrouter'
    await withRunFrame({ inference: { tier: 'self_deployed' } }, async () => {
      for (const role of [
        'controller',
        'critic',
        'compactExecution',
        'router',
        'planner',
        'screen',
      ] as const) {
        expect(clientOverrideFor(role)?.client, role).toBe('LargeQwenOR')
      }
      expect(selfDeployedNonThinkingClientFor('planner')).toBe('LargeQwenOR')
      expect(selfDeployedNonThinkingClientFor('controller')).toBe('LargeQwenOR')
    })
  })

  it('refuses a pattern with no reasoning twin, and an unknown token', async () => {
    process.env.PRIVATE_REASONING_ROLES = 'actor'
    await withRunFrame({ inference: { tier: 'self_deployed' } }, async () => {
      expect(() => clientOverrideFor('controller')).toThrow(
        /reasoning enabled for pattern 'actor' but no reasoning twin exists/,
      )
    })
    process.env.PRIVATE_REASONING_ROLES = 'controller,banana'
    await withRunFrame({ inference: { tier: 'self_deployed' } }, async () => {
      expect(() => clientOverrideFor('controller')).toThrow(/unknown pattern 'banana'/)
    })
    // The module-load refusal — what a booting process hits — is the SAME
    // function called once at module scope, so a bad value fails the process
    // at boot. Pinned by source scan: the runner surfaces a module-level
    // throw outside the awaited import promise, so a live re-import would
    // assert the runner, not the refusal.
    const source = readFileSync(
      path.resolve(process.cwd(), '../packages/harness-baml/reasoning-roles.server.ts'),
      'utf8',
    )
    expect(source).toMatch(/^configuredReasoningPatterns\(\)$/m)
  })
})
