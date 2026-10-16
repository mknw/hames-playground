/** Real package agent + real harness, with synthetic dependencies on every tool edge. */
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import type { AgentDefinition, AgentDeps } from '@hames-ai/agents'
import type { MCPToolDescription } from '@hames-ai/harness-patterns'
import type { ConversationDriver, ConversationScenario, ConversationTrace } from './types'
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
  search_nodes: [{ name: 'Lantern', release: 'LANTERN-2' }],
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
  search_nodes: 'memory',
  graph_mail_recent: 'graph',
  sandbox_bash: 'sandbox',
}

export async function createDriver(
  fake?: Awaited<ReturnType<typeof fixtureInference>>,
  live = false,
  liveCatalog: MCPToolDescription[] = [],
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
  const fixtureDescriptions: MCPToolDescription[] = Object.keys(NAMESPACES).map((name) => ({
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
  const descriptions = live
    ? Object.keys(NAMESPACES).map((name) => {
        const tool = liveCatalog.find((t) => t.name === name)
        if (!tool) throw new Error(`Production tool metadata missing: ${name}`)
        return tool
      })
    : fixtureDescriptions
  const transport = {
    id: 'general-eval-synthetic-only',
    ownsTool: (name: string) => name in NAMESPACES && name !== 'sandbox_bash',
    namespaceFor: (name: string) => NAMESPACES[name],
    listTools: async () => descriptions.filter((t) => t.name !== 'sandbox_bash'),
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
      if (name === 'sandbox_bash') {
        if (!scenario.expectedArgs?.sandbox_bash?.(args)) {
          trace.tools.at(-1)!.success = false
          return {
            success: false,
            data: null,
            error: 'Invalid synthetic shell request; no code executed.',
          }
        }
        const files = scenario.artifacts
        for (const file of files) {
          documents.set(file, NOTES)
          trace.artifacts.push(file)
          if (file.endsWith('.md')) trace.indexed.push(file)
        }
        return {
          success: true,
          data: {
            artifacts: files.map((name) => ({ name, url: `stash://fixture/${name}` })),
            stdout:
              'Synthetic transport recorded the request. Source data: North revenue 47; South revenue 19. No generated code was executed.',
            stderr: '',
            exit_code: 0,
            timed_out: false,
          },
        }
      }
      return { success: true, data: FIXTURES[name] }
    },
  }
  // The runner also supplies a loopback gateway for the shared catalog read.
  const sandboxTransport = {
    ...transport,
    id: 'general-eval-synthetic-sandbox',
    ownsTool: (name: string) => name === 'sandbox_bash',
    listTools: async () => descriptions.filter((t) => t.name === 'sandbox_bash'),
  }
  // The production factory, so general-next's info route runs behind its real G14 filter
  // and not the fail-closed refusal an absent dep produces. `none` because the hermetic
  // run has no org graph: the directory leg is NOT covered here (live mode keeps it off
  // too, since the eval holds no tenant data). No fixture carries an identity, so no substitution runs: this proves presence only.
  const { createWebPseudonymiser } =
    await import('../../src/lib/harness-client/web-pseudonymiser.server')
  const dispose = registerTransport(transport)
  const deps: AgentDeps = {
    toolNamespaces: transport.namespaceFor,
    clientOverride: clientOverrideFor,
    pseudonymiseForWeb: createWebPseudonymiser({ directory: 'none' }),
    withSandbox: () => (pattern) => ({
      ...pattern,
      children: [pattern],
      fn: (scope, view) =>
        amendRunFrame({ transports: [sandboxTransport] }, () => pattern.fn(scope, view)),
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
  return {
    async run(next, key) {
      if (!/^[a-z][a-z0-9-]*$/.test(key.agent)) throw new Error('Invalid agent id')
      let agent = definitions.get(key.agent)
      if (!agent) {
        const exports = await import(
          pathToFileURL(resolve('../packages/agents/agents', `${key.agent}.server.ts`)).href
        )
        agent = Object.values(exports).find(
          (value) =>
            value && typeof value === 'object' && (value as AgentDefinition).id === key.agent,
        ) as AgentDefinition | undefined
        if (!agent) throw new Error(`Agent ${key.agent} is not available; wait for S3 registration`)
        definitions.set(key.agent, agent)
      }
      scenario = next
      trace = { turns: [], tools: [], artifacts: [], indexed: [], retrievals: [] }
      documents.clear()
      documents.set('lantern-notes.md', NOTES)
      documents.set('lantern-sales.csv', 'region,revenue\nNorth,47\nSouth,19\n')
      const sessionId = `eval-${key.agent}-${next.id}`
      return withRunFrame({ inference: { tier: 'verda' }, hitl: { attended: false } }, async () => {
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
      })
    },
    async close() {
      dispose()
    },
  }
}
