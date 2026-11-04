/** `EVAL_THINKING` for the general-next conversation eval (#625 G19 Q5 follow-up).
 *
 * WHAT IT SWITCHES: the eval's own process runs the shipped reasoning twins
 * (`ControllerThinking`, `CriticThinking`, `PlannerThinking`) on the private tier's
 * thinking leaf, so the model's parser trace fills the `reasoning` field. It does
 * that through the ONE production switch that already selects them,
 * `PRIVATE_REASONING_ROLES` (`packages/harness-baml/reasoning-roles.server.ts`),
 * written into the eval process's environment around each run mode and restored
 * after it. No new client, no registry, no second routing path: the clients, their
 * `max_tokens` / `request_timeout_ms` pair and the `CLIENT_MAX_OUTPUT_TOKENS` mirror
 * are the shipped ones and stay pinned where they are.
 *
 * WHY PRODUCTION IS UNTOUCHED: nothing outside this module reads `EVAL_THINKING`
 * (`eval-thinking.test.ts` scans for it), and the reasoning setting it writes lives
 * only in the eval process's `process.env`. A deployment's routing changes only
 * when its own operator sets `PRIVATE_REASONING_ROLES`.
 *
 * WHY THE EVAL OWNS THE SETTING: a row labelled `off` must have run with thinking
 * off. An inherited `PRIVATE_REASONING_ROLES` (an operator's `.env`, a shell export)
 * would make that label a guess, so a non-empty inherited value is REFUSED in every
 * mode rather than silently overwritten or silently honoured.
 *
 * Pure: no I/O and no package import, so the runner and the hermetic unit tests share
 * it without either importing the other (`evals-not-in-ci.test.ts`). */
import type { ContextEvent } from '@hames-ai/harness-patterns'

export const THINKING_ENV = 'EVAL_THINKING'
/** The production reasoning switch's name; `eval-thinking.test.ts` pins it equal
 *  to `PRIVATE_REASONING_ROLES_ENV` in the package. */
export const REASONING_ROLES_ENV = 'PRIVATE_REASONING_ROLES'

/** One run mode a row is graded under. */
export type ThinkingMode = 'off' | 'on'
/** What `EVAL_THINKING` asks for: `compare` runs every scenario in both modes. */
export type ThinkingSelection = 'off' | 'on' | 'compare'

/** The harness patterns whose calls produce `reasoning` AND have a twin: the loop
 *  controller (`ControllerAction.reasoning`), the planner (`PlanResult.reasoning`)
 *  and the critic (its trace rides the call record's `parsedOutput.reasoning`,
 *  `CriticResult` has no field of its own). The actor has no twin and keeps its
 *  original function; the describe family is deferred and the screen excluded
 *  (G19 Q2). Pinned equal to the package's twin table by `eval-thinking.test.ts`. */
export const EVAL_REASONING_PATTERNS = ['controller', 'critic', 'planner'] as const

/** The BAML functions those patterns select when thinking is on. */
export const THINKING_TWINS: readonly string[] = [
  'ControllerThinking',
  'CriticThinking',
  'PlannerThinking',
]

/** Every function whose call record can carry `reasoning`: the twins and the
 *  originals they replace, plus the actor (which keeps its original in both modes,
 *  so its model-written reasoning is in both columns). */
const REASONING_FUNCTIONS: readonly string[] = [
  ...THINKING_TWINS,
  'LoopController',
  'ActorController',
  'Critic',
  'Planner',
]

export function parseThinking(env: Record<string, string | undefined>): ThinkingSelection {
  const raw = env[THINKING_ENV]
  const inherited = env[REASONING_ROLES_ENV]
  if (inherited !== undefined && inherited.trim() !== '')
    throw new Error(
      `${REASONING_ROLES_ENV} is set in the eval's environment; the eval owns that setting ` +
        `(use ${THINKING_ENV}=on|compare) so a row's thinking label is never a guess`,
    )
  if (raw === undefined || raw === '' || raw === 'off') return 'off'
  if (raw === 'on' || raw === 'compare') return raw
  throw new Error(`${THINKING_ENV} must be off, on or compare (default off); got '${raw}'`)
}

export function thinkingModes(selection: ThinkingSelection): ThinkingMode[] {
  return selection === 'compare' ? ['off', 'on'] : [selection]
}

/** The reasoning setting a mode runs under: the empty string (the unset posture,
 *  byte-identical routing) for `off`, the three twin patterns for `on`. */
export function reasoningRolesFor(mode: ThinkingMode): string {
  return mode === 'on' ? EVAL_REASONING_PATTERNS.join(',') : ''
}

/** Sets the mode's reasoning setting in `env` and returns the function that restores
 *  the previous value (or its absence). The setting is read per call by the routing
 *  seam, so the calls made between the two are exactly the ones the mode scopes. The
 *  runner calls the restore in a `finally`, so a throw cannot leak a mode into the next
 *  scenario. */
export function enterThinking(
  mode: ThinkingMode,
  env: Record<string, string | undefined>,
): () => void {
  const had = Object.prototype.hasOwnProperty.call(env, REASONING_ROLES_ENV)
  const previous = env[REASONING_ROLES_ENV]
  env[REASONING_ROLES_ENV] = reasoningRolesFor(mode)
  return () => {
    if (had) env[REASONING_ROLES_ENV] = previous
    else delete env[REASONING_ROLES_ENV]
  }
}

export interface ReasoningCounts {
  /** Calls of a reasoning-producing function. */
  calls: number
  /** Of those, calls of a thinking twin. A twin that failed and took its one
   *  corrective retry on the original shows as one twin call plus one original. */
  thinkingCalls: number
  /** Characters of `reasoning` across those calls: the parser trace for a twin,
   *  the model-written field for an original. */
  chars: number
  maxChars: number
}

export interface ReasoningSummary extends ReasoningCounts {
  functions: Record<string, ReasoningCounts>
}

const empty = (): ReasoningCounts => ({ calls: 0, thinkingCalls: 0, chars: 0, maxChars: 0 })

function add(into: ReasoningCounts, thinking: boolean, chars: number) {
  into.calls++
  if (thinking) into.thinkingCalls++
  into.chars += chars
  into.maxChars = Math.max(into.maxChars, chars)
}

/** The reasoning a row's turns recorded, read off the call records the events
 *  already carry (`llmCall.functionName` / `parsedOutput.reasoning`). A call record
 *  attached to more than one event is counted once. */
export function reasoningSummary(events: readonly ContextEvent[]): ReasoningSummary {
  const total: ReasoningSummary = { ...empty(), functions: {} }
  const seen = new Set<unknown>()
  for (const event of events) {
    const call = event.llmCall
    if (!call || seen.has(call) || !REASONING_FUNCTIONS.includes(call.functionName)) continue
    seen.add(call)
    const parsed = call.parsedOutput as { reasoning?: unknown } | undefined
    const chars = typeof parsed?.reasoning === 'string' ? parsed.reasoning.length : 0
    const thinking = THINKING_TWINS.includes(call.functionName)
    add(total, thinking, chars)
    add((total.functions[call.functionName] ??= empty()), thinking, chars)
  }
  return total
}

/** The per-mode cell of the comparison table. */
export interface ThinkingCell {
  /** Graded the way the run's exit code grades it (a MUST's 2-of-3 rule included). */
  status: 'pass' | 'fail' | 'gated' | 'stopped'
  attempts: number
  /** Wall-clock of the graded attempts, summed (wake excluded). */
  durationMs: number
  /** The scenario's ledger total for the mode: observer + infrastructure + tail. */
  usd: number
  reasoningChars: number
  maxReasoningChars: number
  thinkingCalls: number
  reasoningCalls: number
}

export interface ThinkingRow {
  scenario: string
  thinking: ThinkingMode
  status: ThinkingCell['status']
  attempt?: number
  durationMs?: number
  reasoning?: ReasoningSummary
}

/** One line per scenario, one cell per mode that ran. `grade` folds a scenario's
 *  attempt statuses into its verdict; `usd` reads the mode's ledger row. */
export function thinkingComparison(
  scenarioIds: readonly string[],
  modes: readonly ThinkingMode[],
  rows: readonly ThinkingRow[],
  grade: (scenario: string, statuses: ThinkingCell['status'][]) => ThinkingCell['status'],
  usd: (scenario: string, mode: ThinkingMode) => number,
): Array<{ scenario: string } & Partial<Record<ThinkingMode, ThinkingCell>>> {
  return scenarioIds.map((scenario) => {
    const line: { scenario: string } & Partial<Record<ThinkingMode, ThinkingCell>> = { scenario }
    for (const mode of modes) {
      const mine = rows.filter((r) => r.scenario === scenario && r.thinking === mode)
      if (mine.length === 0) continue
      const graded = mine.filter((r) => r.attempt !== undefined)
      line[mode] = {
        status: graded.length
          ? grade(
              scenario,
              graded.map((r) => r.status),
            )
          : mine[0].status,
        attempts: graded.length,
        durationMs: mine.reduce((sum, r) => sum + (r.durationMs ?? 0), 0),
        usd: usd(scenario, mode),
        reasoningChars: mine.reduce((sum, r) => sum + (r.reasoning?.chars ?? 0), 0),
        maxReasoningChars: Math.max(0, ...mine.map((r) => r.reasoning?.maxChars ?? 0)),
        thinkingCalls: mine.reduce((sum, r) => sum + (r.reasoning?.thinkingCalls ?? 0), 0),
        reasoningCalls: mine.reduce((sum, r) => sum + (r.reasoning?.calls ?? 0), 0),
      }
    }
    return line
  })
}
