/**
 * The contrastive NEGATIVE few-shot for envelope discipline (#606 gate, runs 3
 * and 4): sandbox few-shots rendered into an actor-critic
 * prompt, controller AND actor turns leaked the model's NATIVE function-call
 * syntax instead of the JSON envelope the harness parses. One shot carries the
 * contrast: the user line labels the malformed native form WRONG with the
 * one-line reason, and the record's own envelope is the SAME call in the
 * correct shape — so wrong and right sit adjacent in the rendered EXAMPLES
 * (FewShot has no wrong-example field; nothing new was invented).
 *
 * Used by `general-next.server.ts` (OFFICE_FEW_SHOTS). The negative is
 * format-level and scenario-agnostic by construction.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import type { FewShot } from '@hames-ai/harness-patterns/types'

assertServerOnImport()

export const ENVELOPE_NEGATIVE_SHOT: FewShot = {
  user:
    'WRONG FORMAT — never emit native tool-call syntax like ' +
    '<function=sandbox_bash><parameter=command>ls /work/in</parameter></function>: ' +
    'the harness parses the JSON envelope only; native tool-call syntax is never valid here. ' +
    'The same call in the only correct shape:',
  reasoning:
    'tool_args is a STRING containing JSON with keys double-quoted; the JSON envelope below is the only form the harness parses.',
  tool: 'sandbox_bash',
  args: JSON.stringify({ command: 'ls /work/in' }),
}
