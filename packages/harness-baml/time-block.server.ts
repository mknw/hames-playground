/**
 * The turn's time block, as the BAML adapters pass it — `current_time` on
 * Router, LoopController / ControllerThinking, ActorController, Planner /
 * PlannerThinking and Synthesize.
 *
 * Read from the run frame's clock (`RunFrame.clock`, which the host supplies
 * once per turn) and rendered by core's `formatTimeBlock`, so every call in one
 * turn passes the same bytes. Memoized per clock object, which is the "computed
 * once per turn" half: the frame holds one clock for the whole turn. No clock —
 * a script, an eval or a test that opened a bare frame — passes `null`, and the
 * templates render nothing.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { formatTimeBlock, type TurnClock } from '@hames-ai/harness-patterns/clock'
import { currentClock } from '@hames-ai/harness-patterns/run-frame.server'

assertServerOnImport()

const rendered = new WeakMap<TurnClock, string>()

export function currentTimeBlock(): string | null {
  const clock = currentClock()
  if (!clock) return null
  let block = rendered.get(clock)
  if (block === undefined) {
    block = formatTimeBlock(clock)
    rendered.set(clock, block)
  }
  return block
}
