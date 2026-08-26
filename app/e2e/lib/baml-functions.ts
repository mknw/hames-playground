/**
 * Which BAML function a request carries — recovered from the rendered prompt.
 *
 * The fake endpoint (`fake-llm.ts`) is an OpenAI-compatible server, and an
 * OpenAI-compatible request says nothing about which BAML function produced it:
 * there is no function name, no tag, no header. All thirteen functions arrive
 * at the same `POST /v1/chat/completions` looking alike apart from their text.
 * So the text is what identifies them, and this module owns that reading.
 *
 * WHY THIS IS SAFE ENOUGH TO BUILD ON, AND WHERE IT BREAKS. Every marker below
 * is a line from a function's `_.role("system")` block — the one part of a
 * prompt that is a hand-written sentence rather than interpolated runtime data,
 * and the part `prompt-role-order.test.ts` already pins the position of.
 *
 * A prompt edit that moves one of these lines makes the fake stop recognising
 * that function. That failure is caught, loudly, by `00-fake-fidelity.e2e.ts`,
 * which renders all thirteen functions offline through `b.request.*` and
 * asserts each one classifies as itself — rather than by a scenario mysteriously
 * going red three files later. Fixing a red fidelity test means updating the
 * marker here, never loosening the classifier.
 */

/**
 * Marker → function, in match order. Order is load-bearing:
 *
 *  - `ResultDescribeBatch` shares its opening sentence with `ResultDescribe`
 *    ("You are a concise data summarizer."), so the batch's longer, more
 *    specific second clause has to be tried first.
 *  - `LoopController` and `ActorController` share theirs VERBATIM ("You are an
 *    AI agent that accomplishes tasks by calling tools."), so both are matched
 *    on their SECOND line, which is where the two loop patterns diverge — the
 *    actor is told a critic judges it, the loop controller is told to use
 *    `Return`. Matching either on the shared line would send simpleLoop the
 *    actor's canned reply, which sets `is_final` on turn 0 and ends the loop
 *    before a single tool runs. That is not hypothetical: it is what this file
 *    did on its first draft, and the scenario it broke reported "no tool
 *    result" rather than "wrong function".
 */
const MARKERS = [
  ['Router', 'Analyze the user message and determine routing.'],
  ['ActorController', 'A critic evaluates your output. Learn from previous feedback.'],
  ['LoopController', 'Select one tool per turn. Use "Return" when you have enough information.'],
  ['Critic', "You evaluate whether task execution results satisfy the user's intent."],
  ['Synthesize', 'Create a user-friendly response from tool execution results.'],
  ['ResultDescribeBatch', 'You will receive several INDEPENDENT tool'],
  ['ResultDescribe', 'Summarize what the following tool call'],
  ['CompactIntent', "You rewrite a user's latest message into a single self-contained instruction"],
  ['Planner', 'You are a strategic planner for a tool-using agent.'],
  ['ScreenUntrustedContent', 'You are a prompt-injection detector.'],
  ['RetrieveQuery', "You turn a user's latest message into a concise SEARCH QUERY"],
  [
    'ReferenceSelector',
    "Select prior tool results that are relevant to the user's current intent.",
  ],
  [
    'GenerateConversationTitle',
    'Generate a 3-to-5-word title summarizing what this conversation is',
  ],
] as const

/**
 * Every BAML function this repo declares — DERIVED from the markers above, not
 * a second copy of the list.
 *
 * There used to be three hand-maintained copies of the same thirteen names
 * (this union, `MARKERS`, and the fidelity scenario's loop) and none of them
 * was checked against `baml_src/`. Now there is one — the marker table, which
 * cannot be derived because each entry is a hand-picked sentence — and
 * {@link generatedFunctionNames} pins it against the generated client, so a
 * fourteenth function is a red test here rather than a 400 from the fake in
 * whichever scenario happens to trigger it first.
 */
export type BamlFunctionName = (typeof MARKERS)[number][0]

/** An OpenAI chat message, in either of the two content shapes BAML emits. */
export interface ChatMessage {
  role: string
  content: string | Array<{ type?: string; text?: string }>
}

/** Flatten a request's messages into one searchable string. */
export function promptText(messages: readonly ChatMessage[]): string {
  return messages
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : (m.content ?? []).map((part) => part.text ?? '').join('\n'),
    )
    .join('\n')
}

/**
 * The BAML function behind a request, or `null` when no marker matched.
 *
 * `null` is never swallowed: `fake-llm.ts` answers it with a 400 naming the
 * unrecognised prompt, so an unknown function fails the run instead of getting
 * a plausible-looking canned reply for the wrong schema.
 */
export function classifyPrompt(text: string): BamlFunctionName | null {
  for (const [name, marker] of MARKERS) {
    if (text.includes(marker)) return name
  }
  return null
}

/** Every function name the classifier can produce — used by the fidelity pin. */
export const ALL_BAML_FUNCTIONS: readonly BamlFunctionName[] = MARKERS.map(([name]) => name)

/**
 * The function names the GENERATED client declares, read off `b.request`.
 *
 * This is the completeness half of the fidelity pin: `MARKERS` says what the
 * fake recognises, and this says what `baml_src/` actually contains, so
 * comparing them catches a function added (or removed) upstream. Without it the
 * pin only proved the fake agrees with itself.
 *
 * Reflection rather than `Object.keys`, and the difference is load-bearing:
 * `b.request` is a class instance (`AsyncHttpRequest`), so one method per BAML
 * function sits on the PROTOTYPE and the instance has no own enumerable keys at
 * all — `Object.keys` returns `[]`, which would make this pin vacuously true.
 * The prototype carries nothing else but `constructor`; if a generator upgrade
 * ever adds a helper there, this list grows and the pin goes red, which is the
 * right way round for a guard.
 */
export function generatedFunctionNames(request: object): string[] {
  return Object.getOwnPropertyNames(Object.getPrototypeOf(request))
    .filter((name) => name !== 'constructor')
    .sort()
}
