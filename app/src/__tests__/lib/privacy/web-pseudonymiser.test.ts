/** #507 S7, layer 1. Real wrappers, loops, host factory and callTool; only
 *  directory I/O and transports are fakes. Red mutations are recorded on the PR. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
vi.mock('../../../lib/org-graph/roster-source.server', () => ({ loadDirectoryRoster: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = vi.fn()
    close = vi.fn()
    listTools = async () => ({ tools: [] })
    callTool = () => {
      throw new Error('No gateway call permitted')
    }
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}))

import { createWebPseudonymiser } from '../../../lib/harness-client/web-pseudonymiser.server'
import { loadDirectoryRoster } from '../../../lib/org-graph/roster-source.server'
import * as roster from '../../../lib/privacy/graph-roster'
import * as pseudonym from '../../../lib/privacy/pseudonymise'
import { shapeMessages } from '@hames-ai/connectors/graph/graph-tools.server'
import { spotlight, applyScreenVerdict } from '@hames-ai/harness-patterns/guard'
import {
  createContext,
  createEvent,
  createScope,
  trackEvent,
} from '@hames-ai/harness-patterns/context.server'
import { createEventView } from '@hames-ai/harness-patterns/patterns/event-view.server'
import { configurePattern, runChain } from '@hames-ai/harness-patterns/patterns/chain.server'
import { simpleLoop } from '@hames-ai/harness-patterns/patterns/simpleLoop.server'
import { actorCritic } from '@hames-ai/harness-patterns/patterns/actorCritic.server'
import { planner } from '@hames-ai/harness-patterns/patterns/planner.server'
import { decisionLoop } from '@hames-ai/harness-patterns/patterns/decisionLoop.server'
import { withInjectionGuard } from '@hames-ai/harness-patterns/patterns/withInjectionGuard.server'
import {
  withReferences,
  __clearReferenceCache,
} from '@hames-ai/harness-patterns/patterns/with-references.server'
import {
  WEB_ROSTER_INPUT,
  withPseudonymisedInputs,
  type PseudonymiseForWeb,
} from '@hames-ai/harness-patterns/patterns/withPseudonymisedInputs.server'
import {
  withRunFrame,
  amendRunFrame,
  activeRunFrame,
  type RunFrame,
} from '@hames-ai/harness-patterns/run-frame.server'
import { callTool, closeMcpClient } from '@hames-ai/harness-patterns/mcp-client.server'
import { registerToolNamespaces } from '@hames-ai/harness-patterns/tools.server'
import type {
  ConfiguredPattern,
  ControllerFn,
  ControllerInput,
  DecideFn,
  DecisionSpec,
  EventView,
  PatternScope,
  SelectorFn,
  ToolCallResult,
  UnifiedContext,
} from '@hames-ai/harness-patterns/types'
import type { DecisionLoopData } from '@hames-ai/harness-patterns/patterns/decisionLoop.server'

type Data = DecisionLoopData & Record<string, unknown>
const DIRECTORY = { displayName: 'Mira Cedar', mail: 'mira.cedar@example.test' }
const EXTERNAL = { name: 'Otto Willow', address: 'otto.willow@outside.test' }
const MAIL = {
  from: { emailAddress: EXTERNAL },
  body: { content: `Message from ${EXTERNAL.name}` },
}
const GRAPH = {
  organizer: { emailAddress: { name: 'Lena Birch', address: 'lena.birch@example.test' } },
  body: 'Lena Birch met Mira Cedar.',
}
const USER = 'Look up Mira Cedar as I explicitly request; compare the report.'
const outgoing = vi.fn<(name: string, args: Record<string, unknown>) => Promise<ToolCallResult>>(
  async () => ({
    success: true,
    data: 'public result',
  }),
)
const transport = {
  id: 'synthetic',
  ownsTool: () => true,
  callTool: outgoing,
  listTools: async () => [],
}
let unregister: () => void
beforeEach(() => {
  vi.restoreAllMocks()
  outgoing.mockClear()
  vi.mocked(loadDirectoryRoster).mockResolvedValue([DIRECTORY])
  __clearReferenceCache()
  unregister = registerToolNamespaces(
    (n) => ({ fetch: 'web', web_search: 'web', read_neo4j_cypher: 'neo4j' })[n],
  )
})
afterEach(async () => {
  unregister()
  await closeMcpClient()
})

const frame = (tier?: string): RunFrame => ({
  inference: tier === undefined ? undefined : { tier },
  transports: [transport],
})
const result = (id: string, payload: unknown, summary: string) => ({
  ...createEvent('tool_result', 'retriever', {
    tool: 'retriever',
    result: payload,
    summary,
    success: true,
  }),
  id,
})

/** Read real previews and then a real expansion in the loop's next prompt. */
async function referencesRun(
  pseudonymise: PseudonymiseForWeb | undefined,
  tier: string | undefined = 'verda',
) {
  const ctx = createContext<Data>(USER)
  // An earlier user message is rewritten too; only the latest is exempt.
  ctx.events.unshift(createEvent('user_message', 'harness', { content: 'Earlier: Mira Cedar' }))
  ctx.events.push(
    result('graph-ref', GRAPH, 'Lena Birch met Mira Cedar.'),
    result('prose-ref', { text: 'Mira Cedar has a report.' }, 'Mira Cedar report.'),
  )
  ctx.events.push(
    createEvent('content_sanitized', 'retriever', {
      findings: [{ match: 'AUDIT_ONLY_RAW', from: { emailAddress: EXTERNAL } }],
    }),
  )
  const original = JSON.stringify(ctx.events)
  const seen: ControllerInput[] = []
  const selector: SelectorFn = async ({ candidates, recentMessages }) => {
    expect(JSON.stringify(recentMessages)).toContain(USER)
    return {
      selected: candidates.map((c) => ({ ref_id: c.ref_id, reason: 'relevant' })),
      reasoning: 'all',
    }
  }
  const controller: ControllerFn = async (input) => {
    seen.push(structuredClone(input))
    return {
      action: {
        reasoning: 'synthetic',
        tool_name: seen.length === 1 ? 'expandPreviousResult' : 'Return',
        tool_args: seen.length === 1 ? 'ref:graph-ref' : 'done',
        is_final: seen.length > 1,
      },
    }
  }
  const inner = simpleLoop<Data>(controller, [], {
    patternId: 'info',
    rememberPriorTurns: false,
    maxTurns: 3,
    viewConfig: { fromLast: false, fromLastNTurns: 1 },
  })
  const refs = withReferences(inner, {
    selector,
    source: ['retriever', 'info'],
    viewConfig: { fromLast: false, fromLastNTurns: 1 },
  })
  const wrapped = withPseudonymisedInputs({ pseudonymise })(refs)
  const scope = createScope<Data>('info-wrapper', {
    [WEB_ROSTER_INPUT]: {
      payloads: [MAIL],
      steps: 'Steps so far:\n1. office-data — succeeded (1 tool call)',
    },
    plan: { reasoning: '', plan: 'Ask Otto Willow', n_steps: 1 },
    handoff: 'Earlier mail from Otto Willow: useful body',
  })
  await withRunFrame(frame(tier), () =>
    wrapped.fn(scope, createEventView(ctx, { fromLast: false })),
  )
  expect(JSON.stringify(ctx.events)).toBe(original)
  expect(scope.data).not.toHaveProperty(WEB_ROSTER_INPUT)
  return { seen, scope, wrapped, inner, refs }
}

describe('web input copies (G14)', () => {
  // Mutation: drop apply, or leave expansion's backing context in clear.
  it('rewrites Graph identities and directory-only prose in previews AND expansion; latest user stays exact', async () => {
    const host = vi.fn(createWebPseudonymiser())
    const { seen, wrapped, refs } = await referencesRun(host)
    expect(JSON.stringify(host.mock.calls[0][0])).not.toContain('AUDIT_ONLY_RAW')
    expect(seen).toHaveLength(2)
    expect(seen[0].userMessage).toBe(USER)
    const previews = JSON.stringify(seen[0].priorResults)
    expect(previews).toContain('PERSON_1')
    expect(previews).toContain('PERSON_2')
    expect(previews).not.toMatch(/Mira Cedar|Lena Birch/)
    const expansion = JSON.stringify(seen[1].turns)
    expect(expansion).toContain('PERSON_2_EMAIL')
    expect(expansion).toContain('PERSON_1')
    expect(expansion).not.toMatch(/Mira Cedar|Lena Birch|lena\.birch@/)
    expect(wrapped.config).toBe(refs.config)
    expect(wrapped.children).toEqual([refs])
  })

  // D2 mutation: use a positive private-tier match instead.
  it.each([undefined, 'unknown-tier'])('rewrites when the raw tier is %s', async (tier) => {
    // referencesRun defaults undefined; use a bare frame to exercise no slot.
    const ctx = createContext<Data>('task')
    ctx.events.push(result('r', GRAPH, 'Mira Cedar'))
    let observed = ''
    const child = configurePattern<Data>('probe', async (s, v) => {
      observed = v.unfiltered().serialize()
      expect(s.data).not.toHaveProperty(WEB_ROSTER_INPUT)
      return s
    })
    const wrapped = withPseudonymisedInputs({ pseudonymise: createWebPseudonymiser() })(child)
    await withRunFrame(frame(tier), () =>
      wrapped.fn(
        createScope('probe', { [WEB_ROSTER_INPUT]: { payloads: [], steps: '' } }),
        createEventView(ctx),
      ),
    )
    expect(observed).toContain('PERSON_1')
    expect(observed).not.toContain('Mira Cedar')
  })

  it('explicit Anthropic keeps the existing input behaviour, but consumes the roster key (E2)', async () => {
    const host = vi.fn(createWebPseudonymiser())
    const { seen } = await referencesRun(host, 'anthropic')
    expect(host).not.toHaveBeenCalled()
    expect(JSON.stringify(seen[0].priorResults)).toContain('Mira Cedar')
    expect(JSON.stringify(seen[1].turns)).toContain('Lena Birch')
    expect(seen[0].planContext).toContain('Otto Willow')
  })
})

const choice = (script: string[]): DecideFn => {
  let n = 0
  return Object.assign(
    async ({ spec }: Parameters<DecideFn>[0]) => {
      const label = script[n++] ?? 'answer'
      return {
        probs: Object.fromEntries(
          (spec as DecisionSpec).labels.map((l) => [l.id, l.id === label ? 1 : 0]),
        ),
        method: 'jev' as const,
        calibrated: false,
      }
    },
    { supportedTypes: ['choice'] as const },
  ) as DecideFn
}
function fakeRoute(
  id: string,
  text: string,
  payload?: unknown,
  observe?: (data: Data) => void,
): ConfiguredPattern<Data> {
  return configurePattern<Data>(
    'simpleLoop',
    async (s) => {
      observe?.(s.data)
      if (payload)
        trackEvent(s, 'tool_result', { tool: 'graph_mail', result: payload, success: true }, true)
      trackEvent(
        s,
        'controller_action',
        {
          action: { reasoning: 'done', tool_name: 'Return', tool_args: text, is_final: true },
          turn: 0,
          maxTurns: 1,
        },
        true,
      )
      return s
    },
    { patternId: id },
  )
}

describe('decisionLoop handoff roster (D1/E1/E2)', () => {
  async function loopRun(
    script: string[],
    kind: 'simpleLoop' | 'actorCritic' = 'simpleLoop',
    shape: 'graph' | 'compact' = 'compact',
    addressOnly = false,
  ) {
    let prompt: string | undefined
    let data: Data | undefined
    let visible = ''
    let benignCall: Awaited<ReturnType<typeof callTool>> | undefined
    const unwrappedData: Data[] = []
    const info = simpleLoop<Data>(
      async (input) => {
        prompt = input.planContext
        return {
          action: {
            reasoning: 'done',
            tool_name: 'Return',
            tool_args: 'anonymous answer',
            is_final: true,
          },
        }
      },
      [],
      { patternId: 'info', rememberPriorTurns: false },
    )
    const probe = {
      ...info,
      fn: async (s: PatternScope<Data>, v: EventView) => {
        data = s.data
        visible = v.unfiltered().serialize()
        benignCall = await callTool('web_search', { query: 'content marketing trends' })
        return info.fn(s, v)
      },
    }
    const web = withInjectionGuard({ tools: ['never-called'] })(
      withPseudonymisedInputs({ pseudonymise: createWebPseudonymiser() })(probe),
    )
    const think = planner<Data>(
      async () => ({
        plan: { reasoning: '', plan: `Research ${EXTERNAL.name}`, n_steps: 1 },
        toolCount: 0,
      }),
      [],
      { patternId: 'think' },
    )
    let docRound = 0
    const docLoop = simpleLoop<Data>(
      async () => ({
        action: {
          reasoning: 'read mail',
          tool_name: docRound++ === 0 ? 'graph_mail' : 'Return',
          tool_args: docRound === 1 ? '{}' : `Mail from ${EXTERNAL.name}`,
          is_final: docRound > 1,
        },
      }),
      ['graph_mail'],
      { patternId: 'doc', maxTurns: 2 },
    )
    const docLeaf =
      kind === 'actorCritic'
        ? actorCritic<Data>(
            async () => ({
              action: {
                reasoning: 'read mail',
                tool_name: 'graph_mail',
                tool_args: '{}',
                is_final: false,
              },
            }),
            async () => ({ result: { is_sufficient: true, explanation: 'mail accepted' } }),
            ['graph_mail'],
            { patternId: 'doc', maxRetries: 1 },
          )
        : docLoop
    const doc = withInjectionGuard({ tools: ['graph_mail'] })({
      ...docLeaf,
      fn: async (s: PatternScope<Data>, v: EventView) => {
        unwrappedData.push(s.data)
        return docLeaf.fn(s, v)
      },
    })
    const routes = {
      doc: {
        pattern: doc,
        description: 'mail',
      },
      think: { pattern: think, description: 'plan' },
      one: {
        pattern: fakeRoute('one', 'first neutral result', undefined, (d) => unwrappedData.push(d)),
        description: 'one',
      },
      two: {
        pattern: fakeRoute('two', 'second neutral result', undefined, (d) => unwrappedData.push(d)),
        description: 'two',
      },
      info: { pattern: web, description: 'lookup', siblingResults: ['info'] },
    }
    const loop = withInjectionGuard({ tools: ['decision_loop_output'], spotlight: 'always' })(
      decisionLoop(routes, {
        patternId: 'orchestrator',
        decide: choice([...script, 'answer']),
        answer: 'answer',
        handoff: { lastN: 2 },
        maxIterations: 6,
      }),
    )
    const ctx = createContext<Data>('Research the correspondent')
    await withRunFrame(
      {
        ...frame('verda'),
        transports: [
          {
            ...transport,
            callTool: async (name) =>
              name === 'graph_mail'
                ? {
                    success: true,
                    data:
                      shape === 'graph'
                        ? {
                            from: {
                              emailAddress: addressOnly ? { address: 'zq@outside.test' } : EXTERNAL,
                            },
                            body: { content: DIRECTORY.mail },
                          }
                        : {
                            messages: shapeMessages({
                              value: [
                                {
                                  from: {
                                    emailAddress: addressOnly
                                      ? { address: 'zq@outside.test' }
                                      : EXTERNAL,
                                  },
                                  bodyPreview: DIRECTORY.mail,
                                },
                              ],
                            }),
                          },
                  }
                : { success: true, data: 'public result' },
          },
        ],
      },
      () => runChain(ctx, [loop]),
    )
    expect(data).not.toHaveProperty(WEB_ROSTER_INPUT)
    for (const d of unwrappedData) expect(d).not.toHaveProperty(WEB_ROSTER_INPUT)
    expect(visible).not.toContain(EXTERNAL.name) // excluded doc source stays excluded
    return { prompt, benignCall }
  }
  // Mutation: rewrite the view only.
  it('D1: external non-directory mail sender is rewritten in the rendered handoff', async () => {
    const { prompt, benignCall } = await loopRun(['doc', 'info'])
    expect(prompt).toContain('Mail from PERSON_2')
    expect(prompt).not.toContain(EXTERNAL.name)
    expect(prompt).toContain('⟦UNTRUSTED CONTENT · source:')
    expect(benignCall).toMatchObject({ success: true })
  })
  // Mutation: collect sources from only the last-N handed-off records.
  it('E1: a source outside lastN still supplies the identity in PLAN', async () => {
    const { prompt } = await loopRun(['doc', 'think', 'one', 'two', 'info'])
    const plan = prompt?.split('Earlier step results')[0]
    expect(plan).toContain('PLAN')
    expect(plan).toContain('Research PERSON_2')
    expect(prompt).not.toContain(EXTERNAL.name)
    expect(prompt).not.toContain('Mail from')
  })

  it.each(['graph', 'compact'] as const)(
    'D-1: actorCritic %s records retain useful anonymised content, including address-only senders',
    async (shape) => {
      for (const addressOnly of [false, true]) {
        const { prompt, benignCall } = await loopRun(
          ['doc', 'info'],
          'actorCritic',
          shape,
          addressOnly,
        )
        expect(prompt).toContain('PERSON_2')
        expect(prompt).toContain('PERSON_1_EMAIL')
        expect(prompt).not.toMatch(/Otto|Willow|zq@outside\.test|mira\.[^ ]*@example\.test/)
        expect(prompt).toContain('⟦UNTRUSTED CONTENT · source:')
        expect(prompt).not.toContain('[withheld: private identity]')
        expect(benignCall).toMatchObject({ success: true })
      }
      const { prompt } = await loopRun(['doc', 'think', 'one', 'two', 'info'], 'actorCritic', shape)
      expect(prompt).toContain('Research PERSON_2')
      expect(prompt).not.toContain(EXTERNAL.name)
    },
  )
})

describe('nested guard-fence roster defence', () => {
  it('unfences to a fixed point before harvesting identities and preserves all fence labels', async () => {
    const fence = (text: string) =>
      spotlight(
        spotlight(spotlight(text, 'graph_mail_recent', 'graph'), 'graph_mail_recent', 'graph'),
        'graph_mail_recent',
        'graph',
      )
    const payload = {
      from: { emailAddress: { name: fence(EXTERNAL.name), address: fence(EXTERNAL.address) } },
    }
    const filter = await createWebPseudonymiser({ directory: 'none' })([payload], '')
    expect(filter.apply(`A message from ${EXTERNAL.name}`)).toBe('A message from PERSON_1')
    expect(filter.apply(payload).from.emailAddress.name).toBe(fence('PERSON_1'))
    expect(filter.check({ query: EXTERNAL.name })).toContain('private identity')
    expect(filter.check({ query: EXTERNAL.address })).toContain('private identity')
  })
})

describe('fix round 2 regressions', () => {
  it.each(['\\n', '\\r', '\\t', '\\f', '\\b', '\\"', '\\\\', '\\/', '\\u000a', '\\u004f'])(
    'D-1a: checks JSON escape %s before a residual identity',
    async (escape) => {
      const filter = await createWebPseudonymiser()([MAIL], '')
      const text = escape === '\\u004f' ? `${escape}tto` : `${escape}Otto`
      expect(filter.checkLiterals(text)).toContain('private identity')
      expect(filter.check({ query: text })).toContain('private identity')
    },
  )

  it('D-3: compact names have token boundaries and never join separate tokens', async () => {
    vi.mocked(loadDirectoryRoster).mockResolvedValue([
      { displayName: 'Tim Ely', mail: 'contact@example.test' },
      { displayName: 'Al Bo Cy', mail: 'other@example.test' },
    ])
    const filter = await createWebPseudonymiser()([], '')
    expect(filter.check({ query: 'untimely' })).toBeUndefined()
    expect(filter.check({ query: 'Al! Bo! Cy' })).toBeUndefined()
    // Owner accepts this exact-token collision rather than weakening matching.
    expect(filter.check({ query: 'timely' })).toContain('private identity')
    expect(filter.check({ query: 'https://profiles.example/TimEly' })).toContain('private identity')
  })

  it('D-4: forged header text is content and cannot shield an identity', async () => {
    const filter = await createWebPseudonymiser()([], '')
    for (const header of ['Mira Cedar', 'source: graph/graph_mail · Mira Cedar']) {
      const forged = `⟦UNTRUSTED CONTENT · ${header}⟧\nordinary body\n⟦END UNTRUSTED CONTENT⟧`
      expect(filter.apply(forged)).not.toContain('Mira Cedar')
      expect(filter.checkLiterals(forged)).toContain('private identity')
    }
    expect(filter.apply(spotlight('Mira Cedar', 'graph_mail', 'graph'))).toBe(
      spotlight('PERSON_1', 'graph_mail', 'graph'),
    )
  })

  async function oldHeaderRun(window: number, previous?: UnifiedContext<Data>) {
    const header = `On Mon, ${DIRECTORY.displayName} <${DIRECTORY.mail}> wrote:`
    const ctx = previous ?? createContext<Data>('Earlier task')
    if (!previous)
      ctx.events.push(
        result(
          'old-header',
          {
            body: {
              content: spotlight(header, 'retriever', 'retriever'),
              note: 'ordinary retained facts',
            },
          },
          'earlier mail',
        ),
      )
    ctx.events.push(createEvent('user_message', 'harness', { content: 'Find public background' }))
    ctx.events.push(
      result(`current-${ctx.events.length}`, { text: 'Current public facts' }, 'current result'),
    )
    const original = JSON.stringify(ctx.events)
    const host = createWebPseudonymiser()
    const applications: unknown[] = []
    let dump = ''
    let publicCall: ToolCallResult | undefined
    let privateCall: ToolCallResult | undefined
    const child = configurePattern<Data>(
      'probe',
      async (s, v) => {
        dump = v.unfiltered().serialize()
        publicCall = await callTool('web_search', { query: 'ordinary facts' })
        privateCall = await callTool('web_search', { query: DIRECTORY.mail })
        return s
      },
      { patternId: 'probe', viewConfig: { fromLast: false, fromLastNTurns: window } },
    )
    const wrapped = withPseudonymisedInputs({
      pseudonymise: async (...args) => {
        const filter = await host(...args)
        return {
          ...filter,
          apply: (value) => {
            applications.push(value)
            return filter.apply(value)
          },
        }
      },
    })(child)
    const scope = createScope<Data>('probe', {})
    await withRunFrame(frame('verda'), () =>
      wrapped.fn(scope, createEventView(ctx, child.config.viewConfig, 'probe')),
    )
    expect(JSON.stringify(ctx.events)).toBe(original)
    return { dump, publicCall, privateCall, applications, scope, ctx }
  }

  it('D-2 availability: one old header does not disable this or subsequent web invocations; only visible string bodies are withheld', async () => {
    let previous: UnifiedContext<Data> | undefined
    for (const window of [2, 1]) {
      const seen = await oldHeaderRun(window, previous)
      previous = seen.ctx
      expect(seen.publicCall).toMatchObject({ success: true })
      expect(seen.scope.events.filter((e) => e.type === 'warning')).toEqual([])
      expect(seen.dump).toContain('Current public facts')
      if (window === 2) {
        expect(seen.dump).toContain('[withheld: private identity]')
        expect(seen.dump).toContain('ordinary retained facts')
        expect(seen.dump).toContain('⟦UNTRUSTED CONTENT · source: retriever/retriever')
      } else {
        expect(seen.dump).not.toContain('old-header')
        expect(seen.dump).not.toContain('earlier mail')
        expect(JSON.stringify(seen.applications)).not.toContain('earlier mail')
      }
    }
  })

  it('D-2 privacy: the old header literal is refused before outgoing dispatch', async () => {
    const seen = await oldHeaderRun(2)
    expect(seen.dump).not.toContain(DIRECTORY.mail)
    expect(seen.privateCall).toMatchObject({ success: false })
    expect(outgoing).toHaveBeenCalledOnce()
    expect(outgoing.mock.calls[0]).toEqual(['web_search', { query: 'ordinary facts' }])
  })

  it('D-6/N10: screen-withheld child payloads never enter roster input, with a healthy-screen control', async () => {
    for (const unavailable of [true, false]) {
      let round = 0
      const doc = withInjectionGuard({ tools: ['graph_mail'] })(
        simpleLoop<Data>(
          async () => ({
            action: {
              reasoning: 'read',
              tool_name: round++ === 0 ? 'graph_mail' : 'Return',
              tool_args: round === 1 ? '{}' : 'mail read',
              is_final: round > 1,
            },
          }),
          ['graph_mail'],
          { patternId: 'doc', maxTurns: 2 },
        ),
      )
      const host = vi.fn(createWebPseudonymiser())
      const info = withPseudonymisedInputs({ pseudonymise: host })(fakeRoute('info', 'done'))
      let screens = 0
      const loop = withInjectionGuard({
        tools: ['decision_loop_output'],
        spotlight: 'always',
        screen: async () => {
          if (unavailable && ++screens <= 2) throw new Error('synthetic screen outage')
          return { injection_detected: false, reason: '', spans: [] }
        },
      })(
        decisionLoop(
          {
            doc: { pattern: doc, description: 'mail' },
            info: { pattern: info, description: 'lookup', siblingResults: ['doc', 'info'] },
          },
          {
            patternId: 'orchestrator',
            decide: choice(['doc', 'info', 'answer']),
            answer: 'answer',
            maxIterations: 3,
          },
        ),
      )
      await withRunFrame(
        {
          ...frame('verda'),
          transports: [{ ...transport, callTool: async () => ({ success: true, data: MAIL }) }],
        },
        () => runChain(createContext<Data>('Research'), [loop]),
      )
      expect(host).toHaveBeenCalledOnce()
      const payloads = JSON.stringify(host.mock.calls[0][0])
      if (unavailable) expect(payloads).not.toContain(EXTERNAL.address)
      else expect(payloads).toContain(EXTERNAL.address)
    }
  })
})

describe('fix round 1 Critical and High regressions', () => {
  it('preserves provenance even when a labelled author names the fence label', async () => {
    const filter = await createWebPseudonymiser()([MAIL, { author: 'UNTRUSTED CONTENT' }], '')
    const fenced = spotlight(`Mail from ${EXTERNAL.name}`, 'graph_mail', 'graph')
    expect(filter.apply(fenced)).toBe(spotlight('Mail from PERSON_2', 'graph_mail', 'graph'))
  })
  it.each(['view', 'plan', 'handoff'] as const)(
    'withholds RFC 5322 address headers left in rewritten %s copies',
    async (channel) => {
      const header = `From: ${EXTERNAL.name} <${EXTERNAL.address}>\ncc: <${DIRECTORY.mail}>`
      const ctx = createContext<Data>('Research this subject')
      if (channel === 'view')
        ctx.events.push(
          result('header', { ...MAIL, body: { content: header } }, 'Message received'),
        )
      const scope = createScope<Data>('probe', {
        [WEB_ROSTER_INPUT]: { payloads: [MAIL], steps: 'Steps so far:\n1. doc — succeeded' },
        plan: { reasoning: '', plan: channel === 'plan' ? header : 'Research', n_steps: 1 },
        handoff: channel === 'handoff' ? header : 'neutral',
      })
      const original = JSON.stringify(ctx.events)
      const child = configurePattern<Data>('probe', async (s, v) => {
        const visible = v.unfiltered().serialize() + JSON.stringify(s.data)
        expect(visible).not.toContain(EXTERNAL.address)
        expect(visible).not.toContain(DIRECTORY.mail)
        expect(visible).toContain('[withheld: private identity]')
        expect(s.data.plan).toBeDefined()
        expect(s.data.handoff).toBe(
          channel === 'handoff' ? '[withheld: private identity]' : 'neutral',
        )
        expect(await callTool('web_search', { query: 'public facts' })).toMatchObject({
          success: true,
        })
        return s
      })
      const wrapped = withPseudonymisedInputs({ pseudonymise: createWebPseudonymiser() })(child)
      await withRunFrame(frame('verda'), () => wrapped.fn(scope, createEventView(ctx)))
      expect(scope.events.filter((e) => e.type === 'warning')).toHaveLength(0)
      expect(JSON.stringify(ctx.events)).toBe(original)
      expect(outgoing).toHaveBeenCalledOnce()
    },
  )

  it.each(['mira-cedar', 'mira_cedar', 'MiraCedar', 'mira-cedar-1a2b'])(
    'denies the name slug %s in a fetch URL',
    async (slug) => {
      const filter = await createWebPseudonymiser()([], '')
      expect(filter.check({ url: `https://profiles.example/in/${slug}` })).toContain(
        'private identity',
      )
    },
  )
})

describe('fix round 1 remaining findings', () => {
  it.each(['web_search', 'search', 'fetch_content', 'unknown_outbound'])(
    'checks %s even without app namespace registration (X5)',
    async (name) => {
      unregister()
      const child = configurePattern<Data>('probe', async (s) => {
        expect(await callTool(name, { query: DIRECTORY.mail })).toMatchObject({ success: false })
        expect(await callTool(name, { query: 'ordinary facts' })).toMatchObject({ success: true })
        return s
      })
      await withRunFrame(frame('verda'), () =>
        withPseudonymisedInputs({ pseudonymise: createWebPseudonymiser() })(child).fn(
          createScope('probe', {}),
          createEventView(createContext('Research')),
        ),
      )
      expect(outgoing).toHaveBeenCalledOnce()
    },
  )

  it.each([false, true])(
    'learns identities from this invocation’s guarded local reads (fenced=%s)',
    async (fenced) => {
      for (const name of ['read_neo4j_cypher', 'read_filesystem_file']) {
        outgoing.mockResolvedValueOnce({ success: true, data: MAIL })
        const child = configurePattern<Data>('probe', async (s) => {
          const read = await callTool(name, { query: 'MATCH (n) RETURN n' })
          expect(read.success).toBe(true)
          expect(JSON.stringify(read.data)).toContain(EXTERNAL.name)
          if (!fenced) expect(read.data).toEqual(MAIL)
          for (const query of [
            EXTERNAL.name,
            EXTERNAL.address,
            'https://profiles.example/ottowillow',
          ]) {
            expect(await callTool('web_search', { query })).toMatchObject({ success: false })
          }
          expect(await callTool('web_search', { query: 'ordinary facts' })).toMatchObject({
            success: true,
          })
          return s
        })
        const wrapped = withPseudonymisedInputs({ pseudonymise: createWebPseudonymiser() })(child)
        const guarded = fenced
          ? withInjectionGuard({ tools: [name], spotlight: 'always' })(wrapped)
          : wrapped
        await withRunFrame(frame('verda'), () =>
          guarded.fn(createScope('probe', {}), createEventView(createContext('Research'))),
        )
        expect(outgoing).toHaveBeenCalledTimes(2)
        outgoing.mockClear()
      }
    },
  )

  it('refuses subsequent outgoing calls when roster extension throws, without exposing the error', async () => {
    const child = configurePattern<Data>('probe', async (s) => {
      vi.spyOn(roster, 'extractRoster').mockImplementationOnce(() => {
        throw new Error(EXTERNAL.address)
      })
      const read = await callTool('read_neo4j_cypher', { query: 'RETURN 1' })
      expect(read.success).toBe(false)
      expect(JSON.stringify(read)).not.toContain(EXTERNAL.address)
      expect(await callTool('web_search', { query: 'ordinary facts' })).toMatchObject({
        success: false,
      })
      return s
    })
    const scope = createScope<Data>('probe', {})
    await withRunFrame(frame('verda'), () =>
      withPseudonymisedInputs({ pseudonymise: createWebPseudonymiser() })(child).fn(
        scope,
        createEventView(createContext('Research')),
      ),
    )
    expect(outgoing).toHaveBeenCalledOnce()
    expect(JSON.stringify(scope.events)).not.toContain(EXTERNAL.address)
    expect(scope.events.some((e) => e.type === 'warning')).toBe(true)
  })

  it('compiles a single alternation and allocates no regexes per outgoing call', async () => {
    // This pins allocation shape, not a machine-dependent latency benchmark.
    const people = Array.from({ length: 100 }, (_, n) => {
      const suffix = String.fromCharCode(
        97 + (n % 26),
        97 + (Math.floor(n / 26) % 26),
        97 + Math.floor(n / 676),
      )
      return {
        displayName: `Member${suffix} Willow${suffix}`,
        mail: `member${suffix}@example.test`,
      }
    })
    vi.mocked(loadDirectoryRoster).mockResolvedValue(people)
    const NativeRegExp = globalThis.RegExp
    const regex = vi.spyOn(globalThis, 'RegExp').mockImplementation(function (pattern, flags) {
      return new NativeRegExp(pattern, flags)
    })
    const filter = await createWebPseudonymiser()([], `Search for ${people[99].displayName}`)
    // RegExp's species constructor is also used by native String.split;
    // count explicit outgoing matchers, whose flags are exactly `u`.
    const compilations = () =>
      regex.mock.calls.filter(([, flags]) => flags === 'u' || flags === 'iu').length
    expect(compilations()).toBe(1)
    for (let n = 0; n < 10; n++) expect(filter.check({ query: 'ordinary facts' })).toBeUndefined()
    expect(filter.check({ query: people[98].displayName })).toContain('private identity')
    expect(filter.check({ query: people[99].displayName })).toBeUndefined()
    expect(compilations()).toBe(1)
  })

  it.each(['PERSON 3', 'PERSON-3', 'PERSON__3_EMAIL', 'PERSON%203', 'PERSON-3-FUTURE'])(
    'refuses the linkable placeholder %s',
    async (query) => {
      const filter = await createWebPseudonymiser()([], '')
      expect(filter.check({ query })).toContain('Placeholders')
    },
  )

  it('normalises accents, URL separators and short-name form spaces (X6)', async () => {
    vi.mocked(loadDirectoryRoster).mockResolvedValue([
      { displayName: 'Li Xu', mail: 'contact@example.test' },
      { displayName: 'René Alder', mail: 'other@example.test' },
    ])
    const filter = await createWebPseudonymiser()([], '')
    for (const query of [
      'Li+Xu',
      'Li%2BXu',
      'Li-Xu',
      'Li_Xu',
      'Li.Xu',
      'Li/Xu',
      'https://profiles.example/rene-alder',
      'https://profiles.example/ReneAlder',
      'Rene\u0301/Alder',
      'René.Alder',
    ]) {
      expect(filter.check({ query })).toContain('private identity')
    }
  })

  it.each([false, true])(
    'protects all inherited chain data and rebuilds it on failure (missing=%s)',
    async (missing) => {
      const ctx = createContext<Data>('Research')
      const intent = configurePattern<Data>('intent', async (s) => {
        s.data.intent = `Research ${DIRECTORY.displayName}`
        s.data.unexpected = `Earlier ${DIRECTORY.mail}`
        return s
      })
      let seen: Data | undefined
      const child = configurePattern<Data>('probe', async (s) => {
        seen = structuredClone(s.data)
        return s
      })
      await withRunFrame(frame('verda'), () =>
        runChain(ctx, [
          intent,
          withPseudonymisedInputs({ pseudonymise: missing ? undefined : createWebPseudonymiser() })(
            child,
          ),
        ]),
      )
      expect(seen).toBeDefined()
      expect(JSON.stringify(seen)).not.toMatch(/Mira Cedar|mira.cedar@example.test/)
      if (missing) {
        expect(seen).not.toHaveProperty('intent')
        expect(seen).not.toHaveProperty('unexpected')
      } else expect(seen?.intent).toBe('Research PERSON_1')
    },
  )
})

describe('withholding and outgoing checks', () => {
  it('a denied web call is recoverable: the real loop rephrases and finishes without a turn error', async () => {
    let round = 0
    const seen: ControllerInput[] = []
    const loop = simpleLoop<Data>(
      async (input) => {
        seen.push(structuredClone(input))
        const n = round++
        return {
          action: {
            reasoning: 'synthetic rephrase',
            tool_name: n < 2 ? 'fetch' : 'Return',
            tool_args:
              n === 0
                ? JSON.stringify({
                    url: `https://public.example.test/?q=${encodeURIComponent(DIRECTORY.mail)}`,
                  })
                : n === 1
                  ? JSON.stringify({ url: 'https://public.example.test/facts' })
                  : 'done',
            is_final: n === 2,
          },
        }
      },
      ['fetch'],
      { patternId: 'info', maxTurns: 4 },
    )
    const wrapped = withPseudonymisedInputs({ pseudonymise: createWebPseudonymiser() })(loop)
    const scope = createScope<Data>('info', {})
    await withRunFrame(frame('verda'), () =>
      wrapped.fn(scope, createEventView(createContext('Find public background'))),
    )
    expect(seen).toHaveLength(3)
    expect(JSON.stringify(seen[1].turns)).toContain('private identity')
    expect(scope.events.filter((e) => e.type === 'error')).toEqual([])
    expect(
      scope.events
        .filter((e) => e.type === 'tool_result')
        .map((e) => (e.data as { success: boolean }).success),
    ).toEqual([false, true])
    expect(outgoing).toHaveBeenCalledOnce()
  })

  // D3/E2 mutations: pass through a missing host; move deletion after success.
  it.each(['missing', 'roster', 'table', 'directory', 'empty', 'apply'] as const)(
    'fails closed on %s without a turn error',
    async (failure) => {
      if (failure === 'roster')
        vi.spyOn(roster, 'extractRoster').mockImplementation(() => {
          throw new Error('sensitive roster failure')
        })
      if (failure === 'table')
        vi.spyOn(pseudonym, 'buildTable').mockImplementation(() => {
          throw new Error('sensitive table failure')
        })
      if (failure === 'directory')
        vi.mocked(loadDirectoryRoster).mockRejectedValue(new Error('sensitive directory error'))
      if (failure === 'empty') vi.mocked(loadDirectoryRoster).mockResolvedValue([])
      if (failure === 'apply')
        vi.spyOn(pseudonym, 'apply').mockImplementation(() => {
          throw new Error('sensitive rewrite error')
        })
      const filter = failure === 'missing' ? undefined : createWebPseudonymiser()
      const { seen, scope } = await referencesRun(filter)
      expect(seen[0].priorResults).toBeUndefined()
      expect(seen[0].planContext).toContain('Steps so far:')
      expect(seen[0].planContext).not.toMatch(/PLAN|Otto|useful body|Latest results/)
      expect(scope.events.some((e) => e.type === 'error')).toBe(false)
      expect(scope.events.filter((e) => e.type === 'warning')).toHaveLength(1)
      expect(JSON.stringify(scope.events)).not.toContain('sensitive')
      const inner = configurePattern<Data>('probe', async (s) => {
        expect(s.data).not.toHaveProperty(WEB_ROSTER_INPUT)
        expect(await callTool('fetch', { url: 'https://public.example.test' })).toMatchObject({
          success: false,
          error: expect.stringContaining('privacy filter unavailable'),
        })
        expect(await callTool('read_neo4j_cypher', { query: 'RETURN 1' })).toMatchObject({
          success: true,
        })
        return s
      })
      const wrapped = withPseudonymisedInputs({ pseudonymise: filter })(inner)
      await withRunFrame(frame('verda'), () =>
        wrapped.fn(
          createScope('probe', { [WEB_ROSTER_INPUT]: { payloads: [], steps: '' } }),
          createEventView(createContext('task')),
        ),
      )
      expect(outgoing).toHaveBeenCalledTimes(1)
    },
  )

  it('E2: deletes roster-only input before even a throwing inner pattern', async () => {
    const scope = createScope<Data>('probe', {
      [WEB_ROSTER_INPUT]: { payloads: [MAIL], steps: '' },
    })
    const child = configurePattern<Data>('probe', async (s) => {
      expect(s.data).not.toHaveProperty(WEB_ROSTER_INPUT)
      throw new Error('inner')
    })
    const wrapped = withPseudonymisedInputs({ pseudonymise: createWebPseudonymiser() })(child)
    await expect(
      withRunFrame(frame('verda'), () => wrapped.fn(scope, createEventView(createContext('task')))),
    ).rejects.toThrow('inner')
    expect(scope.data).not.toHaveProperty(WEB_ROSTER_INPUT)
  })

  it('denies percent-encoded identities and every placeholder suffix before dispatch; user-named literals are allowed', async () => {
    const child = configurePattern<Data>('probe', async (s) => {
      for (const term of [
        'PERSON_3',
        'PERSON_3_EMAIL',
        'PERSON_3_FUTURE_SUFFIX',
        'PERSON%5F3',
        encodeURIComponent(DIRECTORY.mail),
        `<${DIRECTORY.mail}>`,
      ]) {
        expect(
          await callTool('fetch', { url: `https://public.example.test/?q=${term}` }),
        ).toMatchObject({ success: false })
      }
      expect(outgoing).not.toHaveBeenCalled()
      expect(await callTool('web_search', { query: DIRECTORY.displayName })).toMatchObject({
        success: true,
      })
      expect(await callTool('web_search', { query: 'ordinary facts' })).toMatchObject({
        success: true,
      })
      expect(await callTool('web_search', { query: '5% growth' })).toMatchObject({ success: true })
      expect(await callTool('fetch', { url: 'https://public.example.test/%FF' })).toMatchObject({
        success: false,
        error: expect.stringContaining('URL-decoded'),
      })
      return s
    })
    const wrapped = withPseudonymisedInputs({ pseudonymise: createWebPseudonymiser() })(child)
    await withRunFrame(frame('verda'), () =>
      wrapped.fn(createScope('probe', {}), createEventView(createContext(USER))),
    )
    expect(outgoing).toHaveBeenCalledTimes(3)
  })

  // Mutation: nested egressChecks replace rather than concatenate, or delete
  // callTool's pre-dispatch loop. Both must fail at the dispatch observation.
  it('keeps ALL enclosing checks, any denial wins, and restores them on exit', async () => {
    const calls: string[] = []
    await withRunFrame(
      {
        ...frame('verda'),
        egressChecks: [
          () => {
            calls.push('outer')
            return 'outer denial'
          },
          () => {
            calls.push('after-denial')
          },
        ],
      },
      async () => {
        await amendRunFrame(
          {
            egressChecks: [
              () => {
                calls.push('inner')
              },
              () => {
                calls.push('third')
              },
            ],
          },
          async () => {
            expect(Object.isFrozen(activeRunFrame().egressChecks)).toBe(true)
            expect(await callTool('fetch', {})).toMatchObject({
              success: false,
              error: 'outer denial',
            })
            expect(calls).toEqual(['inner', 'third', 'outer', 'after-denial'])
          },
        )
        expect(await callTool('fetch', {})).toMatchObject({ success: false, error: 'outer denial' })
      },
    )
    expect(outgoing).not.toHaveBeenCalled()
    await withRunFrame(frame('verda'), async () => {
      expect(await callTool('fetch', {})).toMatchObject({ success: true })
    })
  })

  it('a throwing check denies safely while remaining checks still run', async () => {
    const after = vi.fn()
    await withRunFrame(
      {
        ...frame('verda'),
        egressChecks: [
          () => {
            throw new Error(DIRECTORY.mail)
          },
          after,
        ],
      },
      async () => {
        expect(await callTool('fetch', {})).toEqual({
          success: false,
          data: null,
          error: 'Tool call refused: outgoing privacy check unavailable.',
        })
      },
    )
    expect(after).toHaveBeenCalledOnce()
    expect(outgoing).not.toHaveBeenCalled()
  })

  it('only an explicit no-directory constructor allows an empty directory; numbering starts with directory', async () => {
    const filter = await createWebPseudonymiser()([MAIL, GRAPH], '')
    expect(filter.apply([DIRECTORY.displayName, EXTERNAL.name])).toEqual(['PERSON_1', 'PERSON_2'])
    vi.mocked(loadDirectoryRoster).mockRejectedValue(new Error('not read'))
    const noDirectory = await createWebPseudonymiser({ directory: 'none' })([MAIL], '')
    expect(noDirectory.apply(EXTERNAL.name)).toBe('PERSON_1')
    expect(noDirectory.check({ query: EXTERNAL.address })).toContain('private identity')
    expect(noDirectory.check({ query: 'public facts' })).toBeUndefined()
  })

  it('matches tagged addresses, URL-encoded Unicode names, and form-query spaces', async () => {
    vi.mocked(loadDirectoryRoster).mockResolvedValue([
      { displayName: 'René Alder', mail: 'rene+tag@example.test' },
    ])
    const filter = await createWebPseudonymiser()([], '')
    for (const query of [
      'rene+tag@example.test',
      'rene%2Btag%40example.test',
      'Ren%C3%A9%20Alder',
      'Ren%C3%A9+Alder',
      '<René Alder>',
      '%3CRen%C3%A9%20Alder%3E',
    ]) {
      expect(filter.check({ query })).toContain('private identity')
    }
    expect(filter.check({ query: 'Renéish Alderwood' })).toBeUndefined()
    const userNamed = await createWebPseudonymiser()([], 'Search for <René Alder>')
    expect(userNamed.check({ query: 'René Alder' })).toBeUndefined()
  })

  it('leaves earlier placeholders unchanged when labelled fields are harvested again', async () => {
    const filter = await createWebPseudonymiser()(
      [MAIL, { from: { emailAddress: { name: 'PERSON_1' } } }],
      '',
    )
    expect(filter.apply('PERSON_1 asked PERSON_2_EMAIL')).toBe('PERSON_1 asked PERSON_2_EMAIL')
    expect(filter.apply(EXTERNAL.name)).toBe('PERSON_2')
  })

  it('checks original argument strings before JSON escaping, including nested values and keys', async () => {
    const address = '"odd.nickname"@example.test'
    vi.mocked(loadDirectoryRoster).mockResolvedValue([
      { displayName: 'Nora Spruce', mail: address },
    ])
    const filter = await createWebPseudonymiser()([], '')
    expect(filter.check({ query: address })).toContain('private identity')
    expect(
      filter.check({
        nested: [{ url: `https://public.example.test/?q=${encodeURIComponent(address)}` }],
      }),
    ).toContain('private identity')
    expect(filter.check({ [address]: 'value' })).toContain('private identity')
  })
})

describe('pre-flip LOWs (R-1, screened identity)', () => {
  const rewriteLikeWrapper = (filter: Awaited<ReturnType<PseudonymiseForWeb>>, value: string) =>
    filter.redact(filter.apply(value))

  it('R-1: a content newline before a name keeps the other leaves of an actorCritic record', async () => {
    const filter = await createWebPseudonymiser()([MAIL], '')
    // actorCritic records are one JSON string: the newline arrives escaped.
    const record = JSON.stringify({
      subject: 'Quarterly numbers',
      preview: `Regards,\n${EXTERNAL.name}`,
      note: 'ordinary retained facts',
    })
    const fenced = spotlight(record, 'doc', 'decision_loop_output')
    const out = rewriteLikeWrapper(filter, fenced)
    expect(out).not.toContain('withheld')
    expect(out).not.toContain('Otto')
    expect(out).not.toContain('Willow')
    expect(out).toContain('ordinary retained facts')
    expect(out).toContain('Quarterly numbers')
    expect(out).toContain('PERSON_2')
    // The fence and the JSON shape survive.
    const body = out.slice(out.indexOf('⟧\n') + 2, out.lastIndexOf('\n⟦END'))
    expect(JSON.parse(body).note).toBe('ordinary retained facts')
  })

  it('R-1: a JSON body with no identity is returned byte-identical, and non-JSON text still works', async () => {
    const filter = await createWebPseudonymiser()([MAIL], '')
    const plain = '{ "a" : "x",\n "b": [1, 2] }'
    expect(rewriteLikeWrapper(filter, plain)).toBe(plain)
    expect(rewriteLikeWrapper(filter, `{not json ${EXTERNAL.name}`)).toBe('{not json PERSON_2')
  })

  it('R-1: a residual identity inside a JSON leaf withholds only that leaf', async () => {
    const filter = await createWebPseudonymiser()([MAIL], '')
    const out = JSON.parse(
      filter.redact(JSON.stringify({ keep: 'fine', odd: `Sent by\n${DIRECTORY.mail}` })),
    )
    expect(out.keep).toBe('fine')
    expect(JSON.stringify(out)).not.toContain(DIRECTORY.mail)
  })

  const screened = (span: string) =>
    applyScreenVerdict(
      { from: EXTERNAL.name, subject: 'Mr Willow wrote', body: 'Hello' },
      { injection_detected: true, reason: 'synthetic', spans: [span] },
      { tool: 'graph_mail_recent', namespace: 'graph' },
      {
        tool: 'graph_mail_recent',
        namespace: 'graph',
        findings: [],
        neutralized: false,
        spotlighted: false,
        scanned: 0,
      },
    ).data

  it('screen span equal to the sender name: the roster is never silently emptied (fails closed)', async () => {
    for (const span of [EXTERNAL.name, 'Otto']) {
      const data = screened(span)
      expect(JSON.stringify(data)).toContain('neutralized:llm-screen')
      await expect(createWebPseudonymiser()([data], '')).rejects.toThrow()
    }
  })

  it('screen span equal to the sender name: the wrapper withholds earlier content and refuses web calls', async () => {
    const child = configurePattern<Data>('probe', async (s) => {
      expect(await callTool('web_search', { query: 'Mr Willow' })).toMatchObject({ success: false })
      return s
    })
    const scope = createScope<Data>('probe', {
      [WEB_ROSTER_INPUT]: { payloads: [screened(EXTERNAL.name)], steps: 'Steps so far' },
    })
    await withRunFrame(frame('verda'), () =>
      withPseudonymisedInputs({ pseudonymise: createWebPseudonymiser() })(child).fn(
        scope,
        createEventView(createContext('Research')),
      ),
    )
    expect(outgoing).not.toHaveBeenCalled()
    expect(scope.events.some((e) => e.type === 'warning')).toBe(true)
    expect(JSON.stringify(scope.events)).not.toContain('Willow')
  })
})
