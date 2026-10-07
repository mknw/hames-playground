/**
 * The fake has to still recognise every prompt this repo sends.
 *
 * `lib/fake-llm.ts` identifies the BAML function behind a request by matching
 * text in the rendered prompt, because an OpenAI-compatible request carries
 * nothing else that names it. That reading is a dependency on `baml_src/`
 * wording, and wording moves. Without this file the symptom of a moved line
 * would be a scenario three files later failing with a 400 from the fake — a
 * red result that names the wrong thing.
 *
 * So: render every function offline through `b.request.*` (no socket opened),
 * push each rendered prompt through the same classifier the fake uses, and
 * assert it identifies itself. A red test here means one thing — update
 * `MARKERS` in `lib/baml-functions.ts`. Never loosen the classifier to make it
 * pass: a marker that matches two functions makes the fake answer one of them
 * with the other's output schema.
 *
 * #351 briefly made this file read TWO client trees; the app's duplicate
 * `baml_src/` is gone and there is now ONE — `packages/harness-baml/baml_src`
 * and the committed client it generates, which is the same `b` the adapters
 * call in production. Two properties from that episode are still pinned below,
 * because neither was about the duplication:
 *
 *   - a generated `b.request` method must be called BOUND. The methods read
 *     private `runtime`/`ctxManager` state off `this`, so extracting the
 *     function and calling it (`const { Router } = b.request`) dies with
 *     "Cannot read properties of undefined (reading 'runtime')". Every render
 *     below therefore goes through the client object itself.
 *   - the names the client declares are checked against the `.baml` SOURCES on
 *     disk as well as against `MARKERS`. With two trees that job was done by
 *     comparing the trees to each other; with one tree the only thing left to
 *     compare the generated client against is the corpus it was generated
 *     from — which also makes a stale COMMITTED client red here, and that
 *     client is committed precisely so nothing regenerates it on the way in.
 *
 * The renders go through `VerdaQwen` because it is the repo's only
 * `openai-generic` client, and the openai-generic body is what the fake sees.
 * The Anthropic providers lift the leading system block into a top-level
 * `system` field instead of leaving it in `messages`, so rendering through them
 * would test a message shape the fake never receives.
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { bootApp } from '../lib/app'
import {
  ALL_BAML_FUNCTIONS,
  classifyPrompt,
  generatedFunctionNames,
  promptText,
  type ChatMessage,
} from '../lib/baml-functions'
import { takeEgressAttempts } from '../lib/egress-backstop'
import { IS_HERMETIC, VERDA_MODEL } from '../lib/mode'

type Renderer = () => Promise<{ body: { json: () => unknown } }>

let renderers: Record<string, Renderer>
/** The function names the GENERATED client declares. */
let declared: string[]
/** The function names the `.baml` SOURCES declare — the other side of the pin. */
let declaredInSource: string[]

/** `function Name(` across the one corpus, comments stripped so a commented-out
 *  example never registers as a declaration. */
function bamlSourceFunctionNames(): string[] {
  const dir = path.resolve(process.cwd(), '../packages/harness-baml/baml_src')
  const names = new Set<string>()
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.baml')) continue
    const src = readFileSync(path.join(dir, entry), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    for (const m of src.matchAll(/^function\s+(\w+)\s*\(/gm)) names.add(m[1])
  }
  return [...names].sort()
}

beforeAll(async () => {
  // Boots only for its env side effects — `VerdaQwen` refuses to resolve
  // without a `/v1` endpoint, and `bootApp` is the one place that is set.
  await bootApp()
  // ONE corpus: this is the client the package's adapters, defaults, routing
  // and the title agent all import, so the wire shape tested here is the one
  // production sends.
  const { b } = await import('@hames-ai/harness-baml/baml_client')
  const req = b.request as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
  declared = generatedFunctionNames(b.request)
  declaredInSource = bamlSourceFunctionNames()
  // `req[fn](...args)` is a method call — the receiver rides on the member
  // expression. What loses `this` is extracting the function first, which is
  // the crash this file shipped with.
  const rq =
    (fn: string) =>
    (...args: unknown[]) =>
      req[fn](...args)
  const via = { client: 'VerdaQwen' }
  const tools = [{ name: 'search', description: 'Search', args_schema: '{}' }]
  const attempt = {
    n: 1,
    action: { reasoning: 'r', tool_name: 'search', tool_args: '{}' },
    result: 'rows',
  }
  const options = [
    { letter: 'A', description: 'Use tools' },
    { letter: 'B', description: 'Just answer' },
  ]
  renderers = {
    Decide: () => rq('Decide')('state', 'Which route?', options, via),
    DecideVerbalized: () => rq('DecideVerbalized')('state', 'Which route?', options, via),
    Router: () => rq('Router')('m', [{ name: 'neo4j', description: 'd' }], [], null, via),
    // Ten positional parameters, then the options bag. Counting matters more
    // than it looks: an extra `null` pushes `via` past the options slot, the
    // render silently falls back to the DECLARED Anthropic chain, and the
    // assertion below on `model` is what catches it.
    LoopController: () =>
      rq('LoopController')('m', 'i', tools, [], null, null, null, null, null, null, via),
    ActorController: () =>
      rq('ActorController')('m', 'i', tools, [], null, null, null, null, null, via),
    Critic: () => rq('Critic')('i', [attempt], via),
    Synthesize: () => rq('Synthesize')('m', 'i', [], false, null, null, via),
    ResultDescribe: () => rq('ResultDescribe')('search', '{}', 'r', 'rows', via),
    ResultDescribeBatch: () =>
      rq('ResultDescribeBatch')(
        [{ id: '1', tool: 'search', tool_args: '{}', reasoning: 'r', result: 'rows' }],
        via,
      ),
    CompactIntent: () => rq('CompactIntent')([], 'latest', via),
    Planner: () => rq('Planner')('m', 'i', tools, null, via),
    ScreenUntrustedContent: () => rq('ScreenUntrustedContent')('web', 'content', via),
    RetrieveQuery: () => rq('RetrieveQuery')([], 'latest', via),
    ReferenceSelector: () => rq('ReferenceSelector')('i', [], [], via),
    GenerateConversationTitle: () => rq('GenerateConversationTitle')('m', via),
  } as Record<string, Renderer>
})

describe('the fake recognises every BAML function', () => {
  it('knows both decision functions even while the memory fake is outstanding', () => {
    for (const name of ['Decide', 'DecideVerbalized']) {
      expect(declared).toContain(name)
      expect(ALL_BAML_FUNCTIONS).toContain(name)
    }
  })

  it('refuses an explicit production client absent from the fake registry before networking', async () => {
    const { b } = await import('@hames-ai/harness-baml/baml_client')
    const options = (
      b as unknown as {
        bamlOptions: NonNullable<Parameters<typeof b.request.DecideVerbalized>[3]>
      }
    ).bamlOptions
    // This client EXISTS in BAML, but the fake registry has never seen it.
    // A made-up name would throw even without the guard, proving nothing.
    await expect(
      b.request.DecideVerbalized(
        'state',
        'Which route?',
        [
          { letter: 'A', description: 'Take' },
          { letter: 'B', description: 'Skip' },
        ],
        { ...options, client: 'AnthropicHaiku45' },
      ),
    ).rejects.toThrow('e2e hermetic routing refused client AnthropicHaiku45')
  })

  it('admits the native decision chain only with its registered fake leaves', async () => {
    const app = await bootApp()
    const { b } = await import('@hames-ai/harness-baml/baml_client')
    const request = await b.request.DecideVerbalized(
      's',
      'q',
      [
        { letter: 'A', description: 'a' },
        { letter: 'B', description: 'b' },
      ],
      {
        ...(
          b as unknown as {
            bamlOptions: NonNullable<Parameters<typeof b.request.DecideVerbalized>[3]>
          }
        ).bamlOptions,
        client: 'DecideAnthropic',
      },
    )
    expect(request.url).toBe(`${app.fakeLlm.baseUrl}/chat/completions`)
  })

  it('covers every function the classifier can name', () => {
    // Guards against the guard going vacuous: a function added to MARKERS but
    // not rendered here would never be checked.
    expect(Object.keys(renderers).sort()).toEqual([...ALL_BAML_FUNCTIONS].sort())
  })

  it('knows every function the generated clients declare', () => {
    // The other direction, and the one nothing checked before: MARKERS said
    // what the fake recognises, and nothing said whether that was all of
    // `baml_src/`. A fourteenth function used to surface as a 400 from the fake
    // in whichever scenario reached it first ("no BAML function matched this
    // prompt"), three files away from the cause. Now it is red here.
    //
    // Read off `b.request` rather than counted, so it also catches a REMOVED
    // function — a marker matching nothing is dead weight the classifier still
    // walks on every request.
    //
    // Non-vacuity first: an empty reflection would make the comparison below
    // pass against any marker table at all.
    expect(
      declared.length,
      'no function names were read off the client b.request — the reflection found nothing, ' +
        'so the comparison below would pass on an empty list',
    ).toBeGreaterThan(0)
    expect(declared).toEqual([...ALL_BAML_FUNCTIONS].sort())
  })

  it('declares exactly what the one baml_src corpus declares', () => {
    // The single-tree replacement for the per-tree guards this test carried
    // while the app kept a duplicate `baml_src/`. Those compared the two
    // generated clients with each other; with one corpus the comparison that
    // still says something is client ⇄ SOURCES.
    //
    // It is not a restatement of the assertion above. That one pins the client
    // against `MARKERS`, a hand-written table; this one pins it against the
    // `.baml` files on disk — so it goes red when the COMMITTED client drifts
    // from the corpus it was generated from, which is the failure mode a
    // committed client has and a generated-on-install one does not. Nothing
    // regenerates it in CI any more, so nothing else would notice.
    expect(
      declaredInSource.length,
      'no `function` declarations were parsed out of packages/harness-baml/baml_src — the ' +
        'comparison below would pass on an empty list',
    ).toBeGreaterThan(0)
    expect(declaredInSource).toEqual(declared)
  })

  // Driven off the derived list, so this loop cannot fall out of step with it.
  for (const name of ALL_BAML_FUNCTIONS) {
    it(`classifies ${name} as itself`, async () => {
      const request = await renderers[name]()
      const body = request.body.json() as { model?: string; messages?: ChatMessage[] }
      // Prove the render really went through the openai-generic client. An
      // Anthropic render lifts the leading system block into a top-level
      // `system` field, so `messages` would not contain the marker at all and
      // the classifier would be checked against a shape the fake never sees.
      expect(body.model, `${name} did not render through VerdaQwen`).toBe(VERDA_MODEL)
      const text = promptText(body.messages ?? [])
      expect(text.length, `${name} rendered an empty prompt`).toBeGreaterThan(0)
      expect(classifyPrompt(text)).toBe(name)
    })
  }
})

// #418 T4. The Jev transport is a REST adapter, so no `b.request` render can
// check it; this drives the REAL transport at the fake instead. The fake exists
// so a hermetic run never reaches OpenRouter — it is only worth that while the
// transport and the fake agree on the wire.
describe("the fake's Jev endpoint (Decisions API)", () => {
  const SET = {
    key: 'turn',
    fields: {
      route: {
        key: 'route',
        question: 'Which route?',
        labels: [
          { id: 'search', description: 'look something up' },
          { id: 'chat', description: 'just talk' },
        ],
      },
    },
  }

  it('answers the shipped transport with typed probabilities, recorded under the Jev model id', async () => {
    const { fakeLlm } = await bootApp()
    fakeLlm.reset()
    const { createJevTransport } = await import('@hames-ai/harness-baml/jev-decide.server')
    const r = await createJevTransport().decideAll({ spec: SET, state: 's' })
    expect(r.fields.route.method).toBe('jev')
    expect(r.fields.route.probs.search).toBeCloseTo(0.9, 9)
    expect(r.fields.route.llmCall?.metrics?.basis).toBe('provider')
    expect(fakeLlm.calls.map((c) => [c.model, c.outcome])).toEqual([['typesafe/jev-1.13', 'ok']])
  })

  it('an armed status fault is a Jev error the transport fails closed on', async () => {
    const { fakeLlm } = await bootApp()
    fakeLlm.reset()
    fakeLlm.arm({ kind: 'status', status: 500, times: 1 })
    const { createJevTransport } = await import('@hames-ai/harness-baml/jev-decide.server')
    await expect(createJevTransport().decideAll({ spec: SET, state: 's' })).rejects.toThrow(
      /Jev answered HTTP 500/,
    )
    expect(fakeLlm.calls.map((c) => c.outcome)).toEqual(['status'])
    fakeLlm.reset()
  })
})

describe.runIf(IS_HERMETIC)('hermetic transport backstop', () => {
  const target = 'hermetic-backstop.invalid:443'
  async function registry() {
    const { ClientRegistry } = await import('@boundaryml/baml')
    const r = new ClientRegistry()
    r.addLlmClient('E2EEgressProbe', 'openai-generic', {
      base_url: 'https://hermetic-backstop.invalid/v1',
      api_key: 'e2e-fake-key',
      model: 'fake',
    })
    r.setPrimary('E2EEgressProbe')
    return r
  }
  async function recordedRefusal(call: () => Promise<unknown>, expected = target) {
    await expect(call()).rejects.toThrow()
    const attempts = await takeEgressAttempts()
    expect(attempts.length).toBeGreaterThan(0)
    expect(attempts).toEqual(attempts.map(() => ({ method: 'CONNECT', target: expected })))
  }
  it('records a real BAML call with a replacing per-call registry', async () => {
    const { b } = await import('@hames-ai/harness-baml/baml_client')
    const r = await registry()
    await recordedRefusal(() => b.GenerateConversationTitle('x', { clientRegistry: r }))
  })
  it('records Node fetch at the transport', async () => {
    await recordedRefusal(() => fetch('https://hermetic-backstop.invalid/'))
  })
  it('records the consumer client layer bypass', async () => {
    const { b } = await import('@hames-ai/harness-baml/baml_client')
    const { activateConsumerClients, defineInferenceClients } =
      await import('@hames-ai/harness-baml/consumer-clients.server')
    const { clientOverrideFor } = await import('@hames-ai/harness-baml/clients.server')
    activateConsumerClients(
      defineInferenceClients({
        clients: [
          {
            name: 'E2EConsumer',
            provider: 'openai-generic',
            options: {
              base_url: 'https://hermetic-backstop.invalid/v1',
              api_key: 'e2e-fake-key',
              model: 'fake',
            },
          },
        ],
        byRole: { describe: 'E2EConsumer' },
      }),
    )
    try {
      await recordedRefusal(() => b.GenerateConversationTitle('x', clientOverrideFor('describe')))
    } finally {
      activateConsumerClients(undefined)
    }
  })
  it.each([true, false])('records a per-run registry bypass (named=%s)', async (named) => {
    const { b } = await import('@hames-ai/harness-baml/baml_client')
    const { clientOverrideFor } = await import('@hames-ai/harness-baml/clients.server')
    const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
    const r = await registry()
    await withRunFrame(
      {
        inference: {
          tier: 'anthropic',
          clientOverride: () => ({
            clientRegistry: r,
            ...(named ? { client: 'E2EEgressProbe' } : {}),
          }),
        },
      },
      async () => {
        await recordedRefusal(() => b.GenerateConversationTitle('x', clientOverrideFor('describe')))
      },
    )
  })
  it('records b.withOptions bypassing the singleton getter', async () => {
    const { b } = await import('@hames-ai/harness-baml/baml_client')
    const r = await registry()
    await recordedRefusal(() => b.withOptions({ clientRegistry: r }).GenerateConversationTitle('x'))
  })
  it('records b.stream bypassing the singleton getter', async () => {
    const { b } = await import('@hames-ai/harness-baml/baml_client')
    const r = await registry()
    await recordedRefusal(() =>
      b.stream.GenerateConversationTitle('x', { clientRegistry: r }).getFinalResponse(),
    )
  })
  it('observes the native defaults on unconfigured b.withOptions and b.stream', async () => {
    const { b } = await import('@hames-ai/harness-baml/baml_client')
    // Offline evidence of the captured options gap; the live pins above use
    // .invalid so even a mutated proxy cannot send a probe to a provider.
    for (const request of [
      await b.withOptions({}).request.GenerateConversationTitle('x'),
      await b.streamRequest.GenerateConversationTitle('x'),
    ]) {
      expect(request.url).toBe('https://api.anthropic.com/v1/messages')
    }
  })
  it('records a per-call env overriding an admitted private endpoint', async () => {
    const { b } = await import('@hames-ai/harness-baml/baml_client')
    await recordedRefusal(() =>
      b.GenerateConversationTitle('x', {
        client: 'LocalQwenSmall',
        env: { SMALL_LLM_BASE_URL: 'https://hermetic-backstop.invalid/v1' },
      }),
    )
  })
  it.each([
    ['LocalQwenSmallDecide', 'SMALL_LLM_BASE_URL'],
    ['LocalQwenSmall', 'SMALL_LLM_BASE_URL'],
    ['VerdaQwen', 'VERDA_INFERENCE_ENDPOINT'],
  ])('refuses %s when its process endpoint differs from the fake', async (client, variable) => {
    const { b } = await import('@hames-ai/harness-baml/baml_client')
    const original = process.env[variable]
    process.env[variable] = 'https://e2e-not-the-fake.invalid/v1'
    try {
      const options = (
        b as unknown as {
          bamlOptions: NonNullable<Parameters<typeof b.request.Decide>[3]>
        }
      ).bamlOptions
      await expect(
        b.request.Decide(
          's',
          'q',
          [
            { letter: 'A', description: 'a' },
            { letter: 'B', description: 'b' },
          ],
          { ...options, client },
        ),
      ).rejects.toThrow(`e2e hermetic routing refused client ${client}`)
    } finally {
      if (original === undefined) delete process.env[variable]
      else process.env[variable] = original
    }
  })
})
