/**
 * ControllerAction normalisation — the single place an LLM-produced action is
 * given its documented defaults before any pattern reads it.
 *
 * Pure (no server imports) so both loop patterns and the tests can use it.
 */

import type { ControllerAction } from '../../../baml_client/types'

/**
 * Fill `is_final` when the model omitted it.
 *
 * `is_final` is `bool?` in `types.baml` (#159): required, its omission threw
 * away otherwise-perfect turns with `BamlValidationError: Missing required
 * field: is_final` — three times now for three different fields of this one
 * class. The full rationale lives on the field in `types.baml`; the short
 * version is that the field's only demonstration anywhere in the prompt is the
 * literal `false` the turn log renders, so a turn-0 call with no history has
 * nothing but `ctx.output_format` to go on.
 *
 * The default is FALSE and nothing else could be: absence must never be able to
 * end a loop or claim finality. simpleLoop keeps `tool_name === 'Return'` as an
 * independent terminal signal, so a model that means to finish still can; and
 * actorCritic's `is_final === true` only triggers the critic, which owns exit
 * either way.
 *
 * Normalising here rather than leaving `undefined` to fall through keeps the
 * runtime shape of an action complete for everything downstream of the loop —
 * the `controller_action` event and its UI readers, the compactExecution's iteration
 * log, and `ActorAttemptLog`, which renders the recorded action back into the
 * actor's own prompt history (where a `null` would demonstrate a third value
 * for a boolean field).
 *
 * Returns the same object when nothing needs filling, so the common path
 * allocates nothing.
 */
export function normalizeControllerAction(action: ControllerAction): ControllerAction {
  if (action.is_final === undefined || action.is_final === null) {
    return { ...action, is_final: false }
  }
  return action
}
