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
import {
  createContext,
  createEvent,
  createScope,
  trackEvent,
} from '@hames-ai/harness-patterns/context.server'
import { createEventView } from '@hames-ai/harness-patterns/patterns/event-view.server'
import { configurePattern, runChain } from '@hames-ai/harness-patterns/patterns/chain.server'
import { simpleLoop } from '@hames-ai/harness-patterns/patterns/simpleLoop.server'
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
const outgoing = vi.fn(async () => ({ success: true, data: 'public result' }))
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
function fakeRoute(id: string, text: string, payload?: unknown): ConfiguredPattern<Data> {
  return configurePattern<Data>(
    'simpleLoop',
    async (s) => {
      expect(s.data).not.toHaveProperty(WEB_ROSTER_INPUT) // E2, unwrapped route.
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
  async function loopRun(script: string[]) {
    let prompt: string | undefined
    let data: Data | undefined
    let visible = ''
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
    const routes = {
      doc: { pattern: fakeRoute('doc', `Mail from ${EXTERNAL.name}`, MAIL), description: 'mail' },
      think: { pattern: think, description: 'plan' },
      one: { pattern: fakeRoute('one', 'first neutral result'), description: 'one' },
      two: { pattern: fakeRoute('two', 'second neutral result'), description: 'two' },
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
    await withRunFrame(frame('verda'), () => runChain(ctx, [loop]))
    expect(data).not.toHaveProperty(WEB_ROSTER_INPUT)
    expect(visible).not.toContain(EXTERNAL.name) // excluded doc source stays excluded
    return prompt
  }
  // Mutation: rewrite the view only.
  it('D1: external non-directory mail sender is rewritten in the rendered handoff', async () => {
    const prompt = await loopRun(['doc', 'info'])
    expect(prompt).toContain('Mail from PERSON_2')
    expect(prompt).not.toContain(EXTERNAL.name)
  })
  // Mutation: collect sources from only the last-N handed-off records.
  it('E1: a source outside lastN still supplies the identity in PLAN', async () => {
    const prompt = await loopRun(['doc', 'think', 'one', 'two', 'info'])
    const plan = prompt?.split('Earlier step results')[0]
    expect(plan).toContain('PLAN')
    expect(plan).toContain('Research PERSON_2')
    expect(prompt).not.toContain(EXTERNAL.name)
    expect(prompt).not.toContain('Mail from')
  })
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
    ]) {
      expect(filter.check({ query })).toContain('private identity')
    }
  })

  it('leaves earlier placeholders unchanged when labelled fields are harvested again', async () => {
    const filter = await createWebPseudonymiser()(
      [MAIL, { from: { emailAddress: { name: 'PERSON_1' } } }],
      '',
    )
    expect(filter.apply('PERSON_1 asked PERSON_2_EMAIL')).toBe('PERSON_1 asked PERSON_2_EMAIL')
    expect(filter.apply(EXTERNAL.name)).toBe('PERSON_2')
  })
})
