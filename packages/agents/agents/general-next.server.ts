/** #507 S3: the decision-loop candidate, kept beside general until rollout. */
import {
  actorCritic,
  collectToolNames,
  compactExecution,
  decisionLoop,
  DECISION_LOOP_OUTPUT_KEY,
  planner,
  retriever,
  simpleLoop,
  Tools,
  withInjectionGuard,
  withMemory,
  withPseudonymisedInputs,
  withReferences,
  type ConfiguredPattern,
} from '@hames-ai/harness-patterns'
import {
  bamlPatterns,
  createActorControllerAdapter,
  createCriticAdapter,
  createDecideAdapter,
  createInjectionScreen,
  createLoopControllerAdapter,
} from '@hames-ai/harness-baml'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import type { AgentData, AgentDefinition, AgentDeps } from '../types'
import { withInfoDocumentReferences } from './info-document-references.server'
import { MICROSOFT_365_TOOLS } from './microsoft-365.server'
import { getGraphSchema } from './graph-schema.server'
import { NEO4J_READ_ONLY_CONTEXT } from './neo4j-fewshots.server'
import type { FewShot } from '@hames-ai/harness-patterns/types'

assertServerOnImport()

/** Targeted read slice of the memory MCP namespace. Its create/add/delete tools
 *  stay withheld by name, and so does `read_graph`: the memory graph is shared by
 *  every user, and that call returns all of it in one result (S3b review F3). */
const MEMORY_READ_TOOLS = ['search_nodes', 'open_nodes']

// Synthetic office examples use the same JSON envelope as the actor's output
// format. ActorMultiCalls supplies the mode-gated write-then-run batch beside
// these single calls; completion belongs to the critic, so no example uses Return.
const OFFICE_FEW_SHOTS: FewShot[] = [
  {
    user: 'Show my three most recent unread inbox messages.',
    reasoning: 'Read the inbox previews with the supplied Graph tool.',
    tool: 'graph_mail_recent',
    args: JSON.stringify({ unread_only: true, limit: 3 }),
  },
  {
    user: 'Find Excel files about the sample budget.',
    reasoning: 'Search file metadata with plain words and the Excel file-type filter.',
    tool: 'graph_files_search',
    args: JSON.stringify({ query: 'sample budget', file_type: 'xlsx' }),
  },
  {
    user: 'Create /work/out/sample.docx containing the sentence "Sample report".',
    reasoning: 'Run python-docx in a quoted heredoc and save the deliverable under /work/out.',
    tool: 'sandbox_bash',
    args: JSON.stringify({
      command:
        "python3 - <<'PY'\nfrom docx import Document\ndoc = Document()\ndoc.add_paragraph('Sample report')\ndoc.save('/work/out/sample.docx')\nprint('/work/out/sample.docx')\nPY",
    }),
  },
]

async function createPatterns(
  sessionId: string,
  deps: AgentDeps,
): Promise<ConfiguredPattern<AgentData>[]> {
  if (!deps.withSandbox) throw new Error('general-next requires deps.withSandbox')
  if (!deps.createRedisBackend) throw new Error('general-next requires deps.createRedisBackend')
  const tools = await Tools({ namespaces: deps.toolNamespaces })
  const schema = await getGraphSchema('general-next', sessionId, deps)
  const baml = bamlPatterns()

  // S-f/P4: the Graph file-to-stash path stays off until its own wiring lands.
  const available = new Set(tools.graph ?? [])
  const officeTools: string[] = MICROSOFT_365_TOOLS.filter((name) => available.has(name))
  const memoryAvailable = new Set(tools.memory ?? [])
  const memoryReads = MEMORY_READ_TOOLS.filter((name) => memoryAvailable.has(name))
  const docTools = tools.context7 ?? []
  const infoTools = [...(tools.neo4j ?? []), ...(tools.web ?? []), ...docTools, ...memoryReads]
  const office = deps.withSandbox({
    id: `${sessionId}:office`,
    sessionId,
    rootfs: 'office',
    egress: 'mcp-only',
    syncWorkspace: true,
  })(
    actorCritic<AgentData>(
      createActorControllerAdapter({
        fewShots: OFFICE_FEW_SHOTS.filter(
          (s) => s.tool.startsWith('sandbox_') || officeTools.includes(s.tool),
        ),
        contextPrefix:
          'Work on Microsoft 365 mail and files with the supplied Graph tools. ' +
          'The office sandbox has Python, python-docx, openpyxl, xlsxwriter and PyMuPDF. ' +
          'Inspect uploaded inputs in /work/in; save deliverables in /work/out so they are kept. ' +
          'Graph file ingestion is unavailable. Run code for computations. ' +
          'Use quoted heredocs for multiline Python; append when continuing a large file.',
      }),
      createCriticAdapter(),
      officeTools,
      {
        patternId: 'doc',
        liveEvents: true,
        maxRetries: 6,
        criticCadence: 3,
        multiToolCalls: 'sequential',
      },
    ),
  )
  // The sandbox host declares its in-VM names through capabilities.tools.
  // They are exact tool keys, never the unverifiable 'sandbox' namespace.
  const sandboxTools = collectToolNames(office).filter((name) => name.startsWith('sandbox_'))
  const docGuard = { namespaces: ['graph'], tools: sandboxTools, catalog: tools.all }
  // The guard refuses a declared namespace that matches no catalog tool, so the
  // two optional servers are declared only when the gateway offers them.
  const infoGuard = {
    namespaces: [
      'web',
      'neo4j',
      ...(docTools.length ? ['context7'] : []),
      ...(memoryReads.length ? ['memory'] : []),
    ],
    catalog: tools.all,
  }
  const doc = withInjectionGuard(docGuard)(office)
  const info = withInjectionGuard(infoGuard)(
    withPseudonymisedInputs({ pseudonymise: deps.pseudonymiseForWeb })(
      withInfoDocumentReferences(
        withReferences<AgentData>(
          simpleLoop<AgentData>(
            createLoopControllerAdapter(
              NEO4J_READ_ONLY_CONTEXT +
                '\n\nWhen you Return, include the URLs of the sources you used as Markdown links ' +
                'alongside the facts they support. Copy each source URL verbatim from the ' +
                'tool results or from the url argument of a successful fetch; never invent or ' +
                'construct a URL. If none of the sources you used has a URL (for example a ' +
                'graph, memory or library-docs lookup), include no link. ' +
                'Your Return is the source record used to write the final answer, so URLs ' +
                'left only in tool calls will not reach that answer.',
            ),
            infoTools,
            {
              patternId: 'info',
              schema,
              liveEvents: true,
              returnStyle: 'answer',
              rememberPriorTurns: false,
            },
          ),
          {
            patternId: 'info',
            selector: baml.selector,
            source: ['retriever', 'info'],
            // simpleLoop reads user_message from this view, so keep the task
            // alongside the allowed siblings rather than the last pattern alone.
            viewConfig: { fromLast: false, fromLastNTurns: 1 },
            liveEvents: true,
          },
        ),
      ),
    ),
  )
  const retrieve = withInjectionGuard({ tools: ['retriever'] })(
    retriever<AgentData>({
      patternId: 'retriever',
      backends: [deps.createRedisBackend(sessionId)],
      generateQuery: true,
      rewrite: baml.retrieveQuery,
      liveEvents: true,
    }),
  )
  const plannableTools = [...new Set([...collectToolNames(office), ...infoTools])]
  const think = planner<AgentData>(baml.planner(plannableTools), plannableTools, {
    patternId: 'think',
    schema,
    liveEvents: true,
  })
  const orchestrator = withInjectionGuard({
    namespaces: [...infoGuard.namespaces, ...docGuard.namespaces],
    tools: [...sandboxTools, 'retriever', DECISION_LOOP_OUTPUT_KEY],
    catalog: tools.all,
    spotlight: 'always',
    screen: createInjectionScreen(),
    screenDespiteFindings: true,
  })(
    decisionLoop<AgentData>(
      {
        'office-data': {
          pattern: doc,
          description:
            'Read Microsoft 365 mail and file metadata; run code over uploaded files (spreadsheets, CSV, tables) to compute or analyse them, and save deliverables in the office sandbox',
          capability:
            'Read Microsoft 365 mail and file metadata; compute and create files in the office sandbox. Graph file ingestion is unavailable.',
        },
        'info-retrieval': {
          pattern: info,
          description:
            'Look things up in the knowledge graph, on the web, in library docs and in the memory graph; it cannot open a file the user uploaded or names (that is read-documents)',
          capability:
            'Read the knowledge graph and the memory graph; search or fetch public web sources and library documentation.',
          siblingResults: ['retriever'],
        },
        'read-documents': {
          pattern: retrieve,
          description:
            'Search uploaded and indexed documents in this conversation, including any file the user names (such as notes.md or a PDF), and return cited excerpts; use it whenever part of the answer must come from such a file',
          capability: 'Search this conversation’s Data Stash and return cited excerpts.',
        },
        think: {
          pattern: think,
          description: 'Decide the steps before acting',
          capability: 'Write or revise a plan using the agent map and earlier step results.',
        },
      },
      {
        decide: createDecideAdapter(),
        answer:
          'Generate the answer for the user now, from the conversation and any results so far',
        handoff: { lastN: 2 },
        maxIterations: 6,
        patternId: 'orchestrator',
        liveEvents: true,
      },
    ),
  )
  const patterns = [
    orchestrator,
    compactExecution<AgentData>({
      mode: 'thread',
      patternId: 'response-synth',
      // Records of the previous turn too (`threadTurns`), but errors of this turn only.
      viewConfig: { fromPatterns: ['orchestrator'], fromLastNTurns: 1 },
      threadTurns: 2,
      synthesize: baml.synthesize,
      liveEvents: true,
    }),
  ]
  // Only synthesis consumes memory; decisionLoop builds fresh, memory-free child data.
  return deps.memory ? withMemory<AgentData>(deps.memory)(patterns) : patterns
}

export const generalNextAgent: AgentDefinition = {
  id: 'general-next',
  name: 'General Agent · Next',
  description:
    'Moves between Microsoft 365, an office sandbox, the knowledge graph, web and uploaded documents',
  welcome:
    'I can look up information, search your uploaded documents, read Microsoft 365 mail, ' +
    'and run code in an office sandbox. I choose the next step from what the last one found.',
  servers: [
    'neo4j-cypher',
    'web_search',
    'fetch',
    'context7',
    'memory (read-only)',
    'graph (app-side, per-user)',
    'office sandbox',
    'Data Stash',
  ],
  usesSandbox: true,
  createPatterns,
}
