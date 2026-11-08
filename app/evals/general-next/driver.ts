/** Real package agent + real harness, with synthetic dependencies on every tool edge. */
import type { AgentDefinition, AgentDeps, AgentGuards } from '@hames-ai/agents'
import type { MCPToolDescription } from '@hames-ai/harness-patterns'
import type { MemoryRecalledEventData } from '@hames-ai/harness-patterns/types'
import type { ConversationDriver, ConversationScenario, ConversationTrace } from './types'
import { agentModuleUrl } from '../../src/lib/eval-support/package-layout'
import { liveDescriptions } from '../../src/lib/eval-support/live-descriptions'
import { projectCountArgs } from '../../src/lib/eval-support/tool-arguments'
import { USE_CASES_LABEL, USE_CASES_PATH } from '../../src/lib/use-cases'
import {
  SANDBOX_FILE_TOOLS,
  createSyntheticSandbox,
  createSyntheticWithSandbox,
  indexForUser,
  stashSearchable,
} from '../../src/lib/eval-support/synthetic-sandbox'
import {
  EVAL_OWNER,
  SEED_MEMORIES,
  createSyntheticEmbedder,
  createSyntheticMemoryStore,
  syntheticMemoryConfig,
} from '../../src/lib/eval-support/synthetic-memory'
import type {
  MemoryOwnerId,
  MemoryScenario,
  MemoryTurnTrace,
} from '../../src/lib/eval-support/memory-scenario'
import { fetchEnvelope, fetchRefusal } from '../../src/lib/eval-support/fetch-envelope'
import type { fixtureInference } from './fixture-inference'
import type {
  OrgDraftCall,
  OrgScenario,
  OrgTurnTrace,
} from '../../src/lib/eval-support/org-scenario'

const NOTES =
  'Lantern release date: 2030-04-12. Target count: 50. North revenue: 47. South revenue: 19. Hosting overspend: 5.'
// What the person uploaded before turn 1, seeded into every scenario's stash.
const UPLOADS = new Map([
  ['lantern-notes.md', NOTES],
  ['lantern-sales.csv', 'region,revenue\nNorth,47\nSouth,19\n'],
])
const UPLOADED: ReadonlySet<string> = new Set(UPLOADS.keys())
/** The shared uploads plus a scenario's own (#1032's 48 brings a document of its own). */
const uploadedFor = (scenario: ConversationScenario | undefined): ReadonlySet<string> =>
  scenario?.uploads ? new Set([...UPLOADED, ...Object.keys(scenario.uploads)]) : UPLOADED
// 07-follow-up-success (owner option 2, rebuilt per the owner's shape-probe directive; the
// people fixture is TASK Q, #808): the per-entity structure is DERIVED from a read-only
// shape probe of the dev graph — labels, relationship types, property vocabulary, the
// participant-bearing pattern (typed relationships, not a property; there is no popularity
// property either) and the hub/isolated degree distribution — with every observable
// identity replaced by invented common nouns before anything landed here (the probe read
// no node names at all). The reworded follow-up ("the three projects with the most people
// working on them") needed what the probed vocabulary does not carry — the dev graph's
// people are org-governed, so the probe read no person-bearing type — so the miniature
// gained the ONE deliberate addition: a Person label and a directed WORKS_ON involvement
// relationship, person → project, one per person. Per-project people counts: Dune 3,
// Birch 2, Cedar 2, Ember 1 — the top three (Dune, Birch, Cedar) are unambiguous, the
// rank-3/rank-4 boundary does not straddle a tie (2 > 1), and "who is involved" is the
// union of the top three's WORKS_ON in-neighbours. A project's non-involvement
// relationships stay reciprocal, so their structure reads the same directed or
// undirected. The triples below are raw graph data, never a pre-ranked or aggregated
// result: the ranking and the people must be computed from them, and the shape
// deliberately does not mirror the controller's degree-aggregation few-shot (a
// pre-aggregated {name, degree} table).
const GRAPH_RELATIONSHIPS = [
  { from: 'Alder', type: 'USES', to: 'Dune' },
  { from: 'Dune', type: 'RUNS_ON', to: 'Alder' },
  { from: 'Alder', type: 'CONNECTS_TO', to: 'Ember' },
  { from: 'Ember', type: 'CONNECTS_TO', to: 'Alder' },
  { from: 'Alder', type: 'EXPOSES', to: 'Fern' },
  { from: 'Fern', type: 'USES', to: 'Alder' },
  { from: 'Birch', type: 'IMPLEMENTS', to: 'Gulf' },
  { from: 'Gulf', type: 'CONNECTS_TO', to: 'Birch' },
  { from: 'Birch', type: 'USES', to: 'Haven' },
  { from: 'Haven', type: 'RUNS_ON', to: 'Birch' },
  { from: 'Cedar', type: 'EXPOSES', to: 'Iris' },
  { from: 'Iris', type: 'USES', to: 'Cedar' },
  { from: 'Cedar', type: 'FALLS_BACK_TO', to: 'Juniper' },
  { from: 'Juniper', type: 'FALLS_BACK_TO', to: 'Cedar' },
  // WORKS_ON (person → project): the involvement data the reworded follow-up ranks and
  // reads. Every person works on exactly ONE project, so a project's people count is its
  // WORKS_ON in-degree; no filler project carries a person, so the isolated remain
  // isolated and the expected answer stays derivable from these triples alone.
  { from: 'Zenith', type: 'WORKS_ON', to: 'Dune' },
  { from: 'Nadir', type: 'WORKS_ON', to: 'Dune' },
  { from: 'Apogee', type: 'WORKS_ON', to: 'Dune' },
  { from: 'Perigee', type: 'WORKS_ON', to: 'Birch' },
  { from: 'Azimuth', type: 'WORKS_ON', to: 'Birch' },
  { from: 'Meridian', type: 'WORKS_ON', to: 'Cedar' },
  { from: 'Solstice', type: 'WORKS_ON', to: 'Cedar' },
  { from: 'Equinox', type: 'WORKS_ON', to: 'Ember' },
]
// The miniature graph's node rows (R6DIAG row 07): a node-property query (RETURN p.name,
// p.observations) used to get the relationship triples too, and the controller concluded
// "the graph might be structured differently than the schema suggests". Run 7 sharpened
// the defect: the rows covered only the triples' ten endpoints while the count anchor
// said 42, and the child — having just caught its data inconsistent — declined the
// follow-up outright. The rows now AGREE with the anchor: 42 Project nodes, of which the
// ten named participants carry every graded relationship and the remaining 32 are
// isolated (degree 0, so none can be among the three most popular and the expected
// answers stay derivable from GRAPH_RELATIONSHIPS alone). Names are invented,
// deterministic and identity-free; nothing here carries a graded fact or a relationship
// endpoint.
const GRAPH_NODES = [
  'Alder',
  'Birch',
  'Cedar',
  'Dune',
  'Ember',
  'Fern',
  'Gulf',
  'Haven',
  'Iris',
  'Juniper',
  'Acacia',
  'Aspen',
  'Baobab',
  'Bamboo',
  'Beech',
  'Catalpa',
  'Chestnut',
  'Dogwood',
  'Elm',
  'Fir',
  'Hawthorn',
  'Hazel',
  'Larch',
  'Linden',
  'Mahogany',
  'Mangrove',
  'Maple',
  'Oak',
  'Olive',
  'Palm',
  'Pine',
  'Poplar',
  'Redwood',
  'Rowan',
  'Sassafras',
  'Sequoia',
  'Spruce',
  'Sycamore',
  'Teak',
  'Walnut',
  'Willow',
  'Yew',
].map((name) => ({
  name,
  observations: ['Provisioned at fixture setup', 'No recorded findings'],
}))
// The miniature graph's Person rows (TASK Q, #808): the people the reworded follow-up's
// answer names. Same invented, identity-free, no-real-names rule as GRAPH_NODES, in a
// separate noun family (celestial/geometric), so a person name can never collide with a
// project name and the two row sets stay tellable apart. One row per WORKS_ON triple's
// person, same Project-row shape.
const GRAPH_PEOPLE = [
  'Zenith',
  'Nadir',
  'Apogee',
  'Perigee',
  'Azimuth',
  'Meridian',
  'Solstice',
  'Equinox',
].map((name) => ({
  name,
  observations: ['Provisioned at fixture setup', 'No recorded findings'],
}))
const FIXTURES: Record<string, unknown> = {
  // The probed get_neo4j_schema shape (an object keyed by label and relationship type;
  // property names and types are the probed vocabulary). No per-label count: a count on
  // the schema would answer the turn-1 ask without the tool call and fail the scenario's
  // arg grading.
  get_neo4j_schema: {
    Project: {
      type: 'node',
      properties: {
        name: { indexed: false, type: 'STRING' },
        observations: { indexed: false, type: 'LIST' },
      },
      relationships: {
        USES: { direction: 'out', labels: ['Project'] },
        CONNECTS_TO: { direction: 'out', labels: ['Project'] },
        RUNS_ON: { direction: 'out', labels: ['Project'] },
        IMPLEMENTS: { direction: 'out', labels: ['Project'] },
        EXPOSES: { direction: 'out', labels: ['Project'] },
        FALLS_BACK_TO: { direction: 'out', labels: ['Project'] },
        WORKS_ON: { direction: 'in', labels: ['Person'] },
      },
    },
    Person: {
      type: 'node',
      properties: {
        name: { indexed: false, type: 'STRING' },
        observations: { indexed: false, type: 'LIST' },
      },
      relationships: {
        WORKS_ON: { direction: 'out', labels: ['Project'] },
      },
    },
    USES: { type: 'relationship', count: 4 },
    CONNECTS_TO: { type: 'relationship', count: 3 },
    RUNS_ON: { type: 'relationship', count: 2 },
    IMPLEMENTS: { type: 'relationship', count: 1 },
    EXPOSES: { type: 'relationship', count: 2 },
    FALLS_BACK_TO: { type: 'relationship', count: 2 },
    WORKS_ON: { type: 'relationship', count: 8 },
  },
  // 03-web-read (#775): the canned web result is the POPULAR package the scenario now
  // asks about. The seeded lantern-notes.md stays as the LOCAL decoy — its content does
  // not answer this question, so the state lists a wrong document rather than a route.
  search: [{ title: 'Next.js release notes', url: 'https://nextjs.org/blog/next-15-5' }],
  fetch: 'Next.js version 15.5 makes Turbopack the default bundler for development.',
  'resolve-library-id': { libraryId: '/solidjs/solid' },
  'get-library-docs': 'const [count, setCount] = createSignal(0)',
  graph_mail_recent: [
    {
      id: 'mail-lantern-1',
      subject: 'Lantern launch',
      body: 'Launch checklist: verify CSV export; publish notes.',
    },
  ],
  // #1006 scenario 46: the office route's file finder. Invented file names only;
  // the two kinds the follow-up re-points the search at.
  graph_files_search: [
    { name: 'q3-budget-summary.xlsx', kind: 'budget summary' },
    { name: 'q4-budget-summary.xlsx', kind: 'budget summary' },
    { name: 'q3-budget-forecast.xlsx', kind: 'budget forecast' },
    { name: 'q4-budget-forecast.xlsx', kind: 'budget forecast' },
  ],
}
const NAMESPACES: Record<string, string> = {
  get_neo4j_schema: 'neo4j',
  read_neo4j_cypher: 'neo4j',
  write_neo4j_cypher: 'neo4j',
  search: 'web',
  fetch: 'web',
  'resolve-library-id': 'context7',
  'get-library-docs': 'context7',
  graph_mail_recent: 'graph',
  // Owned by the synthetic transport, with NO shared fixture: a row that calls it
  // brings its own payload in `toolData` (45 does), so no row reads another's day.
  graph_calendar_today: 'graph',
  // #1006 scenario 46: the office route's file finder, served by the shared
  // fixture result like every other graph read here.
  graph_files_search: 'graph',
  sandbox_bash: 'sandbox',
  sandbox_write: 'sandbox',
  sandbox_read: 'sandbox',
  sandbox_list: 'sandbox',
  sandbox_edit: 'sandbox',
  sandbox_search: 'sandbox',
}
const isSandboxTool = (name: string) => name.startsWith('sandbox_')

export async function createDriver(
  fake?: Awaited<ReturnType<typeof fixtureInference>>,
  live = false,
  liveCatalog: MCPToolDescription[] = [],
  preload: readonly string[] = [],
): Promise<ConversationDriver> {
  // Runtime imports follow endpoint configuration; none of these run at module load.
  const { harness, continueSession, serializeContext } = await import('@hames-ai/harness-patterns')
  const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
  const { registerTransport } = await import('@hames-ai/harness-patterns/tool-transport.server')
  const { clientOverrideFor } = await import('@hames-ai/harness-baml/clients.server')
  const { guardConfig } = await import('../../src/lib/inference/guard-config.server')
  let trace: ConversationTrace
  let scenario: ConversationScenario
  let turn = 0
  const documents = new Map<string, string>()
  const fixtureDescriptions: MCPToolDescription[] = Object.keys(NAMESPACES)
    .map((name) => ({
      name,
      description:
        name === 'sandbox_bash'
          ? 'Run a shell command. Inputs: /work/in/lantern-notes.md and /work/in/lantern-sales.csv. Outputs: /work/out.'
          : name === 'get_neo4j_schema' || name === 'read_neo4j_cypher'
            ? 'Synthetic knowledge graph: a total Project count, Project node rows and canned Project relationship triples.'
            : `Synthetic ${name}; returns fixed canned fixture data.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          url: { type: 'string' },
          command: { type: 'string' },
          libraryName: { type: 'string' },
          context7CompatibleLibraryID: { type: 'string' },
        },
      },
    }))
    .map((t) => SANDBOX_FILE_TOOLS.find((f) => f.name === t.name) ?? t)
  const descriptions = live
    ? liveDescriptions(Object.keys(NAMESPACES), liveCatalog, fixtureDescriptions)
    : fixtureDescriptions
  const transport = {
    id: 'general-eval-synthetic-only',
    ownsTool: (name: string) => name in NAMESPACES && !isSandboxTool(name),
    namespaceFor: (name: string) => NAMESPACES[name],
    listTools: async () => descriptions.filter((t) => !isSandboxTool(t.name)),
    callTool: async (name: string, args: Record<string, unknown>) => {
      // The fetch server refuses an argument its schema rejects, before fetching (#989).
      const refused = name === 'fetch' ? fetchRefusal(args) : undefined
      const success =
        refused === undefined &&
        name !== 'write_neo4j_cypher' &&
        !(scenario?.failFirstTurn && turn === 0 && name === 'read_neo4j_cypher')
      trace?.tools.push({ name, args, success, turn })
      if (!success)
        return {
          success: false,
          data: null,
          error:
            refused ??
            (name === 'write_neo4j_cypher'
              ? 'Graph is read-only; write refused.'
              : 'Synthetic service unavailable; retry on the next user turn.'),
        }
      // Argument-aware where the four graph facts diverge: a TOTAL-count ask over
      // Project (the same shape the scenarios' own arg predicate grades) keeps returning
      // the pre-existing anchor `[{ count: 42 }]`, unchanged for 02/08/13 and 07 turn 1.
      // A person node query reads the Person rows; a Project node-property query reads
      // the Project rows; a relationship, involvement or degree query — anything with a
      // traversal pattern, or without property access — keeps the raw relationship
      // triples. The traversal-pattern exclusion keeps every degree/participant query —
      // including a degree-aggregation few-shot crib, whose shape must never be answered
      // with the count row — on the triples, which is also where the WORKS_ON data the
      // follow-up ranks and reads lives.
      // A scenario's own graph rows replace the argument-aware fixture below (#1032's 48).
      if (name === 'read_neo4j_cypher' && scenario?.toolData?.read_neo4j_cypher !== undefined)
        return { success: true, data: scenario.toolData.read_neo4j_cypher }
      if (name === 'read_neo4j_cypher') {
        const query = typeof args.query === 'string' ? args.query : ''
        const noTraversal = !/-\[|\]-|--/.test(query)
        const totalCount = projectCountArgs(args) && noTraversal
        const personQuery = /person/i.test(query) && noTraversal
        const nodeQuery = /\w+\.\w+/.test(query) && noTraversal
        return {
          success: true,
          data: totalCount
            ? [{ count: 42 }]
            : personQuery
              ? GRAPH_PEOPLE
              : nodeQuery
                ? GRAPH_NODES
                : GRAPH_RELATIONSHIPS,
        }
      }
      const data = scenario?.toolData?.[name] ?? FIXTURES[name]
      // A canned page reads as the production fetch server returns one (03, #775).
      if (name === 'fetch' && typeof data === 'string')
        return { success: true, data: fetchEnvelope(data, args) }
      return { success: true, data }
    },
  }
  // The runner also supplies a loopback gateway for the shared catalog read.
  const sandboxTransport = createSyntheticSandbox({
    scenario: () => scenario,
    trace: () => trace,
    turn: () => turn,
    documents,
    descriptions: descriptions.filter((t) => isSandboxTool(t.name)),
  })
  // Production factories, with no tenant directory in this synthetic eval.
  // The input filter follows GUARD_PSEUDONYMISE, default off (slice 15).
  const { createEgressRoster, createWebPseudonymiser } =
    await import('../../src/lib/harness-client/web-pseudonymiser.server')
  // The production classifier too (ruling O): the graph's rows are internal, and no fixture
  // Microsoft 365 result carries the connector's provenance stamp, so every one is external.
  const { classifyIngress } = await import('../../src/lib/harness-client/ingress-classifier.server')
  // The host's own tier line for what the Decide step may quote of recalled memory (#829):
  // the eval's frame is `self_deployed`, so 05's memory reaches the decider as text.
  const { privateDecisionRun } =
    await import('../../src/lib/harness-client/decision-documents.server')
  // The guards' bag the production agent takes, with the same settings the
  // runner counts against (#844; #938 revision 6): one `guardConfig()` read
  // shared by the bag and the runner, so the eval's classification runs at the
  // env's `GUARD_INGRESS` and its egress gate at the env's τe and N, and the
  // report's guards row is never a second env read. τi died with the gate.
  // Building the bag never logs; only `assertGuardsConfigured()` does.
  const guardNumbers = guardConfig()
  const guards: AgentGuards = {
    ingressMode: guardNumbers.ingressMode,
    egressThreshold: guardNumbers.egressThreshold,
    maxOutgoingRetriesPostTripwire: guardNumbers.maxOutgoingRetriesPostTripwire,
    pseudonymiseForWeb: guardNumbers.pseudonymise
      ? createWebPseudonymiser({ directory: 'none' })
      : undefined,
    classifyIngress,
  }
  const dispose = registerTransport(transport)
  const deps: AgentDeps = {
    toolNamespaces: transport.namespaceFor,
    clientOverride: clientOverrideFor,
    guards,
    // The egress gate's production roster, on the same `none` directory: every outgoing
    // call of every route is asked about (boundary guards slice 4).
    egressRoster: createEgressRoster({ directory: 'none' }),
    // The production wrapper's capabilities merge, on the synthetic transport: the
    // declared in-VM tool names are what `collectToolNames(office)` reads and the egress
    // gate's `localTools` honours, so without them every `sandbox_*` call was judged
    // outgoing and refused (ordiag finding, 2026-10-26).
    withSandbox: createSyntheticWithSandbox(sandboxTransport),
    // The Decide step's view of the seeded documents (#507). The eval runs on the
    // private tier only, so this is the names-bearing shape the host's source gives
    // a `'self_deployed'` run; the host's own tier line and owner check are pinned at layers
    // 1 and 2, not re-derived in a fixture.
    createDecisionDocuments: () => async () => ({
      total: documents.size,
      names: [...documents].map(([name, content], index) => ({
        id: `fixture-${name}`,
        name,
        mimeType: name.endsWith('.csv') ? 'text/csv' : 'text/markdown',
        size: content.length,
        uploadedAt: index,
        searchable: stashSearchable(name, uploadedFor(scenario), trace),
      })),
    }),
    quoteMemoriesToDecider: privateDecisionRun,
    // The production host's examples page (session.server.ts), from the same constant.
    examplesPage: { href: USE_CASES_PATH, label: USE_CASES_LABEL },
    createRedisBackend: () => ({
      name: 'redis',
      type: 'keyword',
      search: async () =>
        [...documents]
          .filter(([source]) => stashSearchable(source, uploadedFor(scenario), trace))
          .map(([source, content]) => {
            trace.retrievals.push({ source, turn })
            return {
              backend: 'redis',
              id: source,
              source,
              content,
              docId: `fixture-${source}`,
              chunkIndex: 0,
              startOffset: 0,
              endOffset: content.length,
            }
          }),
    }),
  }
  const memory = await memorySeams(live)
  const orgs = await orgSeams(live)
  const definitions = new Map<string, AgentDefinition>()
  async function loadAgent(id: string): Promise<AgentDefinition> {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('Invalid agent id')
    let agent = definitions.get(id)
    if (!agent) {
      const exports = await import(agentModuleUrl(id))
      agent = Object.values(exports).find(
        (value) => value && typeof value === 'object' && (value as AgentDefinition).id === id,
      ) as AgentDefinition | undefined
      if (!agent) throw new Error(`Agent ${id} is not available; wait for S3 registration`)
      definitions.set(id, agent)
    }
    return agent
  }
  // An agent that exists on disk but cannot load fails here, before any wake, not per job.
  try {
    for (const id of preload) await loadAgent(id)
  } catch (err) {
    dispose()
    throw err
  }
  return {
    // The same `guardConfig()` read the bag carries (revision 6: τi died
    // with the gate; the classification's mode is the shared value the run
    // and the report read).
    guards: guardNumbers,
    async run(next, key) {
      const agent = await loadAgent(key.agent)
      scenario = next
      trace = { turns: [], tools: [], artifacts: [], indexed: [], retrievals: [] }
      documents.clear()
      for (const [name, content] of UPLOADS) documents.set(name, content)
      for (const [name, content] of Object.entries(next.uploads ?? {})) documents.set(name, content)
      const sessionId = `eval-${key.agent}-${next.id}`
      return withRunFrame(
        {
          inference: { tier: 'self_deployed' },
          hitl: { attended: false },
          // A scenario's fixed clock (45): the host's per-turn slot, held for the scenario.
          ...(next.clock
            ? {
                clock: {
                  instant: Date.parse(next.clock.instant),
                  timeZone: next.clock.timeZone,
                },
              }
            : {}),
        },
        async () => {
          // Per-user memory is wired for the scenarios that name it and for no other one,
          // so no other scenario pays a recall or a store step.
          const mem = next.memory ? await memory.open(next.memory) : undefined
          // The org-knowledge hook likewise runs only for the scenarios that name it.
          const org = next.org ? await orgs.open(next.org) : undefined
          const patterns = await agent.createPatterns(
            sessionId,
            next.memory && mem ? { ...deps, memory: mem.config } : deps,
          )
          const run = harness(...patterns)
          let serialized: string | undefined
          let session = sessionId
          for (turn = 0; turn < next.messages.length; turn++) {
            // A memory scenario may start a fresh conversation, as either owner: the
            // same agent, no history, a new session id.
            const script = next.memory?.turns[turn]
            if (mem && turn > 0 && script?.newConversation) {
              session = `${sessionId}-c${mem.conversation + 1}`
              serialized = undefined
            }
            mem?.beginTurn(turn === 0 || !!script?.newConversation, script?.newConversation?.owner)
            // An org scenario may hand a later turn to the second user, in a fresh
            // conversation of their own.
            const orgScript = next.org?.turns[turn]
            if (org && turn > 0 && orgScript?.newConversation) {
              session = `${sessionId}-o${turn}`
              serialized = undefined
            }
            org?.beginTurn(orgScript?.newConversation?.owner)
            // The person indexes the promoted deliverable from the Data Stash between
            // turns (#832): the agent does not, so this is the only way it becomes
            // searchable, and only if an earlier turn saved it.
            if (turn > 0) indexForUser(next, trace)
            fake?.turn(next, turn)
            const result = serialized
              ? await continueSession(serialized, patterns, next.messages[turn])
              : await run(next.messages[turn], session)
            const events = result.context.events
            const lastUser = events.findLastIndex((e) => e.type === 'user_message')
            // The turn's own events: the store step's decisions and proposal below are
            // recorded in the memory trace, not here, so they cannot reach the route and
            // decision-cap graders.
            trace.turns.push({
              response: result.response,
              status: result.status,
              events: events.slice(lastUser),
            })
            serialized = result.serialized
            if (mem) {
              // The host's post-turn continuation: the store step, then — between turns —
              // the person's answer to its proposal, then ONE save of the context.
              await mem.endTurn(result.context, next.memory!, turn, session, next.messages[turn])
              serialized = serializeContext(result.context)
            }
            if (org) {
              // The host's post-turn continuation for the org hook: propose, then the
              // person's answer between turns, then one save of the context.
              await org.endTurn(result.context, next.org!, turn, session, next.messages[turn])
              serialized = serializeContext(result.context)
            }
          }
          if (mem) trace.memory = mem.trace()
          if (org) trace.org = org.trace()
          return trace
        },
      )
    },
    async close() {
      dispose()
    },
  }
}

/**
 * The memory seams one driver shares across scenarios — the production decide,
 * decide-all and extract adapters (so a hermetic run exercises their request shape
 * against the fixture endpoint, and a live run asks the real models), each wrapped to
 * record the state or input it was handed — and, per scenario, a fresh synthetic store
 * with the scenario's seed and switch.
 */
async function memorySeams(live: boolean) {
  const { settleMemory, memoryStoreConfig, applyMemoryProposal, readProposals, answerProposal } =
    await import('@hames-ai/harness-patterns')
  const { MEMORY_CONFIRM_KIND, MEMORY_CONFIRM_SAVE, MEMORY_CONFIRM_DISCARD } =
    await import('@hames-ai/harness-patterns/memory-store.server')
  const { createDecideAdapter, createDecideAllAdapter } =
    await import('@hames-ai/harness-baml/baml-adapters.server')
  const { createMemoryExtractAdapter } = await import('@hames-ai/harness-baml/baml-patterns.server')
  const { limitsFor } = await import('@hames-ai/harness-baml/clients.server')
  type Decide = ReturnType<typeof createDecideAdapter>
  type DecideAll = ReturnType<typeof createDecideAllAdapter>
  type Payload = import('@hames-ai/harness-patterns').MemoryProposalPayload
  type Context = Parameters<typeof settleMemory>[0]

  let inputs: string[] = []
  // A wrapper keeps the transport's `limits` and `supportedTypes`, which the decision
  // helpers read before they call it.
  const recording = <F extends Decide | DecideAll>(fn: F): F => {
    const wrapped = (async (input: { state: string }) => {
      inputs.push(input.state)
      return (fn as (i: unknown) => Promise<unknown>)(input)
    }) as unknown as F
    Object.defineProperty(wrapped, 'supportedTypes', { get: () => fn.supportedTypes })
    if (fn.limits) Object.assign(wrapped, { limits: fn.limits })
    return wrapped
  }
  const decide = recording(createDecideAdapter())
  const decideAll = recording(createDecideAllAdapter())
  const baseExtract = createMemoryExtractAdapter()
  const extract: typeof baseExtract = async (input) => {
    inputs.push(`${input.window}\n${input.latestUser}`)
    return baseExtract(input)
  }
  const embed = live
    ? (await import('../../src/lib/memory/embedder.server')).createMemoryEmbedder()
    : createSyntheticEmbedder()

  return {
    async open(scenario: MemoryScenario) {
      let owner: MemoryOwnerId = EVAL_OWNER
      let conversation = -1
      let held: { requestId: string; payload: Payload } | undefined
      const store = await createSyntheticMemoryStore(() => owner, embed, scenario.seed)
      const seed = store.snapshot()
      const turns: MemoryTurnTrace[] = []
      const config = {
        ...syntheticMemoryConfig({
          owner: () => owner,
          store,
          embed,
          enabled: scenario.enabled,
          decide,
          decideAll,
          extract,
          confirm: {
            hold: async ({ requestId, payload }) => {
              held = { requestId, payload }
            },
          },
        }),
        limits: () => limitsFor('compactExecution'),
      }
      return {
        config,
        get conversation() {
          return conversation
        },
        beginTurn(fresh: boolean, as?: MemoryOwnerId) {
          if (fresh) {
            conversation++
            owner = as ?? EVAL_OWNER
          }
          inputs = []
          held = undefined
        },
        async endTurn(
          ctx: Context,
          scenario: MemoryScenario,
          turn: number,
          session: string,
          userMessage: string,
        ) {
          const script = scenario.turns[turn]
          // `memory_recalled` is recorded once per turn: this turn's, read before the
          // store step can change a row, so the trace holds what recall actually handed on.
          const lastUser = ctx.events.findLastIndex((e) => e.type === 'user_message')
          const rows = store.snapshot()
          const recalledEvents = ctx.events
            .slice(lastUser)
            .filter((e) => e.type === 'memory_recalled')
          const recalled = recalledEvents
            .flatMap((e) => (e.data as { attached?: string[] }).attached ?? [])
            .flatMap((id) => rows.filter((r) => r.id === id))
          // Why recall attached what it did, so a live miss names its stage (05, 2026-11-04).
          const recallData = recalledEvents.at(-1)?.data as MemoryRecalledEventData | undefined
          const recall = recallData && {
            considered: recallData.considered,
            survivors: recallData.survivors,
            ...(recallData.skipped ? { skipped: recallData.skipped } : {}),
            ...(recallData.gate ? { gate: recallData.gate.label } : {}),
          }
          const report = await settleMemory(ctx, memoryStoreConfig(config), {
            conversationId: session,
          })
          const proposal = held
          if (script?.changeBeforeAnswer)
            await store.replaceContent(
              SEED_MEMORIES[script.changeBeforeAnswer.seed].id,
              script.changeBeforeAnswer.content,
            )
          let answer: MemoryTurnTrace['answer']
          const open = proposal
            ? readProposals(ctx).find(
                (r) => r.requestId === proposal.requestId && r.kind === MEMORY_CONFIRM_KIND,
              )
            : undefined
          if (proposal && open && script?.answer) {
            const refs = proposal.payload.items.map((i) => i.ref)
            answerProposal(
              ctx,
              {
                [proposal.requestId]:
                  script.answer === 'save'
                    ? {
                        choice: MEMORY_CONFIRM_SAVE,
                        flags: Object.fromEntries(refs.map((r) => [r, true])),
                      }
                    : MEMORY_CONFIRM_DISCARD,
              },
              { principal: owner, patternId: 'memory-confirm' },
            )
            if (script.answer === 'save') {
              const applied = await applyMemoryProposal(
                ctx,
                { store, embedSpace: () => embed.spaceId, enabled: () => scenario.enabled },
                { payload: proposal.payload, selected: refs },
              )
              answer = {
                choice: 'save',
                ...(applied.skipped ? { skipped: applied.skipped } : {}),
                items: applied.items.map((i) => ({
                  outcome: i.outcome,
                  ...(i.action ? { action: i.action } : {}),
                })),
              }
            } else answer = { choice: 'discard', items: [] }
          }
          turns.push({
            owner,
            conversation,
            userMessage,
            settle: {
              ...(report.skipped ? { skipped: report.skipped } : {}),
              proposed: report.proposed,
              written: report.written,
              rejected: { ...report.rejected },
            },
            ...(proposal
              ? {
                  proposal: {
                    requestId: proposal.requestId,
                    items: proposal.payload.items.map((i) => ({
                      kind: i.kind,
                      content: i.content,
                      evidence: i.evidence,
                      dedupe:
                        i.dedupe === 'new'
                          ? ('new' as const)
                          : 'reinforces' in i.dedupe
                            ? ('reinforces' as const)
                            : ('updates' as const),
                    })),
                  },
                }
              : {}),
            ...(answer ? { answer } : {}),
            recalled,
            ...(recall ? { recall } : {}),
            inputs: [...inputs],
          })
        },
        trace: () => ({ seed, final: store.snapshot(), turns }),
      }
    },
  }
}

/**
 * The org-knowledge seams one driver shares across scenarios (slice 7): the
 * production decide adapter and the `orgDraft` loop-controller adapter, each
 * recording what it was handed. A hermetic run serves them from the fixture
 * endpoint's scripted gate and draft; a live run asks the real gate and the
 * real draft loop on the private tier, with no code change. Per scenario: a
 * fresh synthetic org graph with the scenario's seeds.
 */
async function orgSeams(live: boolean) {
  const hook = await import('@hames-ai/harness-patterns/org-knowledge-hook.server')
  const { readProposals } = await import('@hames-ai/harness-patterns')
  const { answerProposal } = await import('@hames-ai/harness-patterns/hitl.server')
  const { createDecideAdapter, createLoopControllerAdapter } =
    await import('@hames-ai/harness-baml/baml-adapters.server')
  const { ORG_ONTOLOGY } = await import('../../src/lib/org-graph/ontology')
  const synthetic = await import('../../src/lib/eval-support/synthetic-org-graph')
  type Payload = import('@hames-ai/harness-patterns/org-knowledge-hook.server').OrgProposalPayload
  type Context = Parameters<typeof hook.settleOrgKnowledge>[0]

  let inputs: string[] = []
  const baseDecide = createDecideAdapter()
  const decide = (async (input: { state: string }) => {
    inputs.push(input.state)
    return (baseDecide as (i: unknown) => Promise<unknown>)(input)
  }) as unknown as typeof baseDecide
  Object.defineProperty(decide, 'supportedTypes', { get: () => baseDecide.supportedTypes })
  if (baseDecide.limits) Object.assign(decide, { limits: baseDecide.limits })
  const { amendRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
  type ControllerFn = import('@hames-ai/harness-patterns').ControllerFn
  // The draft loop runs in a scratch context whose events the graded trace never
  // holds, so its completions are recorded here for the capture (LD-23).
  let draftCalls: OrgDraftCall[] = []
  const baseController = createLoopControllerAdapter(undefined, { role: 'orgDraft' })
  const recordingController: ControllerFn = Object.assign(
    async (input: Parameters<ControllerFn>[0]) => {
      try {
        const result = await baseController(input)
        draftCalls.push({
          outcome: 'completion',
          ...(result.llmCall?.clientName !== undefined && { client: result.llmCall.clientName }),
          ...(result.llmCall?.rawOutput !== undefined && { rawOutput: result.llmCall.rawOutput }),
        })
        return result
      } catch (err) {
        const llmCall = (err as { llmCall?: { clientName?: string; rawOutput?: string } }).llmCall
        draftCalls.push({
          outcome: 'error',
          error: err instanceof Error ? err.message : String(err),
          ...(llmCall?.clientName !== undefined && { client: llmCall.clientName }),
          ...(llmCall?.rawOutput !== undefined && { rawOutput: llmCall.rawOutput }),
        })
        throw err
      }
    },
    { limits: baseController.limits },
  )
  const loop = hook.createOrgDraftLoop({ controller: recordingController })
  const mentionsMember = synthetic.syntheticMentionsMember
  const owners = { $userA: EVAL_OWNER, $userB: 'eval-other-user', $driverUserId: EVAL_OWNER }

  return {
    async open(scenario: OrgScenario) {
      let owner: MemoryOwnerId = EVAL_OWNER
      let held: { requestId: string; payload: Payload } | undefined
      const store = synthetic.createSyntheticOrgGraph(scenario.seed)
      const seed = synthetic.orgGraphSnapshot(store)
      const turns: OrgTurnTrace[] = []
      const config = {
        store,
        ontology: ORG_ONTOLOGY,
        decide,
        // The draft reads the scenario's own synthetic org graph, the one its
        // candidate is validated against — never the route's project graph.
        draft: async (input: Parameters<typeof loop>[0]) => {
          inputs.push(input.userMessage)
          return amendRunFrame({ transports: [synthetic.syntheticOrgDraftTransport(store)] }, () =>
            loop(input),
          )
        },
        owner: () => owner,
        enabled: () => true,
        mentionsMember,
        confirm: {
          hold: async ({ requestId, payload }: { requestId: string; payload: Payload }) => {
            held = { requestId, payload }
          },
        },
        // Hermetic runs fix the day so a scripted draft's dates stay valid; a live
        // run uses the day it runs.
        ...(live ? {} : { today: () => '2026-11-04' }),
      }
      const nameOfKey = (key: string) => {
        const n = store.dump().nodes.find((x) => x.key === key)
        return n
          ? (n.properties.name ?? n.properties.displayName ?? n.properties.label ?? key)
          : key
      }
      return {
        beginTurn(as?: MemoryOwnerId) {
          if (as) owner = as
          inputs = []
          draftCalls = []
          held = undefined
        },
        async endTurn(
          ctx: Context,
          s: OrgScenario,
          turn: number,
          session: string,
          userMessage: string,
        ) {
          const script = s.turns[turn]
          const report = await hook.settleOrgKnowledge(ctx, config, { conversationId: session })
          const proposal = held
          let answer: OrgTurnTrace['answer']
          const open = proposal
            ? readProposals(ctx).find(
                (r) =>
                  r.requestId === proposal.requestId && r.kind === hook.ORG_KNOWLEDGE_CONFIRM_KIND,
              )
            : undefined
          const elements = proposal
            ? proposal.payload.assertions.flatMap((a) => {
                const nameOf = new Map(
                  a.nodes.map((n) => [
                    n.element.ref,
                    n.properties.name ??
                      n.properties.displayName ??
                      n.properties.label ??
                      n.properties.text ??
                      '',
                  ]),
                )
                return [
                  ...a.nodes.map((n) => ({
                    kind: 'node' as const,
                    term: n.element.label,
                    names: [nameOf.get(n.element.ref) ?? ''],
                    verdict: n.verdict,
                    removes: [] as string[],
                  })),
                  ...a.edges.map((e) => ({
                    kind: 'edge' as const,
                    term: e.element.type,
                    names: [nameOf.get(e.element.from) ?? '', nameOf.get(e.element.to) ?? ''],
                    verdict: e.verdict,
                    removes: e.removes.map((r) => `${nameOfKey(r.from)} -> ${nameOfKey(r.to)}`),
                  })),
                ]
              })
            : []
          if (proposal && open && script?.answer) {
            const flags = proposal.payload.assertions.map((a) => `a${a.index}`)
            answerProposal(
              ctx,
              {
                [proposal.requestId]:
                  script.answer === 'add'
                    ? {
                        choice: hook.ORG_KNOWLEDGE_CONFIRM_ADD,
                        flags: Object.fromEntries(flags.map((f) => [f, true])),
                      }
                    : hook.ORG_KNOWLEDGE_CONFIRM_DISCARD,
              },
              { principal: owner, patternId: 'org-knowledge-confirm' },
            )
            if (script.answer === 'add') {
              const applied = await hook.applyOrgProposal(
                { store },
                {
                  payload: proposal.payload,
                  selected: flags,
                  actor: { userId: owner, now: new Date().toISOString() },
                },
              )
              answer = { choice: 'add', items: { ...applied.items } }
            } else answer = { choice: 'discard', items: {} }
          }
          turns.push({
            owner,
            userMessage,
            settle: {
              ...(report.skipped ? { skipped: report.skipped } : {}),
              proposed: report.proposed,
              rejected: { ...report.rejected },
            },
            ...(proposal ? { proposal: { requestId: proposal.requestId, elements } } : {}),
            ...(answer ? { answer } : {}),
            inputs: [...inputs],
            draftCalls: [...draftCalls],
          })
        },
        trace: () => ({ seed, final: synthetic.orgGraphSnapshot(store), turns, owners }),
      }
    },
  }
}
