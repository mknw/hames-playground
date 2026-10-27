/** Opt-in trace capture for the general-next eval (#507): what the live report cannot say.
 *
 * The report grades a conversation by its decision sequence and tool checks. It cannot say WHY
 * the decider chose `answer`, what a controller wrote before an attempt failed, why a critic
 * rejected one, or what synthesis did with the results, because the events that hold it are
 * discarded after grading. They are already on the trace: every `decision_made` event carries the exact request body its call sent (`llmCall.rawInput`) and the
 * endpoint's answer (`rawOutput`), and every controller/actor call carries its raw completion.
 * So capture is a read of the trace, with no new seam, and it works in hermetic and live mode
 * alike.
 *
 * Off unless EVAL_GENERAL_CAPTURE=1. The decision state can hold tool results verbatim and the
 * decision event itself is metadata-only for that reason (SD-3), so the output goes only to
 * `evals/reports` (gitignored) and is meant for the eval's synthetic fixtures; the runner does not
 * widen what the eval already feeds the agent. */
import type { ContextEvent } from '@hames-ai/harness-patterns'
import type { ConversationTrace } from './conversation'
import type { SpendKey } from './spend-budget'

export const CAPTURE_ENV = 'EVAL_GENERAL_CAPTURE'
/** One raw controller/actor output is capped so a runaway completion cannot bloat the file. */
export const CAPTURE_OUTPUT_MAX_CHARS = 8000

/** Only the exact value `1` turns it on: a stray `0`, `false` or empty string must not. */
export const captureEnabled = (env: Record<string, string | undefined>): boolean =>
  env[CAPTURE_ENV] === '1'

export interface DecideCapture {
  turn: number
  /** Position of this decision within the turn, 1-based. */
  decision: number
  /** The `instructions` field of the question the decider was asked. */
  instructions: string
  /** Route name → the only text the decider saw for it. */
  criteria: Record<string, string>
  /** The state the decision was asked over: conversation, steps so far, latest results. */
  state: string
  /** The label the loop acted on; null when the decision abstained. */
  choice: string | null
  /** The endpoint's probabilities, untouched. */
  probs: Record<string, number>
  top: string | null
  margin: number
  abstained: boolean
  /** The raw response body, when the call carried one. */
  rawOutput?: string
  shadow?: true
}

export interface ControllerCapture {
  turn: number
  patternId: string
  functionName: string
  /** `error` for a call that ended in an error event, `recovery` for a `loop_recovery` (the loop's
   * recoverable unparseable, refused or invalid-args answer), `completion` for any other call. */
  outcome: 'error' | 'recovery' | 'completion'
  error?: string
  rawOutput?: string
}

export interface CriticCapture {
  turn: number
  patternId: string
  functionName: string
  /** `verdict` for a completed `critic_result` (recorded whether the verdict accepted or rejected
   * — the rejection reason is what the diagnosis reads), `error` for a failed critic call. */
  outcome: 'verdict' | 'error'
  error?: string
  /** The critic's `is_sufficient`; null when the event carried no parsed verdict. */
  verdict: boolean | null
  /** The critic's `explanation`. */
  reason: string
  suggestedApproach?: string | null
  /** The client BAML selected for the call, when the event carried a call record. */
  client?: string
  provider?: string
  rawOutput?: string
}

export interface SynthesizeCapture {
  turn: number
  patternId: string
  functionName: string
  /** `completion` for the final synthesis, `error` for a failed synthesis call. */
  outcome: 'completion' | 'error'
  error?: string
  /** The synthesized response as the event recorded it. */
  output?: string
  client?: string
  provider?: string
  rawOutput?: string
}

export interface ScenarioCapture {
  decisions: DecideCapture[]
  /** Raw controller/actor outputs: error events always; every call when the scenario failed. */
  controllerCalls: ControllerCapture[]
  /** Every critic verdict and failed critic call, whether the scenario passed or not: a rejection
   * on a passing scenario is exactly what the diagnosis needs to see. */
  criticCalls: CriticCapture[]
  /** Every synthesis and failed synthesis call. The router's direct answer is not synthesis and
   * is not here. */
  synthesizeCalls: SynthesizeCapture[]
  /** Set when the scenario threw before it could be graded: the rows above are then empty by
   * absence of a trace, not by absence of decisions. */
  error?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const cap = (text: string | undefined): string | undefined =>
  text !== undefined && text.length > CAPTURE_OUTPUT_MAX_CHARS
    ? `${text.slice(0, CAPTURE_OUTPUT_MAX_CHARS)}…[truncated, ${text.length - CAPTURE_OUTPUT_MAX_CHARS} more characters]`
    : text

const CONTROLLER_FUNCTIONS = new Set(['LoopController', 'ActorController'])
// The critic's BAML function and its reasoning twin (the twin the private tier can resolve the
// critic role onto); `Synthesize` is the only synthesis function.
const CRITIC_FUNCTIONS = new Set(['Critic', 'CriticThinking'])
const SYNTHESIZE_FUNCTIONS = new Set(['Synthesize'])

const clientOf = (event: ContextEvent): { client?: string; provider?: string } => {
  const client = event.llmCall?.clientName
  const provider = event.llmCall?.provider
  return {
    ...(client !== undefined && { client }),
    ...(provider !== undefined && { provider }),
  }
}

function criticOf(event: ContextEvent, turn: number): CriticCapture {
  const data = isRecord(event.data) ? event.data : {}
  const result = isRecord(data.result) ? data.result : {}
  const verdict = typeof result.is_sufficient === 'boolean' ? result.is_sufficient : null
  const reason = typeof result.explanation === 'string' ? result.explanation : ''
  const suggested = typeof result.suggested_approach === 'string' ? result.suggested_approach : null
  const message = event.type === 'error' && typeof data.error === 'string' ? data.error : undefined
  return {
    turn,
    patternId: event.patternId,
    functionName: event.llmCall?.functionName ?? 'Critic',
    outcome: event.type === 'error' ? 'error' : 'verdict',
    ...(message !== undefined && { error: message }),
    verdict,
    reason,
    ...(suggested !== null && { suggestedApproach: suggested }),
    ...clientOf(event),
    ...(event.llmCall?.rawOutput !== undefined && { rawOutput: cap(event.llmCall.rawOutput) }),
  }
}

function synthesizeOf(event: ContextEvent, turn: number): SynthesizeCapture {
  const data = isRecord(event.data) ? event.data : {}
  const message = event.type === 'error' && typeof data.error === 'string' ? data.error : undefined
  return {
    turn,
    patternId: event.patternId,
    functionName: event.llmCall?.functionName ?? 'Synthesize',
    outcome: event.type === 'error' ? 'error' : 'completion',
    ...(message !== undefined && { error: message }),
    ...(typeof data.content === 'string' && { output: cap(data.content) }),
    ...clientOf(event),
    ...(event.llmCall?.rawOutput !== undefined && { rawOutput: cap(event.llmCall.rawOutput) }),
  }
}

function decideOf(event: ContextEvent, turn: number, decision: number): DecideCapture {
  const data = isRecord(event.data) ? event.data : {}
  const key = typeof data.key === 'string' ? data.key : 'next_step'
  // The request as SENT is the evidence; the event's own labels are the fallback for a call
  // that carried no record (they are the same descriptions, minus the state text).
  let sent: Record<string, unknown> = {}
  try {
    sent = event.llmCall?.rawInput ? (JSON.parse(event.llmCall.rawInput) as typeof sent) : {}
  } catch {
    // An unparseable request body is itself the finding: fall through to the event's labels.
  }
  const question =
    isRecord(sent.questions) && isRecord(sent.questions[key]) ? sent.questions[key] : {}
  const labels = Array.isArray(data.labels)
    ? (data.labels as Array<{ id: string; description: string }>)
    : []
  return {
    turn,
    decision,
    instructions:
      typeof question.instructions === 'string'
        ? question.instructions
        : typeof data.question === 'string'
          ? data.question
          : '',
    criteria: isRecord(question.criteria)
      ? (question.criteria as Record<string, string>)
      : Object.fromEntries(labels.map((l) => [l.id, l.description])),
    state: typeof sent.state === 'string' ? sent.state : '',
    choice: typeof data.label === 'string' ? data.label : null,
    probs: isRecord(data.probs) ? (data.probs as Record<string, number>) : {},
    top: typeof data.top === 'string' ? data.top : null,
    margin: typeof data.margin === 'number' ? data.margin : 0,
    abstained: data.abstained === true,
    ...(event.llmCall?.rawOutput !== undefined && { rawOutput: cap(event.llmCall.rawOutput) }),
    ...(data.shadow === true && { shadow: true as const }),
  }
}

export function captureTrace(trace: ConversationTrace, failed: boolean): ScenarioCapture {
  const capture: ScenarioCapture = {
    decisions: [],
    controllerCalls: [],
    criticCalls: [],
    synthesizeCalls: [],
  }
  trace.turns.forEach((t, turn) => {
    let decision = 0
    for (const event of t.events) {
      if (event.type === 'decision_made') {
        capture.decisions.push(decideOf(event, turn, ++decision))
        continue
      }
      const fn = event.llmCall?.functionName
      if (fn && CONTROLLER_FUNCTIONS.has(fn)) {
        const isError = event.type === 'error' || event.type === 'loop_recovery'
        if (!isError && !failed) continue
        const message =
          isRecord(event.data) && typeof event.data.error === 'string'
            ? event.data.error
            : undefined
        capture.controllerCalls.push({
          turn,
          patternId: event.patternId,
          functionName: fn,
          outcome: event.type === 'loop_recovery' ? 'recovery' : isError ? 'error' : 'completion',
          ...(message !== undefined && { error: message }),
          ...(event.llmCall?.rawOutput !== undefined && {
            rawOutput: cap(event.llmCall.rawOutput),
          }),
        })
        continue
      }
      if (
        event.type === 'critic_result' ||
        (event.type === 'error' && fn !== undefined && CRITIC_FUNCTIONS.has(fn))
      ) {
        capture.criticCalls.push(criticOf(event, turn))
        continue
      }
      if (
        (event.type === 'assistant_message' &&
          (isRecord(event.data) ? event.data.final === true : false) &&
          fn !== undefined &&
          SYNTHESIZE_FUNCTIONS.has(fn)) ||
        (event.type === 'error' && fn !== undefined && SYNTHESIZE_FUNCTIONS.has(fn))
      ) {
        capture.synthesizeCalls.push(synthesizeOf(event, turn))
        continue
      }
    }
  })
  return capture
}

/** One entry per finished scenario, written whole each time like the report itself. */
export class CaptureLog {
  readonly entries: Array<SpendKey & ScenarioCapture> = []
  add(key: SpendKey, trace: ConversationTrace, failed: boolean): void {
    this.entries.push({ ...key, ...captureTrace(trace, failed) })
  }
  /** A scenario that threw (a timeout, an escaped BamlTimeoutError) has no trace: without a row,
   * a missing entry would read as "no decisions". */
  addError(key: SpendKey, error: string): void {
    this.entries.push({
      ...key,
      decisions: [],
      controllerCalls: [],
      criticCalls: [],
      synthesizeCalls: [],
      error,
    })
  }
  toJSON() {
    return {
      note: 'Synthetic fixtures only. Decision state and raw model output; gitignored with the reports.',
      scenarios: this.entries,
    }
  }
}
