/**
 * The two BAML shape builders `end-to-end.test.ts` drives its scripted actor
 * and critic with.
 *
 * Copied (not imported) from the app's `src/__tests__/mocks/baml.ts` at the
 * @hames-ai/sandbox extraction: a package whose suite reaches back into the host's
 * test tree is not independently shippable, which is the whole point of
 * co-locating the tests here. Only the two builders that file actually uses
 * came across — the mock BAML client and collector stayed app-side with the
 * suites that use them.
 *
 * The types come from `@hames-ai/harness-patterns`, which re-exports the generated
 * BAML shapes, rather than from a `baml_client` path this package has no
 * business naming.
 */
import type { ControllerAction, CriticResult } from '@hames-ai/harness-patterns/types'

/** A `ControllerAction` with every required field filled in. */
export function mockAction(overrides?: Partial<ControllerAction>): ControllerAction {
  return {
    reasoning: 'Test reasoning',
    tool_name: 'test_tool',
    tool_args: '{}',
    status: 'success',
    is_final: false,
    ...overrides,
  }
}

/** A `CriticResult` that accepts unless told otherwise. */
export function mockCriticResult(overrides?: Partial<CriticResult>): CriticResult {
  return {
    is_sufficient: true,
    explanation: 'Result is sufficient',
    suggested_approach: undefined,
    ...overrides,
  }
}
