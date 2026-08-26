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

beforeAll(async () => {
  // Boots only for its env side effects — `VerdaQwen` refuses to resolve
  // without a `/v1` endpoint, and `bootApp` is the one place that is set.
  await bootApp()
  const { b } = await import('../../baml_client')
  declared = generatedFunctionNames(b.request)
  const via = { client: 'VerdaQwen' }
  const tools = [{ name: 'search', description: 'Search', args_schema: '{}' }]
  const attempt = {
    n: 1,
    action: { reasoning: 'r', tool_name: 'search', tool_args: '{}' },
    result: 'rows',
  }
  renderers = {
    Router: () => b.request.Router('m', [{ name: 'neo4j', description: 'd' }], [], via),
    // Ten positional parameters, then the options bag. Counting matters more
    // than it looks: an extra `null` pushes `via` past the options slot, the
    // render silently falls back to the DECLARED Anthropic chain, and the
    // assertion below on `model` is what catches it.
    LoopController: () =>
      b.request.LoopController('m', 'i', tools, [], null, null, null, null, null, null, via),
    ActorController: () =>
      b.request.ActorController('m', 'i', tools, [], null, null, null, null, null, via),
    Critic: () => b.request.Critic('i', [attempt], via),
    Synthesize: () => b.request.Synthesize('m', 'i', [], false, null, via),
    ResultDescribe: () => b.request.ResultDescribe('search', '{}', 'r', 'rows', via),
    ResultDescribeBatch: () =>
      b.request.ResultDescribeBatch(
        [{ id: '1', tool: 'search', tool_args: '{}', reasoning: 'r', result: 'rows' }],
        via,
      ),
    CompactIntent: () => b.request.CompactIntent([], 'latest', via),
    Planner: () => b.request.Planner('m', 'i', tools, null, via),
    ScreenUntrustedContent: () => b.request.ScreenUntrustedContent('web', 'content', via),
    RetrieveQuery: () => b.request.RetrieveQuery([], 'latest', via),
    ReferenceSelector: () => b.request.ReferenceSelector('i', [], [], via),
    GenerateConversationTitle: () => b.request.GenerateConversationTitle('m', via),
  } as Record<string, Renderer>
})

describe('the fake recognises every BAML function', () => {
  it('covers every function the classifier can name', () => {
    // Guards against the guard going vacuous: a function added to MARKERS but
    // not rendered here would never be checked.
    expect(Object.keys(renderers).sort()).toEqual([...ALL_BAML_FUNCTIONS].sort())
  })

  it('knows every function the generated client declares', () => {
    // The other direction, and the one nothing checked before: MARKERS said
    // what the fake recognises, and nothing said whether that was all of
    // `baml_src/`. A fourteenth function used to surface as a 400 from the fake
    // in whichever scenario reached it first ("no BAML function matched this
    // prompt"), three files away from the cause. Now it is red here.
    //
    // Read off `b.request` rather than counted, so it also catches a REMOVED
    // function — a marker matching nothing is dead weight the classifier still
    // walks on every request.
    expect(
      declared.length,
      'no function names were read off the generated client — the reflection found nothing, so ' +
        'the comparison below would pass on an empty list',
    ).toBeGreaterThan(0)
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
