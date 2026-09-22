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
import { VERDA_MODEL } from '../lib/mode'

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
  const { b } = await import('@hames/harness-baml/baml_client')
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
  renderers = {
    Router: () => rq('Router')('m', [{ name: 'neo4j', description: 'd' }], [], via),
    // Ten positional parameters, then the options bag. Counting matters more
    // than it looks: an extra `null` pushes `via` past the options slot, the
    // render silently falls back to the DECLARED Anthropic chain, and the
    // assertion below on `model` is what catches it.
    LoopController: () =>
      rq('LoopController')('m', 'i', tools, [], null, null, null, null, null, null, via),
    ActorController: () =>
      rq('ActorController')('m', 'i', tools, [], null, null, null, null, null, via),
    Critic: () => rq('Critic')('i', [attempt], via),
    Synthesize: () => rq('Synthesize')('m', 'i', [], false, null, via),
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
