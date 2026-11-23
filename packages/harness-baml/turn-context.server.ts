/** The uncached per-turn tail. The existing optional `current_time` BAML slot
 * already renders opaque text after every cache marker; reuse that channel
 * for host identity too, without changing positional function signatures.
 * No organisation preserves the clock-only prompt byte for byte. */
import { currentRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import { formatOrganisationBlock } from '@hames-ai/harness-patterns/organisation'
import { currentTimeBlock } from './time-block.server'

export function currentTurnContext(): string | null {
  return (
    [currentTimeBlock(), formatOrganisationBlock(currentRunFrame()?.organisation)]
      .filter(Boolean)
      .join('\n\n') || null
  )
}
