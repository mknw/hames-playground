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
 * #351 moved half the corpus into `@hames/harness-baml`, which left this file
 * as TWO client trees — and the first cut of that change broke it twice. The
 * lessons, now pinned by the structure below:
 *
 *   - a generated `b.request` method must be called BOUND. The methods read
 *     private `runtime`/`ctxManager` state off `this`, so extracting the
 *     function and calling it (`pkgB.request[fn](...)`) dies with
 *     "Cannot read properties of undefined (reading 'runtime')". Every render
 *     below therefore reads the method and calls it with the owner as `this`,
 *     the way `verda-body-shape.test.ts`'s bound proxy does.
 *   - the two trees share SEVEN function names (the heavy roles + screen are
 *     declared in both `baml_src/`s), so a plain array union of their
 *     declarations has 20 entries against the 13-name constant — deterministic
 *     red. The declared set is the union as a SET, which is exactly the
 *     "markers cover everything the trees declare" claim.
 *
 * The renders go through `VerdaQwen` because it is the repo's only
 * `openai-generic` client, and the openai-generic body is what the fake sees.
 * The Anthropic providers lift the leading system block into a top-level
 * `system` field instead of leaving it in `messages`, so rendering through them
 * would test a message shape the fake never receives.
 */
import { describe, expect, it, beforeAll } from 'vitest'
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
let declared: string[]
/** Each tree's own declaration list, kept for the two non-vacuous guards below. */
let appDeclared: string[]
let pkgDeclared: string[]

beforeAll(async () => {
  // Boots only for its env side effects — `VerdaQwen` refuses to resolve
  // without a `/v1` endpoint, and `bootApp` is the one place that is set.
  await bootApp()
  // #351: the corpus is two generated singletons. Production renders every
  // role through the PACKAGE client — its baml-adapters own `b` — while the
  // app tree's client is what the dev-fake middleware installs. Each function
  // renders through the app tree where it declares the name (pinning that
  // tree's prompt copies), else the package; the shared prompt files are
  // byte-identical across the trees, so the wire shape tested is the one
  // production sends.
  const [{ b: appB }, { b: pkgB }] = await Promise.all([
    import('../../baml_client'),
    import('@hames/harness-baml/baml_client'),
  ])
  const appReq = appB.request as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
  const pkgReq = pkgB.request as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
  const appDeclaredLocal = generatedFunctionNames(appB.request)
  pkgDeclared = generatedFunctionNames(pkgB.request)
  appDeclared = appDeclaredLocal
  declared = [...new Set([...appDeclared, ...pkgDeclared])].sort()
  const rq =
    (fn: string) =>
    (...args: unknown[]) => {
      const owner = appDeclaredLocal.includes(fn) ? appReq : pkgReq
      // `owner[fn](...args)` is a method call — the receiver rides on the
      // member expression. What loses `this` is extracting the function
      // first, e.g. `(cond ? a[fn] : b[fn])(...)`: the conditional yields the
      // bare function value, which is the crash this file shipped with.
      return owner[fn](...args)
    }
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
    // walks on every request. The union is a SET: the two trees since #351
    // share seven names, and the first cut of that change concatenated the
    // lists, read 20 against the 13-name constant and failed deterministically
    // without saying anything about either tree.
    //
    // The two halves are guarded separately rather than through the set: an
    // empty reflection on either tree would otherwise hide behind the other's
    // names and the render loop would silently check one tree only.
    for (const [label, names] of [
      ['app', appDeclared],
      ['package', pkgDeclared],
    ] as const) {
      expect(
        names.length,
        `no function names were read off the ${label} client's b.request — the reflection found ` +
          'nothing, so the comparison below would pass on an empty list',
      ).toBeGreaterThan(0)
    }
    expect(declared).toEqual([...ALL_BAML_FUNCTIONS].sort())
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
