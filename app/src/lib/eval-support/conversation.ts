import type { ContextEvent } from '@hames-ai/harness-patterns'
export interface Check {
  name: string
  pass: boolean
  detail: string
}
import type { SpendKey } from './spend-budget'
import type { ArgsPredicate } from './tool-arguments'
import type { GuardTurnCounts } from './guard-report'

export interface ConversationScenario {
  id: string
  title: string
  priority: 'must' | 'should' | 'nice'
  baseline: boolean
  p4: boolean
  messages: string[]
  expectedTools: string[]
  expectedArgs?: Record<string, ArgsPredicate>
  expectedRoutes: string[]
  answerIncludes: string[]
  artifacts: string[]
  /** What a real run of the task leaves behind in the synthetic sandbox: the stdout its
   * script prints and the content of each artifact. Default stdout names the saved paths. */
  sandboxRun?: { stdout: string; files?: Record<string, string> }
  /** A deliverable that is a transcription, not a computation: the file may be produced
   * by `sandbox_write` to `/work/out/<name>` instead of a `sandbox_bash` run, because
   * production promotes any file under `/work/out` at turn exit. Maps each such file to
   * the predicate its written bytes must meet; only these files, and only this way, are
   * credited. Absent = `sandbox_bash` is the only acceptable producer (a computation). */
  writtenArtifacts?: Record<string, (content: string) => boolean>
  forbiddenTools: string[]
  maxIterations: number
  failFirstTurn?: boolean
  noTools?: boolean
  /** Runs with the synthetic owner-scoped per-user memory (`synthetic-memory.ts`); absent = memory off. */
  memory?: boolean
  /** A must whose acceptance run is pending: the flip gate lists it in the report
   * (with this issue number) but does not block the flip on it. Pinned by PENDING_MUSTS
   * in flip-gate.ts and the pin test in flip-gate.test.ts. */
  pendingMustIssue?: number
  turnAnswerIncludes?: string[][]
  citation?: string
  indexed?: string
}

export interface ConversationTrace {
  turns: Array<{ response: string; status: string; events: ContextEvent[] }>
  tools: Array<{
    name: string
    args: Record<string, unknown>
    success: boolean
    turn: number
    /** Set by the synthetic sandbox: the request, with the scripts it ran, met the scenario's predicate. */
    valid?: boolean
  }>
  artifacts: string[]
  indexed: string[]
  retrievals: Array<{ source: string; turn: number }>
}

export interface ConversationResult extends SpendKey {
  status: 'pass' | 'fail' | 'gated' | 'stopped'
  checks: Check[]
  error?: string
  /** Per-turn guard counts (boundary guards slice 7), computed from the turn's
   *  own events; present whenever a trace came back. */
  guards?: GuardTurnCounts[]
  /** 1-based attempt number of a graded run (#842): absent on a row that was never run
   * (gated, stopped, not run) or that failed before any attempt could be graded. */
  attempt?: number
}

export interface ConversationDriver {
  run(scenario: ConversationScenario, key: SpendKey): Promise<ConversationTrace>
  close(): Promise<void>
  /** The guards' bag the driver's agent ran with (`guardConfig()`'s three
   *  settings, #844, read once here): the runner counts skips against the τi
   *  the run actually used, never a second env read (#845 review). */
  guards: {
    gateThreshold: number
    egressThreshold: number
    maxOutgoingRetriesPostTripwire: number
  }
}
