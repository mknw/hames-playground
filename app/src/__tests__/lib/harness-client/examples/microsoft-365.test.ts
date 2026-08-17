/**
 * Microsoft 365 agent — what it composes out of `tools.graph` (#110).
 *
 * The agent takes an explicit allowlist rather than the whole namespace, and the
 * interesting part is what's missing: `graph_file_ingest` is registered, and this
 * agent must still not get it, because with no retriever pattern an ingested
 * file's contents are unreachable for the rest of the turn.
 *
 * The harness barrel is stubbed so this stays a unit test of the composition —
 * it asserts the exact tool list handed to the loop and its controller, which is
 * not observable from a `ConfiguredPattern` afterwards.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

vi.mock('../../../../lib/auth/graph-token.server', () => ({
  GraphAuthRequiredError: class GraphAuthRequiredError extends Error {
    constructor(
      message: string,
      readonly userId: string,
      readonly status?: number,
    ) {
      super(message)
      this.name = 'GraphAuthRequiredError'
    }
  },
  graphFetch: vi.fn(),
  GRAPH_BASE: 'https://graph.microsoft.com/v1.0',
  DEFAULT_GRAPH_SCOPES: ['User.Read'],
}))

vi.mock('../../../../lib/harness-client/request-user.server', () => ({
  getRequestUserId: () => 'oid-1',
  getRequestSessionId: () => 'sess-1',
  runWithUserId: (_u: string, fn: () => Promise<unknown>) => fn(),
  runWithRequestContext: (_c: unknown, fn: () => Promise<unknown>) => fn(),
}))

/** Whatever `Tools()` should report as the graph namespace for a given test. */
let graphNamespace: string[] = []

const simpleLoop = vi.fn((controller: unknown, tools: string[], config: unknown) => ({
  name: 'simpleLoop',
  fn: async () => undefined,
  config,
  // Not part of ConfiguredPattern — captured here purely so the test can see
  // which tools the agent handed the loop.
  tools,
  controller,
}))

/** Records the `withInjectionGuard(config)` the agent declared, and stays
 *  config-transparent like the real wrapper (spread of the inner pattern). */
const injectionGuard = vi.fn((config: unknown) => <T extends object>(pattern: T) => ({
  ...pattern,
  name: `withInjectionGuard(${(pattern as { name: string }).name})`,
  guardConfig: config,
}))

vi.mock('../../../../lib/harness-patterns', () => ({
  simpleLoop: (c: unknown, t: string[], cfg: unknown) => simpleLoop(c, t, cfg),
  compactExecution: (config: unknown) => ({
    name: 'compactExecution',
    fn: async () => undefined,
    config,
  }),
  withInjectionGuard: (config: unknown) => injectionGuard(config),
  Tools: async () => ({ graph: graphNamespace, all: graphNamespace }),
  createLoopControllerAdapter: (tools: string[]) => ({ adapterTools: tools }),
}))

import {
  microsoft365Agent,
  MICROSOFT_365_TOOLS,
} from '../../../../lib/harness-client/examples/microsoft-365.server'
import { appToolNamespace, hasAppTool } from '../../../../lib/app-tools/index.server'

/** The last `simpleLoop(controller, tools, config)` call the agent made. */
function lastLoopCall(): [unknown, string[], Record<string, unknown>] {
  return simpleLoop.mock.calls.at(-1) as [unknown, string[], Record<string, unknown>]
}

/** The tools the agent handed its loop on the last createPatterns() call. */
function composedTools(): string[] {
  return lastLoopCall()[1]
}

/** Every graph tool that exists, so the allowlist is filtering something real. */
const ALL_GRAPH_TOOLS = [
  'graph_me',
  'graph_calendar_today',
  'graph_mail_recent',
  'graph_mail_attachments',
  'graph_file_ingest',
  'graph_files_search',
  'graph_files_list',
  'graph_files_recent',
  'graph_files_shared',
]

beforeEach(() => {
  vi.clearAllMocks()
  graphNamespace = [...ALL_GRAPH_TOOLS]
})

describe('tool allowlist', () => {
  it('names the eight read tools the agent can actually use', () => {
    expect([...MICROSOFT_365_TOOLS]).toEqual([
      'graph_me',
      'graph_calendar_today',
      'graph_mail_recent',
      'graph_mail_attachments',
      'graph_files_search',
      'graph_files_list',
      'graph_files_recent',
      'graph_files_shared',
    ])
  })

  it('excludes graph_file_ingest — which exists, so the exclusion is a decision', () => {
    // If this tool ever stops being registered the assertion below is vacuous,
    // so assert it *is* there first.
    expect(hasAppTool('graph_file_ingest')).toBe(true)
    expect([...MICROSOFT_365_TOOLS]).not.toContain('graph_file_ingest')
  })

  it('lists only names that are really registered under the graph namespace', () => {
    // Catches a typo in the allowlist, which would otherwise fail silently by
    // filtering the name away at composition time.
    for (const name of MICROSOFT_365_TOOLS) {
      expect(appToolNamespace(name), `${name} is not a registered graph tool`).toBe('graph')
    }
  })
})

describe('createPatterns', () => {
  it('hands the loop the allowlist, not the whole graph namespace', async () => {
    const patterns = await microsoft365Agent.createPatterns('test-session')

    expect(composedTools()).toEqual([...MICROSOFT_365_TOOLS])
    expect(composedTools()).not.toContain('graph_file_ingest')
    expect(patterns).toHaveLength(2)
  })

  it('gives the controller the same list as the loop (no wider allowlist)', async () => {
    await microsoft365Agent.createPatterns('test-session')
    const controller = lastLoopCall()[0] as { adapterTools: string[] }
    expect(controller.adapterTools).toEqual([...MICROSOFT_365_TOOLS])
  })

  it("drops an allowlisted tool that isn't available (gateway down, module unloaded)", async () => {
    graphNamespace = ['graph_me', 'graph_files_search']
    await microsoft365Agent.createPatterns('test-session')
    expect(composedTools()).toEqual(['graph_me', 'graph_files_search'])
  })

  it('survives an empty or absent graph namespace', async () => {
    graphNamespace = []
    await microsoft365Agent.createPatterns('test-session')
    expect(composedTools()).toEqual([])
  })

  it("projects webUrl out of the controller's view for every file tool", async () => {
    await microsoft365Agent.createPatterns('test-session')
    const cfg = lastLoopCall()[2] as { resultOmit: Record<string, string[]> }
    // Every file tool the agent composes must drop webUrl (Loop hits carry a
    // ~519-char URL only the compactExecution needs) — and drop ONLY webUrl, so the
    // handoff ids and the search `hint` reach the controller.
    for (const tool of [
      'graph_files_search',
      'graph_files_list',
      'graph_files_recent',
      'graph_files_shared',
    ]) {
      expect(cfg.resultOmit[tool], `${tool} projection`).toEqual(['webUrl'])
    }
    expect(cfg.resultOmit).not.toHaveProperty('graph_mail_recent')
  })

  it('keeps the loop config the agent depends on', async () => {
    await microsoft365Agent.createPatterns('test-session')
    expect(lastLoopCall()[2]).toMatchObject({
      patternId: 'microsoft-365',
      liveEvents: true,
      rememberPriorTurns: false,
      maxTurns: 8,
    })
  })

  it('guards the graph namespace against prompt injection', async () => {
    // A per-user Graph token authenticates who FETCHED a document, not who
    // WROTE it: mail comes from outside the tenant and SharePoint files are
    // routinely authored or shared by other people. So the loop's results are
    // untrusted content on a trusted transport, and the agent must declare it.
    const patterns = await microsoft365Agent.createPatterns('test-session')

    expect(injectionGuard).toHaveBeenCalledWith({ namespaces: ['graph'] })
    // The guard wraps the LOOP (so it is active for every tool call), and the
    // chain shape is otherwise unchanged.
    expect(patterns).toHaveLength(2)
    expect((patterns[0] as { name: string }).name).toBe('withInjectionGuard(simpleLoop)')
    expect((patterns[1] as { name: string }).name).toBe('compactExecution')
  })

  it('leaves the loop config untouched when guarded (transparent wrapper)', async () => {
    const patterns = await microsoft365Agent.createPatterns('test-session')
    // Same config object the agent handed simpleLoop — the wrapper must not
    // reshape it, or resultOmit / maxTurns / liveEvents would silently change.
    expect((patterns[0] as { config: unknown }).config).toBe(lastLoopCall()[2])
  })
})
