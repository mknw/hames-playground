/**
 * The eval-only OpenRouter route for the 27B leaves — the two body shapes.
 *
 * `self-deployed-body-shape.test.ts` pins the DEFAULT path (the declared
 * `LargeQwen` client, the box, the pinned literal). This file pins the SWITCH
 * around it, which is the one thing that file cannot see:
 *
 *  - **Vars unset ⇒ byte-identical.** With `LARGE_LLM_*` unset the boot
 *    normalization applies the default model id and NO consumer layer
 *    composes: the rendered body is exactly the declared client's — no
 *    `provider` key, nothing new forwarded.
 *  - **Vars set ⇒ the OpenRouter shape.** With `LARGE_LLM_BASE_URL` on an
 *    OpenRouter host and `LARGE_LLM_MODEL` set, the eval's consumer layer
 *    routes every 27B role through the registry client: the model id comes
 *    from the env, `provider: { zdr: true }` rides the same verbatim
 *    forwarding `chat_template_kwargs` does — and EVERY OTHER FIELD is pinned
 *    equal to the default render, which is what keeps the registry's mirrored
 *    options from drifting away from the declared client.
 *
 * Rendered offline via `b.request.*`: no socket is opened, so this runs in CI.
 * The routing half (`clientOverrideFor` through the consumer layer, the roles
 * the switch moves and the ones it leaves) is pinned beside the rendering so
 * the two halves cannot disagree.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { LoopTurn, ToolDescription } from '@hames-ai/harness-baml/baml_client/types'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))
vi.mock('@hames-ai/harness-patterns/mcp-client.server', () => ({
  callTool: vi.fn(),
  listTools: vi.fn().mockResolvedValue([]),
}))

import { DEFAULT_LARGE_LLM_MODEL } from '@hames-ai/harness-baml/inference-env.server'
import {
  activateOpenRouterLargeOverride,
  largeOnOpenRouter,
  openRouterLargeOverride,
  openRouterLargeRoles,
} from '@hames-ai/harness-baml/openrouter-eval.server'

const OPENROUTER_MODEL = 'qwen/qwen3.8-27b'
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'

type Body = Record<string, unknown>

/** The env bag shape the private tier's renders use; `env` merges over
 *  process.env per call, so each render below is isolated from the others. */
const BASE_ENV = {
  LARGE_LLM_BASE_URL: 'https://example.invalid/deployment/v1',
  LARGE_LLM_API_KEY: 'offline-render-test',
  SMALL_LLM_BASE_URL: 'https://example.invalid/small/v1',
  SMALL_LLM_API_KEY: 'offline-render-test',
}

const TOOLS: ToolDescription[] = [
  { name: 'search', description: 'Search', args_schema: '{"query":"string"}' },
]
const TURNS: LoopTurn[] = [
  {
    n: 1,
    tool_call: { tool: 'search', args: '{"query":"x"}' },
    tool_result: { tool: 'search', result: 'rows', success: true },
  },
]

type BamlRequest = (typeof import('@hames-ai/harness-baml/baml_client').b)['request']
let b: { request: BamlRequest }

beforeAll(async () => {
  const client = await import('@hames-ai/harness-baml/baml_client')
  b = { request: client.b.request }
})

afterAll(async () => {
  // The consumer layer is process-global module state; a test file that
  // activated it must clear it, or a later file in the same worker would
  // inherit a routing decision it never made.
  const { configureConsumerClients } = await import('@hames-ai/harness-baml/clients.server')
  configureConsumerClients(undefined)
})

describe('the default path — vars unset, byte-identical', () => {
  it('renders the declared client: default model id, no provider block', async () => {
    // The unset path in production: no LARGE_LLM_* at all, and the boot
    // normalization (`applyLegacyInferenceEnv`, run at the routing seam's
    // import) applies the default model id. Rendered here the same way — the
    // var resolved from process.env, no per-call override — and asserted
    // against the shape the declared client has always produced.
    delete process.env.LARGE_LLM_MODEL
    const { applyLegacyInferenceEnv } = await import('@hames-ai/harness-baml/inference-env.server')
    applyLegacyInferenceEnv()
    expect(process.env.LARGE_LLM_MODEL).toBe(DEFAULT_LARGE_LLM_MODEL)

    const bag = { client: 'LargeQwen', env: BASE_ENV }
    const body = (
      await b.request.ScreenUntrustedContent('web/fetch', 'page text', bag)
    ).body.json() as Body
    expect(body.model).toBe('Qwen/Qwen3.8-27B-FP8')
    expect(body.provider).toBeUndefined()
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(body.max_tokens).toBe(4096)
    expect(body.temperature).toBe(0.2)
  })

  it('composes no consumer layer and the switch reads false', async () => {
    expect(largeOnOpenRouter()).toBe(false)
    expect(openRouterLargeOverride()).toBeUndefined()
    expect(activateOpenRouterLargeOverride()).toBe(false)
    const { clientOverrideFor } = await import('@hames-ai/harness-baml/clients.server')
    expect(clientOverrideFor('controller')).toBeUndefined()
  })
})

describe('the OpenRouter shape — vars set, switch active', () => {
  const OPENROUTER_ENV = {
    ...BASE_ENV,
    LARGE_LLM_BASE_URL: OPENROUTER_BASE,
    LARGE_LLM_MODEL: OPENROUTER_MODEL,
  }

  /** The bag `clientOverrideFor` hands out under the switch: the SAME client
   *  name, plus the registry that carries the deltas. */
  const evalBag = () => openRouterLargeOverride()!

  it('the switch reads the host and activates for the eval', async () => {
    process.env.LARGE_LLM_BASE_URL = OPENROUTER_BASE
    process.env.LARGE_LLM_API_KEY = 'offline-render-test'
    process.env.LARGE_LLM_MODEL = OPENROUTER_MODEL
    expect(largeOnOpenRouter()).toBe(true)
    expect(activateOpenRouterLargeOverride()).toBe(true)
  })

  it('routes every 27B role through the registry and neither describe nor decide', async () => {
    const { clientOverrideFor } = await import('@hames-ai/harness-baml/clients.server')
    for (const role of [
      'controller',
      'planner',
      'critic',
      'compactExecution',
      'router',
      'screen',
    ] as const) {
      const override = clientOverrideFor(role)
      expect(override?.client, role).toBe('LargeQwen')
      expect(override?.clientRegistry, role).toBeDefined()
    }
    // The small box and the decision transport are absent from the switch by
    // construction — derived from the tier map, never listed.
    expect(openRouterLargeRoles()).not.toContain('describe')
    expect(openRouterLargeRoles()).not.toContain('decide')
    expect(clientOverrideFor('describe')).toBeUndefined()
    expect(clientOverrideFor('decide')).toBeUndefined()
  })

  it('renders the OpenRouter shape: model id from env, provider zdr forwarded', async () => {
    const body = (
      await b.request.ScreenUntrustedContent('web/fetch', 'page text', {
        ...evalBag(),
        env: OPENROUTER_ENV,
      })
    ).body.json() as Body
    expect(body.model).toBe(OPENROUTER_MODEL)
    expect(body.provider).toEqual({ zdr: true })
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(body.max_tokens).toBe(4096)
  })

  it('differs from the default render in exactly the two intended fields', async () => {
    // The registry MIRRORS the declared client's options; BAML offers no
    // partial override, so this comparison is what keeps the copy honest.
    // Rendered with the SAME prompt and arguments, the two bodies must be
    // equal except `model` (env-resolved) and `provider` (the block).
    const renderDefault = async () =>
      (
        await b.request.ScreenUntrustedContent('web/fetch', 'page text', {
          client: 'LargeQwen',
          env: { ...BASE_ENV, LARGE_LLM_MODEL: DEFAULT_LARGE_LLM_MODEL },
        })
      ).body.json() as Body
    const renderEval = async () =>
      (
        await b.request.ScreenUntrustedContent('web/fetch', 'page text', {
          ...evalBag(),
          env: OPENROUTER_ENV,
        })
      ).body.json() as Body
    const strip = (body: Body) => {
      const { model: _model, provider: _provider, ...rest } = body
      return rest
    }
    expect(strip(await renderEval())).toEqual(strip(await renderDefault()))
    // ...and not vacuously: the two really do differ in the two fields.
    expect((await renderEval()).model).not.toBe((await renderDefault()).model)
    expect((await renderEval()).provider).toEqual({ zdr: true })
    expect((await renderDefault()).provider).toBeUndefined()
  })

  it('the controller renders the same deltas on the loop-shaped function', async () => {
    const body = (
      await b.request.LoopController('q', 'i', TOOLS, TURNS, null, null, null, null, null, null, {
        ...evalBag(),
        env: OPENROUTER_ENV,
      })
    ).body.json() as Body
    expect(body.model).toBe(OPENROUTER_MODEL)
    expect(body.provider).toEqual({ zdr: true })
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  it('an empty LARGE_LLM_MODEL is normalized to the default at boot, not wired as garbage', async () => {
    // BAML substitutes an env reference verbatim — an EMPTY value would reach
    // the body as an empty model id, which no endpoint serves. The boot
    // normalization treats empty as unset: back to the default.
    process.env.LARGE_LLM_MODEL = ''
    const { applyLegacyInferenceEnv } = await import('@hames-ai/harness-baml/inference-env.server')
    applyLegacyInferenceEnv()
    expect(process.env.LARGE_LLM_MODEL).toBe('Qwen/Qwen3.8-27B-FP8')
  })

  it('a non-OpenRouter host stays inert even with the other vars set', async () => {
    process.env.LARGE_LLM_BASE_URL = BASE_ENV.LARGE_LLM_BASE_URL
    expect(largeOnOpenRouter()).toBe(false)
    expect(activateOpenRouterLargeOverride()).toBe(false)
    const { clientOverrideFor } = await import('@hames-ai/harness-baml/clients.server')
    expect(clientOverrideFor('controller')).toBeUndefined()
  })

  it('a half-configured switch fails loudly, never quietly', async () => {
    // An OpenRouter host with no key must throw at activation — the same
    // fail-closed shape as assertLargeModelConfigured — rather than render a
    // registry client with a null option or silently keep the box.
    process.env.LARGE_LLM_BASE_URL = OPENROUTER_BASE
    delete process.env.LARGE_LLM_API_KEY
    expect(() => activateOpenRouterLargeOverride()).toThrow(/LARGE_LLM_API_KEY/)
  })
})
