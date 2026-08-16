/**
 * BAML Mock Helpers
 *
 * Mock factories for BAML client functions.
 */

import { vi } from 'vitest'
import type { ControllerAction, CriticResult } from '../../../baml_client/types'

// ============================================================================
// Mock Action Factories
// ============================================================================

/**
 * Create a mock ControllerAction.
 */
export function mockAction(overrides?: Partial<ControllerAction>): ControllerAction {
  return {
    reasoning: 'Test reasoning',
    tool_name: 'test_tool',
    tool_args: '{}',
    status: 'success',
    is_final: false,
    ...overrides
  }
}

/**
 * Create a mock final action (Return action).
 */
export function mockFinalAction(response = 'Done'): ControllerAction {
  return mockAction({
    tool_name: 'Return',
    tool_args: JSON.stringify({ response }),
    is_final: true
  })
}

/**
 * Create a mock CriticResult.
 */
export function mockCriticResult(overrides?: Partial<CriticResult>): CriticResult {
  return {
    is_sufficient: true,
    explanation: 'Result is sufficient',
    suggested_approach: undefined,
    ...overrides
  }
}

// ============================================================================
// Mock BAML Client
// ============================================================================

export interface MockBAMLClientOptions {
  /** Sequence of actions for LoopController to return */
  loopActions?: ControllerAction[]
  /** Sequence of actions for ActorController to return */
  actorActions?: ControllerAction[]
  /** Sequence of results for Critic to return */
  criticResults?: CriticResult[]
  /** Router result */
  routerResult?: { intent: string; needs_tool: boolean; route: string | null; response: string }
  /** Synthesize result */
  synthesizeResult?: string
  /** ResultDescribe result */
  resultDescribeResult?: string
}

/**
 * Create a mock BAML client with configurable behavior.
 */
export function mockBAMLClient(options: MockBAMLClientOptions = {}) {
  let loopIndex = 0
  let actorIndex = 0
  let criticIndex = 0

  const defaultLoopActions = [mockFinalAction()]
  const defaultActorActions = [mockFinalAction()]
  const defaultCriticResults = [mockCriticResult()]

  return {
    LoopController: vi.fn(async () => {
      const actions = options.loopActions ?? defaultLoopActions
      return actions[loopIndex++] ?? mockFinalAction()
    }),

    ActorController: vi.fn(async () => {
      const actions = options.actorActions ?? defaultActorActions
      return actions[actorIndex++] ?? mockFinalAction()
    }),

    Critic: vi.fn(async () => {
      const results = options.criticResults ?? defaultCriticResults
      return results[criticIndex++] ?? mockCriticResult()
    }),

    Router: vi.fn(async () => {
      return options.routerResult ?? {
        intent: 'test intent',
        needs_tool: true,
        route: 'neo4j',
        response: ''
      }
    }),

    Synthesize: vi.fn(async () => {
      return options.synthesizeResult ?? 'Synthesized response'
    }),

    ResultDescribe: vi.fn(async () => {
      return options.resultDescribeResult ?? 'Tool result summary'
    })
  }
}

// ============================================================================
// Mock Collector
// ============================================================================

export interface MockCollectorLog {
  rawLlmResponse?: string
  usage?: { inputTokens: number; outputTokens: number }
  calls?: Array<{ httpRequest?: { body: unknown } }>
}

/**
 * Create a mock BAML Collector.
 */
export function mockCollector(lastLog?: MockCollectorLog) {
  return {
    last: lastLog ?? {
      rawLlmResponse: 'Raw LLM response',
      usage: { inputTokens: 100, outputTokens: 50 },
      calls: [{ httpRequest: { body: { messages: [] } } }]
    }
  }
}
