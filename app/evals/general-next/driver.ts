/** Real package agent + real harness, with synthetic dependencies on every tool edge. */
import type { AgentDefinition, AgentDeps } from '@hames-ai/agents'
import type { MCPToolDescription } from '@hames-ai/harness-patterns'
import type { ConversationDriver, ConversationScenario, ConversationTrace } from './types'
import { agentModuleUrl } from '../../src/lib/eval-support/package-layout'
import { liveDescriptions } from '../../src/lib/eval-support/live-descriptions'
import { projectCountArgs } from '../../src/lib/eval-support/tool-arguments'
import {
  SANDBOX_FILE_TOOLS,
  createSyntheticSandbox,
  createSyntheticWithSandbox,
} from '../../src/lib/eval-support/synthetic-sandbox'
import { createSyntheticMemory, EVAL_OWNER } from '../../src/lib/eval-support/synthetic-memory'
import type { fixtureInference } from './fixture-inference'

const NOTES =
  'Lantern release date: 2030-04-12. Target count: 50. North revenue: 47. South revenue: 19. Hosting overspend: 5.'
// 07-follow-up-success (owner option 2, rebuilt per the owner's shape-probe directive): the
// per-entity structure is DERIVED from a read-only shape probe of the dev graph — labels,
// relationship types, property vocabulary, the participant-bearing pattern (typed
// relationships, not a property; there is no popularity property either, so popularity is
// relationship degree) and the hub/isolated degree distribution — with every observable
// identity replaced by invented common nouns before anything landed here (the probe read
// no node names at all). The miniature keeps the scenario's Project label so the turn-1
// total-count anchor stays derivable, and every top-tier entity's relationships are
// reciprocal, so the follow-up's answer is the same whether the model reads them directed
// or undirected. The triples below are raw graph data, never a pre-ranked or aggregated
// result: "the three most popular" and "who is involved" must be computed from them, and
// the shape deliberately does not mirror the controller's degree-aggregation few-shot
// (a pre-aggregated {name, degree} table).
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
]
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
      },
    },
    USES: { type: 'relationship', count: 4 },
    CONNECTS_TO: { type: 'relationship', count: 2 },
    RUNS_ON: { type: 'relationship', count: 2 },
    IMPLEMENTS: { type: 'relationship', count: 1 },
    EXPOSES: { type: 'relationship', count: 2 },
    FALLS_BACK_TO: { type: 'relationship', count: 2 },
  },
  // 03-web-read (#775): the canned web result is the POPULAR package the scenario now
  // asks about. The seeded lantern-notes.md stays as the LOCAL decoy — its content does
  // not answer this question, so the state lists a wrong document rather than a route.
  search: [{ title: 'Next.js release notes', url: 'https://example.invalid/nextjs' }],
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
  const { harness, continueSession } = await import('@hames-ai/harness-patterns')
  const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
  const { registerTransport } = await import('@hames-ai/harness-patterns/tool-transport.server')
  const { clientOverrideFor } = await import('@hames-ai/harness-baml/clients.server')
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
            ? 'Synthetic knowledge graph: a total Project count and canned Project relationship triples.'
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
      const success =
        name !== 'write_neo4j_cypher' &&
        !(scenario?.failFirstTurn && turn === 0 && name === 'read_neo4j_cypher')
      trace?.tools.push({ name, args, success, turn })
      if (!success)
        return {
          success: false,
          data: null,
          error:
            name === 'write_neo4j_cypher'
              ? 'Graph is read-only; write refused.'
              : 'Synthetic service unavailable; retry on the next user turn.',
        }
      // Argument-aware where the two graph facts diverge: a TOTAL-count ask over Project
      // (the same shape the scenarios' own arg predicate grades) keeps returning the
      // pre-existing anchor `[{ count: 42 }]`, unchanged for 02/08/13 and 07 turn 1. Every
      // other query gets the raw relationship triples. The traversal-pattern exclusion
      // keeps every degree/participant query — including a degree-aggregation few-shot
      // crib, whose shape must never be answered with the count row — on the triples.
      if (name === 'read_neo4j_cypher') {
        const query = typeof args.query === 'string' ? args.query : ''
        const totalCount = projectCountArgs(args) && !/-\[|\]-|--/.test(query)
        return { success: true, data: totalCount ? [{ count: 42 }] : GRAPH_RELATIONSHIPS }
      }
      return { success: true, data: FIXTURES[name] }
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
  // The production factory, so general-next's info route runs behind its real G14 filter
  // and not the fail-closed refusal an absent dep produces. `none` because the hermetic
  // run has no org graph: the directory leg is NOT covered here (live mode keeps it off
  // too, since the eval holds no tenant data). No fixture carries an identity, so no substitution runs: this proves presence only.
  const { createEgressRoster, createWebPseudonymiser } =
    await import('../../src/lib/harness-client/web-pseudonymiser.server')
  // The production classifier too (ruling O): the graph's rows are internal, and no fixture
  // Microsoft 365 result carries the connector's provenance stamp, so every one is external.
  const { classifyIngress } = await import('../../src/lib/harness-client/ingress-classifier.server')
  const dispose = registerTransport(transport)
  const deps: AgentDeps = {
    toolNamespaces: transport.namespaceFor,
    clientOverride: clientOverrideFor,
    guards: {
      pseudonymiseForWeb: createWebPseudonymiser({ directory: 'none' }),
      classifyIngress,
    },
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
        searchable: name.endsWith('.md'),
      })),
    }),
    createRedisBackend: () => ({
      name: 'redis',
      type: 'keyword',
      search: async () =>
        [...documents]
          .filter(([source]) => source.endsWith('.md'))
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
    async run(next, key) {
      const agent = await loadAgent(key.agent)
      scenario = next
      trace = { turns: [], tools: [], artifacts: [], indexed: [], retrievals: [] }
      documents.clear()
      documents.set('lantern-notes.md', NOTES)
      documents.set('lantern-sales.csv', 'region,revenue\nNorth,47\nSouth,19\n')
      const sessionId = `eval-${key.agent}-${next.id}`
      return withRunFrame(
        { inference: { tier: 'self_deployed' }, hitl: { attended: false } },
        async () => {
          // Per-user memory is on for the scenarios that name it and off for every other one,
          // so no other scenario pays a recall step.
          const patterns = await agent.createPatterns(
            sessionId,
            next.memory ? { ...deps, memory: createSyntheticMemory(() => EVAL_OWNER) } : deps,
          )
          const run = harness(...patterns)
          let serialized: string | undefined
          for (turn = 0; turn < next.messages.length; turn++) {
            fake?.turn(next, turn)
            const result = serialized
              ? await continueSession(serialized, patterns, next.messages[turn])
              : await run(next.messages[turn], sessionId)
            const events = result.context.events
            const lastUser = events.findLastIndex((e) => e.type === 'user_message')
            trace.turns.push({
              response: result.response,
              status: result.status,
              events: events.slice(lastUser),
            })
            serialized = result.serialized
          }
          return trace
        },
      )
    },
    async close() {
      dispose()
    },
  }
}
