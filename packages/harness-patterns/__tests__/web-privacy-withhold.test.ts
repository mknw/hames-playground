/**
 * K5's withheld warning (boundary guards): when the privacy filter cannot be
 * built, the step runs without earlier content, and the `web_privacy` warning
 * says why and how much was withheld. The reason comes from a fixed set — a
 * host names one through `RosterUnavailable`, anything else is `filter-failed`
 * — so no exception text reaches the store. The fakes throw person-bearing
 * messages, so the leak-free catch is exercised rather than assumed.
 */
import { describe, expect, it } from 'vitest'
import { createContext, createEvent, createScope } from '../context.server'
import { configurePattern } from '../patterns/chain.server'
import { createEventView } from '../patterns/event-view.server'
import {
  RosterUnavailable,
  WEB_ROSTER_INPUT,
  withPseudonymisedInputs,
  type PseudonymiseForWeb,
} from '../patterns/withPseudonymisedInputs.server'
import { withRunFrame } from '../run-frame.server'
import type { ContextEvent, WarningEventData } from '../types'

const PERSON = 'Ravi Example'

async function run(pseudonymise: PseudonymiseForWeb | undefined) {
  const ctx = createContext('Find public news about solar panels')
  ctx.events.push(
    createEvent('assistant_message', 'probe', { content: `an earlier answer about ${PERSON}` }),
    createEvent('tool_result', 'probe', { tool: 'web_search', success: true, data: PERSON }),
  )
  let seen: ContextEvent[] = []
  let data: Record<string, unknown> = {}
  const probe = configurePattern('probe', async (scope, view) => {
    seen = view.get()
    data = { ...scope.data }
    return scope
  })
  const scope = createScope('probe', {
    plan: { reasoning: '', plan: `ask ${PERSON}`, n_steps: 1 },
    conversation: `User: who is ${PERSON}?`,
    [WEB_ROSTER_INPUT]: { payloads: [], steps: 'Steps so far: 1' },
  } as never)
  await withRunFrame({ inference: { tier: 'self_deployed' } }, () =>
    withPseudonymisedInputs({ pseudonymise })(probe).fn(scope, createEventView(ctx)),
  )
  const warnings = scope.events
    .filter((e) => e.type === 'warning')
    .map((e) => e.data as WarningEventData)
  return { scope, seen, data, warnings }
}

const throwing =
  (error: () => unknown): PseudonymiseForWeb =>
  async () => {
    throw error()
  }

describe("K5's withheld warning", () => {
  // MUTATION: drop `detail` from the warning; count after `scope.data` is
  // replaced (fields 1, the handoff alone); or count the whole context instead
  // of the child's view (events 3, the latest user message included).
  it('says why and how much: not-configured, 2 earlier events, 2 data fields', async () => {
    const { warnings, seen, data } = await run(undefined)
    expect(warnings).toEqual([
      {
        task: 'web_privacy',
        message: 'earlier results withheld: privacy filter unavailable',
        fallback: 'This step ran without earlier results.',
        detail: { reason: 'not-configured', events: 2, fields: 2 },
      },
    ])
    expect(seen.map((e) => e.type)).toEqual(['user_message'])
    expect(data).toEqual({ handoff: 'Steps so far: 1' })
  })

  // MUTATION: drop the `instanceof RosterUnavailable` branch (every reason reads
  // filter-failed); or keep the error's message or name: the person leaks.
  it.each(['directory-empty', 'directory-unreadable', 'roster-damaged'] as const)(
    'a host RosterUnavailable(%s) is the reason, and nothing the error carries is kept',
    async (reason) => {
      const { scope, warnings } = await run(
        throwing(() => Object.assign(new RosterUnavailable(reason), { message: PERSON })),
      )
      expect(warnings.map((w) => w.detail?.reason)).toEqual([reason])
      expect(JSON.stringify(scope.events)).not.toMatch(/Ravi|RosterUnavailable/)
    },
  )

  // MUTATION: drop the fixed-set check (`ROSTER_REASONS.has`): a reason cast
  // past the type carries the person into the store.
  it('any other failure is filter-failed, including a RosterUnavailable with a forged reason', async () => {
    for (const error of [
      () => new Error(`${PERSON} could not be read`),
      () => Object.assign(new Error('x'), { name: PERSON, reason: 'directory-empty' }),
      () => new RosterUnavailable(PERSON as never),
      () => PERSON,
    ]) {
      const { scope, warnings } = await run(throwing(error))
      expect(warnings.map((w) => w.detail?.reason)).toEqual(['filter-failed'])
      expect(JSON.stringify(scope.events)).not.toContain('Ravi')
    }
  })

  // MUTATION: record the warning on success too.
  it('a filter that builds withholds nothing and warns nothing', async () => {
    const identity = <V>(value: V): V => value
    const { warnings, seen } = await run(async () => ({
      apply: identity,
      redact: identity,
      checkLiterals: () => undefined,
    }))
    expect(warnings).toEqual([])
    expect(seen.map((e) => e.type)).toEqual(['user_message', 'assistant_message', 'tool_result'])
  })
})
