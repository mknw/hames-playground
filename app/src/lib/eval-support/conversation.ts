import type { ContextEvent } from '@hames-ai/harness-patterns'
export interface Check {
  name: string
  pass: boolean
  detail: string
}
import type { SpendKey } from './spend-budget'
import type { ArgsPredicate } from './tool-arguments'

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
  forbiddenTools: string[]
  maxIterations: number
  failFirstTurn?: boolean
  noTools?: boolean
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
}

export interface ConversationDriver {
  run(scenario: ConversationScenario, key: SpendKey): Promise<ConversationTrace>
  close(): Promise<void>
}
