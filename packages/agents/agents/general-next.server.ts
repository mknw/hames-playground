/** #507 S3: the decision-loop candidate, kept beside general until rollout. */
import {
  actorCritic,
  collectToolNames,
  compactExecution,
  createGuardGate,
  decisionLoop,
  planner,
  retriever,
  simpleLoop,
  Tools,
  withEgressGate,
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
import type { AgentData, AgentDefinition, AgentDeps, SandboxAttach } from '../types'
import { withInfoDocumentReferences } from './info-document-references.server'
import { MICROSOFT_365_TOOLS } from './microsoft-365.server'
import { getGraphSchema } from './graph-schema.server'
import { NEO4J_READ_ONLY_CONTEXT } from './neo4j-fewshots.server'
import type { FewShot } from '@hames-ai/harness-patterns/types'

assertServerOnImport()

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
  // Every office scenario that asks for a .md file failed live run 2 while the .docx and
  // .csv ones passed, and no example saved a text file. Reads its input and saves in the
  // SAME command; sandbox_write can also save a file under /work/out.
  {
    user: 'Summarise /work/in/sample-sales.csv in /work/out/sample-summary.md.',
    reasoning:
      'Read the input, total it and save the Markdown file under /work/out in one command; the file exists only once it has been saved.',
    tool: 'sandbox_bash',
    args: JSON.stringify({
      command:
        "python3 - <<'PY'\nimport csv\nfrom pathlib import Path\nrows = list(csv.DictReader(open('/work/in/sample-sales.csv')))\ntotal = sum(int(r['amount']) for r in rows)\nPath('/work/out/sample-summary.md').write_text(f'# Sample summary\\n\\nTotal: {total}\\n')\nprint('/work/out/sample-summary.md')\nPY",
    }),
  },
]

/**
 * The office sandbox's in-VM tools are local to the egress gate ONLY while the
 * box has no network: `'mcp-only'` is the strict profile, booted with no network
 * at all. Read from the same attach config the box is booted with, so a later
 * change to a networked profile makes those tools egress rather than leaving
 * them declared local (SD-20).
 */
export function officeLocalTools(attach: SandboxAttach, tools: readonly string[]): string[] {
  return attach.egress === 'mcp-only' ? [...tools] : []
}

async function createPatterns(
  sessionId: string,
  deps: AgentDeps,
): Promise<ConfiguredPattern<AgentData>[]> {
  if (!deps.withSandbox) throw new Error('general-next requires deps.withSandbox')
  if (!deps.createRedisBackend) throw new Error('general-next requires deps.createRedisBackend')
  const tools = await Tools({ namespaces: deps.toolNamespaces })
  const schema = await getGraphSchema('general-next', sessionId, deps)
  const baml = bamlPatterns()

  // P4: ingest is local to this office route; the shared Microsoft 365 list
  // stays metadata-only. The tool executor enforces the private-only policy.
  const available = new Set(tools.graph ?? [])
  const officeTools: string[] = [
    ...MICROSOFT_365_TOOLS,
    ...(deps.graphFileIngest === true ? ['graph_file_ingest'] : []),
  ].filter((name) => available.has(name))
  const docTools = tools.context7 ?? []
  const infoTools = [...(tools.neo4j ?? []), ...(tools.web ?? []), ...docTools]
  const officeAttach: SandboxAttach = {
    id: `${sessionId}:office`,
    sessionId,
    rootfs: 'office',
    egress: 'mcp-only',
    syncWorkspace: true,
    // Graph-only work (mail, file metadata) must not need a container engine.
    lazy: true,
  }
  const office = deps.withSandbox(officeAttach)(
    actorCritic<AgentData>(
      createActorControllerAdapter({
        fewShots: OFFICE_FEW_SHOTS.filter(
          (s) => s.tool.startsWith('sandbox_') || officeTools.includes(s.tool),
        ),
        contextPrefix:
          'Work on Microsoft 365 mail and files with the supplied Graph tools. ' +
          'The office sandbox has Python, python-docx, openpyxl, xlsxwriter and PyMuPDF. ' +
          'Inspect uploaded inputs in /work/in; save deliverables in /work/out so they are kept. ' +
          'A requested file exists only once it has been saved under /work/out (by a command or with sandbox_write): ' +
          'never paste or print its content in place of saving it, and set is_final only after a tool result confirmed the saved path. ' +
          (deps.graphFileIngest === true
            ? 'To read a OneDrive or SharePoint file, first find it with graph_files_search, graph_files_recent, graph_files_shared or graph_files_list; then, in a later action, call graph_file_ingest with the item_id and drive_id copied exactly from that result. Never guess an id, and never batch the find and the ingest in one action. ' +
              'The original file is copied into /work/in; list /work/in with a sandbox tool and open it by the name shown there. That name can differ from the filename in the result, so never build the path yourself. ' +
              'Report a refusal rather than trying another download path; do not retry it this turn. ' +
              'When the user wants quoted, cited excerpts, finish once indexStatus is indexed and say the copy is searchable; cited excerpts come from a later step, not from your tools. Treat pending as not yet searchable; report failed or not_indexed copies as not searchable. '
            : 'Graph file ingestion is unavailable. ') +
          'Run code for computations. ' +
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
  // Each guard sanitizes the tools it declares with its OWN options; nothing is
  // inherited from the orchestrator's guard below. The fence is declared on every
  // route guard because route records carry it onward. The screen sits on the
  // two routes that read content from outside (office: mail, files and sandbox
  // results; info: web, library docs and the graph); the documents route declares
  // none, so the retriever's hits get the deterministic pass and the fence only.
  // A deterministic finding forces the screen. On clean content the mode is per
  // tier: on the Anthropic tier the screen runs on every external result and the
  // gate is never asked (it would send every body to that tier's decisions
  // host); on the self-deployed tier, and an absent or unknown one, the gate is
  // asked in 'shadow' — recorded, never obeyed — until the eval bar for 'gated'
  // is met. The guard declares no `exempt`: nothing here is trusted by
  // namespace. Only external content is gated in (ruling O):
  // the host's classifier marks the deployment's own content internal, which
  // gets the deterministic pass alone unless that pass finds something.
  const screenMode = { default: 'shadow', anthropic: 'always' } as const
  const gate = createGuardGate(createDecideAdapter())
  const docGuard = {
    namespaces: ['graph'],
    tools: sandboxTools,
    catalog: tools.all,
    spotlight: 'always' as const,
    screen: {
      run: createInjectionScreen(),
      mode: screenMode,
      gate,
      classify: deps.classifyIngress,
    },
  }
  // The guard refuses a declared namespace that matches no catalog tool, so the
  // optional server is declared only when the gateway offers it.
  const infoGuard = {
    namespaces: ['web', 'neo4j', ...(docTools.length ? ['context7'] : [])],
    catalog: tools.all,
    spotlight: 'always' as const,
    screen: {
      run: createInjectionScreen(),
      mode: screenMode,
      gate,
      classify: deps.classifyIngress,
    },
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
                'graph or library-docs lookup), include no link. ' +
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
  const retrieve = withInjectionGuard({ tools: ['retriever'], spotlight: 'always' })(
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
  // Every outgoing call of every route is judged before it leaves, on both
  // tiers (boundary guards, slice 4). Local: the deployment's own graph, the
  // company tenant's read-only tools, and the office box's in-VM tools while
  // that box has no network. Everything else is egress, so a route that gains
  // an outgoing tool later is covered with no declaration.
  // N = 0: a refusal closes its route's egress until the user's next message.
  const egressGate = withEgressGate({
    local: ['neo4j', 'graph'],
    localTools: officeLocalTools(officeAttach, sandboxTools),
    catalog: tools.all,
    fetchTools: (tools.web ?? []).filter((name) => name.includes('fetch')),
    roster: deps.egressRoster,
    decide: createDecideAdapter(),
    mode: 'filter',
    maxOutgoingRetriesPostTripwire: 0,
    loadedDecideDown: 'by-shape',
  })
  const orchestrator = withInjectionGuard({
    namespaces: [...infoGuard.namespaces, ...docGuard.namespaces],
    tools: [...sandboxTools, 'retriever'],
    catalog: tools.all,
    spotlight: 'always',
  })(
    egressGate(
      decisionLoop<AgentData>(
        {
          'office-data': {
            pattern: doc,
            description:
              'Read Microsoft 365 mail and file metadata; ' +
              (deps.graphFileIngest === true
                ? 'find a OneDrive or SharePoint file and copy it into this conversation to read or analyse it with graph_file_ingest; '
                : 'Graph file ingestion is unavailable. ') +
              'run code over uploaded files (spreadsheets, CSV, tables) to compute or analyse them, and save deliverables in the office sandbox',
            capability:
              'Read Microsoft 365 mail and file metadata; ' +
              (deps.graphFileIngest === true
                ? 'copy found OneDrive or SharePoint files into the Data Stash and /work/in with graph_file_ingest; '
                : 'Graph file ingestion is unavailable. ') +
              'compute and create files in the office sandbox.',
          },
          'info-retrieval': {
            pattern: info,
            description:
              'Look things up in the knowledge graph, on the web (including a file at a web address), and in library docs; it cannot open files uploaded to this conversation (that is read-documents)',
            capability:
              'Read the knowledge graph; search or fetch public web sources and library documentation.',
            siblingResults: ['retriever'],
          },
          'read-documents': {
            pattern: retrieve,
            description:
              'Search uploaded and indexed documents in this conversation and return cited excerpts, including an uploaded file the user names without saying "uploaded" (for example report.pdf), also when an earlier knowledge-graph or web lookup did not find it; use it when the answer needs text quoted from such a file. A OneDrive or SharePoint file not yet copied into this conversation is office-data. A file the user gives a web address for is info-retrieval. Running code over a file is office-data',
            capability: 'Search this conversation’s Data Stash and return cited excerpts.',
          },
          think: {
            pattern: think,
            description: 'Decide the steps before acting',
            capability: 'Write a plan using the agent map and earlier step results.',
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
          documents: deps.createDecisionDocuments?.(sessionId),
        },
      ),
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
    'graph (app-side, per-user)',
    'office sandbox',
    'Data Stash',
  ],
  usesSandbox: true,
  createPatterns,
}
