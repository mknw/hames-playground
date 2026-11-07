/**
 * Fix round 1, term 2 (review of #1019): the re-dispatch of a released held
 * call — simpleLoop's `again` path (slice 10) — carries the #1018
 * newline-escape fix on its failure. That dispatch is the held call's FIRST
 * execution, so no other path could have reached the guidance to it; this test
 * is the one that discriminates that wiring.
 *
 * Mutation: neutralise `againFix` (`const againFix = undefined` in the `again`
 * branch of `patterns/simpleLoop.server.ts`) → red: the turn log the next
 * controller turn reads shows the bare syntax error, and the recovery records
 * no `feedback`.
 */

import { describe, expect, it, vi } from 'vitest'
import { harness, resumeHarness } from '../harness.server'
import { askHumanHolding, held, readHitl } from '../hitl.server'
import { simpleLoop } from '../patterns/simpleLoop.server'
import type { RunFrame } from '../run-frame.server'
import type {
  ControllerFn,
  ControllerInput,
  ContextEvent,
  HitlOption,
  HitlPayloadStore,
  HoldingOutcome,
  LoopRecoveryEventData,
  ToolResultEventData,
} from '../types'
import type { ToolTransport } from '../tool-transport.server'

const SYNTAX_ERROR = 'SyntaxError: unterminated string literal (detected at line 1)'
const FIX = 'escape the backslash'

const OPTIONS: HitlOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject', unattended: true },
]
const REQUEST = {
  kind: 'graph-write',
  question: 'Change the knowledge graph?',
  options: OPTIONS,
  defaultOption: 'reject',
  summary: { count: 1 },
} as const

/** An in-memory store with the host's contract (as `hitl-holding.test`). */
function memoryStore(): HitlPayloadStore {
  const rows = new Map<string, { ref: string; kind: string; json: string }>()
  let n = 0
  return {
    hold: async ({ callKey, kind, payload }) => {
      const json = JSON.stringify(payload)
      const row = rows.get(callKey)
      if (!row) {
        const ref = `ref-${++n}`
        rows.set(callKey, { ref, kind, json })
        return { payloadRef: ref, inserted: true }
      }
      return row.kind === kind && row.json === json
        ? { payloadRef: row.ref, inserted: false }
        : { rebound: true }
    },
    drop: async (ref) => {
      rows.delete(ref)
    },
  }
}

/** `gated_write` holds for a person; once released, the call RUNS — and fails
 *  with the newline signature, the failure the fix is for. */
function releasingTransport(outcomes: HoldingOutcome[]): ToolTransport {
  return {
    id: 'holding',
    ownsTool: (name: string) => name === 'gated_write',
    callTool: async (_name: string, args: Record<string, unknown>) => {
      const outcome = await askHumanHolding(REQUEST, args)
      outcomes.push(outcome)
      if (outcome.status === 'rebound') return { success: false, data: null, error: 'rebound' }
      return outcome.status === 'pending'
        ? {
            success: true,
            data: { ...held(outcome), note: 'waiting', redispatch: true as const },
          }
        : { success: false, data: null, error: SYNTAX_ERROR }
    },
    listTools: async () => [],
  }
}

describe('simpleLoop: a released held call that fails carries the #1018 fix', () => {
  it('the next controller turn reads the fix from the re-dispatched round', async () => {
    const outcomes: HoldingOutcome[] = []
    const store = memoryStore()
    const inputs: ControllerInput[] = []
    const controller = vi.fn<ControllerFn>(async (input) => {
      inputs.push(input)
      return input.turn === 0
        ? {
            action: {
              reasoning: 'write it',
              tool_name: 'gated_write',
              // The captured #1018 shape, decoded: a raw break inside a
              // single-quoted literal.
              tool_args: JSON.stringify({ code: "text = '\n'.join(rows)" }),
              status: '',
              is_final: false,
            },
          }
        : {
            action: {
              reasoning: 'report',
              tool_name: 'Return',
              tool_args: JSON.stringify({ response: 'done' }),
              status: '',
              is_final: true,
            },
          }
    })
    const patterns = [
      simpleLoop<Record<string, unknown>>(controller, ['gated_write'], {
        patternId: 'work',
        maxTurns: 4,
      }),
    ]
    const frame: RunFrame = { transports: [releasingTransport(outcomes)], hitlPayloads: store }

    const paused = await harness<Record<string, unknown>>(...patterns)(
      'change it',
      'sess-hold',
      undefined,
      undefined,
      frame,
    )
    expect(paused.status).toBe('paused')
    const [request] = readHitl(paused.context).pending
    const resumed = await resumeHarness<Record<string, unknown>>(
      paused.serialized,
      patterns,
      { [request.requestId]: 'approve' },
      { frame },
    )
    expect(resumed.status).not.toBe('paused')
    // The released call ran again (the transport's answered branch), failed,
    // and the loop went on to the Return.
    expect(inputs).toHaveLength(2)
    expect(inputs[1].turn).toBe(1)

    // The re-dispatched round's entry carries the fix.
    const seen = inputs[1].turns[0]
    expect(seen.tool_result?.error).toContain('unterminated string literal')
    expect(seen.tool_result?.error).toContain(FIX)

    // The recovery records the same text as its `feedback` — a later resume
    // replays it.
    const recoveries = resumed.context.events
      .filter((e: ContextEvent) => e.type === 'loop_recovery')
      .map((e) => e.data as LoopRecoveryEventData)
    expect(recoveries.at(-1)).toMatchObject({ failure: 'tool_error', error: SYNTAX_ERROR })
    expect(recoveries.at(-1)?.feedback).toContain(FIX)

    // The committed tool_result event keeps the error verbatim.
    const resultEvents = resumed.context.events.filter((e) => e.type === 'tool_result')
    const last = resultEvents.at(-1)!.data as ToolResultEventData
    expect(last.error).toBe(SYNTAX_ERROR)
  })
})
