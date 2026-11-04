/**
 * The egress reader's failure direction on the URL interpretation seam
 * (`docs/plan/url-interpretation-seam.md`, slice 1): when the seam cannot read
 * — it throws inside the reader's path — the reader REFUSES the call on both
 * of its URL channels, never passing content unread. The two channels are the
 * given-address/fetch-address comparison (the gate's seam read, slice 3) and
 * the destination-hosts state (`destinationHosts`).
 *
 * A pure seam throws on no real input, so the throw is injected by mocking the
 * seam module for THIS file only: `interpretUrlSpans` throws exactly when the
 * scan found a span, i.e. inside the reader's path for URL-bearing content,
 * and reads normally otherwise, so the gate's setup (a URL-free user message,
 * no results) still builds. The refusal is `check-failed` through the same
 * `egressCheck` catch the gate already owns, so nothing reaches the transport.
 *
 * Every pin names the source mutation that turns it red; the PR records that
 * each was run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// MUTATION: swallow the seam's error inside the reader (wrap the gate's
// `addressSpans` seam read — and `destinationHosts` — in a try/catch that
// returns no addresses): the unread call is dispatched instead of refused,
// and both pins fail.
vi.mock('../url-seam', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../url-seam')>()
  return {
    ...actual,
    interpretUrlSpans: ((text: string, spans, options) => {
      if (spans.length > 0) throw new Error('seam: cannot read')
      return actual.interpretUrlSpans(text, spans, options)
    }) as typeof actual.interpretUrlSpans,
  }
})

import { createContext, createScope } from '../context.server'
import { createEventView } from '../patterns/event-view.server'
import { configurePattern } from '../patterns/chain.server'
import { withEgressGate, type EgressGateConfig } from '../patterns/withEgressGate.server'
import { callTool, EGRESS_CHECK_FAILED } from '../mcp-client.server'
import { registerToolNamespaces } from '../tools.server'
import { withRunFrame } from '../run-frame.server'
import type { ContextEvent, EgressBlockedEventData, ToolCallResult } from '../types'

const CATALOG = ['web_search', 'fetch']

const sent = vi.fn<(name: string, args: Record<string, unknown>) => Promise<ToolCallResult>>()
const transport = {
  id: 'fake',
  ownsTool: () => true,
  callTool: sent,
  listTools: async () => [],
}

let unregister: () => void
beforeEach(() => {
  sent.mockReset()
  sent.mockImplementation(async (name) => ({ success: true, data: `result of ${name}` }))
  unregister = registerToolNamespaces((n) =>
    n === 'web_search' || n === 'fetch' ? 'web' : undefined,
  )
})
afterEach(() => {
  unregister()
  vi.restoreAllMocks()
})

const ofType = <D>(events: ContextEvent[], type: string) =>
  events.filter((e) => e.type === type).map((e) => e.data as D)

/** Run one outgoing call inside a gated probe pattern; return its result and
 *  the scope's events. The user message carries no URL, so the gate's setup
 *  reads normally and only the call's own reading throws. */
async function gatedCall(
  config: Partial<EgressGateConfig>,
  name: string,
  args: Record<string, unknown>,
) {
  let result: ToolCallResult | undefined
  const ctx = createContext('Find public news about solar panels')
  const probe = configurePattern(
    'probe',
    async (s) => {
      result = await callTool(name, args)
      return s
    },
    { patternId: 'probe' },
  )
  const gated = withEgressGate({ local: [], catalog: CATALOG, ...config })(probe)
  const scope = createScope('probe', {})
  await withRunFrame({ transports: [transport] }, () => gated.fn(scope, createEventView(ctx)))
  return { result, events: scope.events }
}

describe('the reader refuses when the seam cannot read (both channels)', () => {
  it('the address channel: a fetch call is refused, never passed unread', async () => {
    // The leaf is under a `target` key, not `url`: the url-key fallback
    // would still refuse the whole value after a swallowed read, while a
    // non-url leaf the reader cannot read is passed unread exactly when the
    // seam's error is swallowed.
    const { result, events } = await gatedCall(
      { fetchTools: ['fetch'], addressSources: ['web'] },
      'fetch',
      { target: 'https://docs.example/guide' },
    )
    expect(result).toMatchObject({ success: false, error: EGRESS_CHECK_FAILED })
    expect(sent).not.toHaveBeenCalled()
    expect(ofType<EgressBlockedEventData>(events, 'egress_blocked')).toEqual([
      { tool: 'fetch', route: null, rule: 'check-failed' },
    ])
  })

  it('the hosts channel: a call the destination state cannot read is refused, never passed unread', async () => {
    const { result, events } = await gatedCall({}, 'web_search', {
      query: 'see https://a.example/x for news',
    })
    expect(result).toMatchObject({ success: false, error: EGRESS_CHECK_FAILED })
    expect(sent).not.toHaveBeenCalled()
    expect(ofType<EgressBlockedEventData>(events, 'egress_blocked')).toEqual([
      { tool: 'web_search', route: null, rule: 'check-failed' },
    ])
  })
})
