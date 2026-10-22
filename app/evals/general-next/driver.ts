/** Real package agent + real harness, with synthetic dependencies on every tool edge. */
import type { AgentDefinition, AgentDeps } from '@hames-ai/agents'
import type { MCPToolDescription } from '@hames-ai/harness-patterns'
import type { ConversationDriver, ConversationScenario, ConversationTrace } from './types'
import { agentModuleUrl } from '../../src/lib/eval-support/package-layout'
import { liveDescriptions } from '../../src/lib/eval-support/live-descriptions'
import {
  SANDBOX_FILE_TOOLS,
  createSyntheticSandbox,
} from '../../src/lib/eval-support/synthetic-sandbox'
import type { fixtureInference } from './fixture-inference'

const NOTES =
  'Lantern release date: 2030-04-12. Target count: 50. North revenue: 47. South revenue: 19. Hosting overspend: 5.'
const FIXTURES: Record<string, unknown> = {
  get_neo4j_schema: [{ label: 'Project', properties: { name: 'STRING' } }],
  read_neo4j_cypher: [{ count: 42 }],
  search: [{ title: 'Lantern release notes', url: 'https://example.invalid/lantern' }],
  fetch: 'Lantern version 2 adds CSV export.',
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
  const { withRunFrame, amendRunFrame } =
    await import('@hames-ai/harness-patterns/run-frame.server')
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
          : `Synthetic ${name}; returns fixed Lantern fixture data.`,
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
  const { createWebPseudonymiser } =
    await import('../../src/lib/harness-client/web-pseudonymiser.server')
  // The production classifier too (ruling O): the graph's rows are internal, and no fixture
  // Microsoft 365 result carries the connector's provenance stamp, so every one is external.
  const { classifyIngress } = await import('../../src/lib/harness-client/ingress-classifier.server')
  const dispose = registerTransport(transport)
  const deps: AgentDeps = {
    toolNamespaces: transport.namespaceFor,
    clientOverride: clientOverrideFor,
    pseudonymiseForWeb: createWebPseudonymiser({ directory: 'none' }),
    classifyIngress,
    withSandbox: () => (pattern) => ({
      ...pattern,
      children: [pattern],
      fn: (scope, view) =>
        amendRunFrame({ transports: [sandboxTransport] }, () => pattern.fn(scope, view)),
    }),
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
          const patterns = await agent.createPatterns(sessionId, deps)
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
