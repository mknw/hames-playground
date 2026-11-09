/** #507 S3: the decision-loop agent. It replaced the removed `general` and is the reference
 * app's default agent. Its display name, 'General Agent · Next', is kept on purpose for now: renaming it moves the
 * browser e2e's chat-view baselines, so the rename is its own owner call. */
import {
  actorCritic,
  collectToolNames,
  compactExecution,
  compactIntent,
  createIngressGuard,
  decisionLoop,
  planner,
  retriever,
  simpleLoop,
  Tools,
  toolTagsFor,
  withEgressGate,
  withInjectionGuard,
  withMemory,
  withPseudonymisedInputs,
  withReferences,
  GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE,
  type ConfiguredPattern,
} from '@hames-ai/harness-patterns'
import { withOrgKnowledge } from '@hames-ai/harness-patterns/org-knowledge-hook.server'
import {
  bamlPatterns,
  createActorControllerAdapter,
  createCriticAdapter,
  createDecideAdapter,
  createInjectionScreen,
  createLoopControllerAdapter,
  createSynthesizer,
} from '@hames-ai/harness-baml'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import type { ByTier, ScreenMode } from '@hames-ai/harness-patterns'
import { INGRESS_POLICY_DEFAULT, SCREEN_POLICY_BY_TIER } from '../types'
import type { AgentData, AgentDefinition, AgentDeps, SandboxAttach } from '../types'
import { capabilityGuide } from './capability-guide'
import { withInfoDocumentReferences } from './info-document-references.server'
import { getGraphSchema } from './graph-schema.server'
import { NEO4J_READ_ONLY_CONTEXT } from './neo4j-fewshots.server'
import { ENVELOPE_NEGATIVE_SHOT } from './fewshot-negative.server'
import type { FewShot } from '@hames-ai/harness-patterns/types'

assertServerOnImport()

/** Graph reads available to the office route, in the order advertised to its actor.
 * File ingestion is added separately when the host enables it. */
export const OFFICE_GRAPH_READ_TOOLS = [
  'graph_me',
  'graph_calendar_today',
  'graph_calendar_range',
  'graph_mail_recent',
  'graph_mail_attachments',
  'graph_files_search',
  'graph_files_list',
  'graph_files_recent',
  'graph_files_shared',
] as const

// Synthetic office examples use the same JSON envelope as the actor's output
// format. ActorMultiCalls supplies the mode-gated write-then-run batch beside
// these single calls; completion belongs to the critic, so no example uses Return.
const OFFICE_FEW_SHOTS: FewShot[] = [
  {
    user: 'List my calendar events last month (October 2026).',
    reasoning: 'Read the requested calendar date range with the supplied Graph tool.',
    tool: 'graph_calendar_range',
    args: JSON.stringify({ start: '2026-10-01', end: '2026-10-31' }),
  },
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
  // #606 gate (runs 3-4): the failing scenarios are upload → inspect →
  // analyze → deliverable, and no shot above narrates that chain. This one is
  // the expressive multi-step session: the reasoning narrates the explore and
  // inspect steps this action follows, and the demonstrated action is the
  // extract-and-deliver step per WORKSPACE_NOTE — heredoc Python, deliverable
  // written to /work/out, saved path reported. The domain is deliberately PDF
  // → docx document processing, NOT the eval scenarios' fixtures (overfitting
  // guard).
  {
    user: 'A client sent their contract as a PDF; it should have arrived in the workspace. Build an editable outline of its section headings.',
    reasoning:
      'Multi-step session: first list /work/in to see what arrived, then open the PDF to confirm it parses. This action is the extract-and-deliver step: a quoted heredoc reads the headings with pymupdf, writes the deliverable under /work/out with python-docx and prints the saved path. tool_args is a STRING containing JSON with keys double-quoted; keep is_final=false until a tool result confirms the saved path, then report the path.',
    tool: 'sandbox_bash',
    args: JSON.stringify({
      command:
        "python3 - <<'PY'\nimport pymupdf\nfrom docx import Document\npdf = pymupdf.open('/work/in/contract.pdf')\nout = Document()\nfor page in pdf:\n    for line in page.get_text().splitlines():\n        if line.strip().isupper():\n            out.add_paragraph(line)\nout.save('/work/out/contract-outline.docx')\nprint('/work/out/contract-outline.docx')\nPY",
    }),
  },
  // The contrastive negative: one shot whose user line labels run 4's captured
  // malformed form (native tool-call syntax) WRONG, with the corrected envelope
  // of the same call rendered immediately below it. Shared with the standalone
  // sandbox agent's list so the lesson cannot drift between the two.
  ENVELOPE_NEGATIVE_SHOT,
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
  const tools = await Tools({ namespaces: deps.toolNamespaces, tagsFor: deps.toolTags })
  const schema = await getGraphSchema('general-next', sessionId, deps)
  const baml = bamlPatterns()

  // P4: ingest is local to this office route. The tool executor enforces the
  // private-only policy.
  const available = new Set(tools.graph ?? [])
  const officeTools: string[] = [
    ...OFFICE_GRAPH_READ_TOOLS,
    ...(deps.graphFileIngest === true ? ['graph_file_ingest'] : []),
  ].filter((name) => available.has(name))
  const docTools = tools.context7 ?? []
  // Lenny's Data (third-party product-management archive): present only when the
  // host's opt-in transport is on (LENNYS_DATA_MCP), so absent by default.
  const pmTools = tools.lennys ?? []
  const infoTools = [...(tools.neo4j ?? []), ...(tools.web ?? []), ...docTools, ...pmTools]
  const officeAttach: SandboxAttach = {
    id: `${sessionId}:office`,
    sessionId,
    rootfs: 'office',
    egress: 'mcp-only',
    syncWorkspace: true,
    // Graph-only work (mail, file metadata) must not need a container engine.
    lazy: true,
  }
  const attachOffice = deps.withSandbox(officeAttach)
  const officeWithBudget = (maxRetries = 6) =>
    attachOffice(
      actorCritic<AgentData>(
        createActorControllerAdapter({
          fewShots: OFFICE_FEW_SHOTS.filter(
            (s) => s.tool.startsWith('sandbox_') || officeTools.includes(s.tool),
          ),
          contextPrefix:
            'Work on Microsoft 365 mail, calendar and files with the supplied Graph tools. ' +
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
          maxRetries,
          criticCadence: 3,
          multiToolCalls: 'sequential',
        },
      ),
    )
  const office = officeWithBudget()
  // The sandbox host declares its in-VM names through capabilities.tools.
  // They are exact tool keys, never the unverifiable 'sandbox' namespace.
  const sandboxTools = collectToolNames(office).filter((name) => name.startsWith('sandbox_'))
  // Each guard sanitizes the tools it declares with its OWN options; nothing is
  // inherited from the orchestrator's guard below. The fence is declared on every
  // route guard because route records carry it onward. The screen sits on the
  // two routes that read content from outside (office: mail, files and sandbox
  // results; info: web, library docs and the graph); the documents route declares
  // none, so the retriever's hits get the deterministic pass and the fence only.
  // The mode is per tier, and both tiers' default is the shared SCREEN_POLICY_BY_TIER
  // (revision 6, O35/O40): 'off', so with no switch set the ingress check is fully
  // deterministic and no model call is made — a deterministic finding forces
  // the screen only in a mode that already runs it, never past an 'off' (O41).
  // The composition root's GUARD_SCREEN / GUARD_SCREEN_ANTHROPIC switches
  // re-enable it, validated at boot against that same shared value, and accept
  // only 'off' or 'always' per tier — a set 'gated' or 'shadow' refuses boot naming
  // the change. The four core values stay reachable in a reviewed line of code.
  // The guard declares no `exempt`: nothing here is
  // trusted by namespace. Only external content is gated in (ruling O): the
  // host's classifier marks the deployment's own content internal, which gets
  // the deterministic pass alone unless that pass finds something.
  const screenMode: ByTier<ScreenMode> =
    deps.guards?.screenMode ??
    ({
      default: SCREEN_POLICY_BY_TIER.self_deployed,
      anthropic: SCREEN_POLICY_BY_TIER.anthropic,
    } as const)
  // The injection-ingress-guard classification (revision 6, O36–O38): one Decide
  // call per external payload in 'on'/'shadow', driving PRESENTATION only —
  // label + friction, never withhold. The guard gate it replaced lived here;
  // its composition is what slice 17 removed. ONE mode value on both tiers
  // (ruling AE): GUARD_INGRESS sets it, and the default — INGRESS_POLICY_DEFAULT,
  // 'off' (O35) — keeps a deployment that sets no switch fully deterministic.
  // All three guards that cover external content declare it beside their screen:
  // office (mail, files, sandbox results), info (web, library docs, the graph)
  // and the documents route — where ONE classification call per hit replaces
  // the two screen calls the screen would have cost, on a cheaper seam.
  const ingressGuard = {
    run: createIngressGuard(createDecideAdapter()),
    mode: deps.guards?.ingressMode ?? INGRESS_POLICY_DEFAULT,
  }
  const docGuard = {
    namespaces: ['graph'],
    tools: sandboxTools,
    catalog: tools.all,
    spotlight: 'always' as const,
    // The tenant's own document links, as the Graph tools write them (#784 item 6).
    sourceLinks: { namespace: 'graph', field: 'webUrl', hosts: deps.guards?.documentHosts ?? [] },
    screen: {
      run: createInjectionScreen(),
      mode: screenMode,
      classify: deps.guards?.classifyIngress,
      // A finding goes to the person where the route can pause; the office
      // route cannot (actorCritic, the sandbox), so it says so instead (O14).
      askPerson: true,
    },
    ingressGuard,
  }
  // The guard refuses a declared namespace that matches no catalog tool, so the
  // optional server is declared only when the gateway offers it.
  const infoGuard = {
    namespaces: [
      'web',
      'neo4j',
      ...(docTools.length ? ['context7'] : []),
      ...(pmTools.length ? ['lennys'] : []),
    ],
    catalog: tools.all,
    spotlight: 'always' as const,
    screen: {
      run: createInjectionScreen(),
      mode: screenMode,
      classify: deps.guards?.classifyIngress,
      // A finding goes to the person where the route can pause; the office
      // route cannot (actorCritic, the sandbox), so it says so instead (O14).
      askPerson: true,
    },
    ingressGuard,
  }
  const doc = withInjectionGuard(docGuard)(office)
  const infoWithBudget = (maxTurns?: number) => {
    const infoLoop = withInfoDocumentReferences(
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
            maxTurns,
            schema,
            liveEvents: true,
            returnStyle: 'answer',
            rememberPriorTurns: false,
            // The Neo4j tab draws a graph read inside its 1-hop neighbourhood,
            // which the host's enricher attaches here. The few-shots return
            // scalar columns (`c.name AS name`), so without it a graph answer
            // gives the tab nothing to draw. The neighbourhood is for the tab:
            // the controller's turn log leaves it out, the event keeps it.
            onToolResult: deps.enrichNeo4jResult,
            resultOmit: { read_neo4j_cypher: ['_neighborhood', '_touched'] },
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
    )
    // K5 is composed only when the host supplies a filter (the app's explicit
    // GUARD_PSEUDONYMISE=on). Default/off omits the wrapper; an absent filter
    // passed INTO the wrapper would withhold earlier content on either tier.
    // The egress gate judges what leaves either way (boundary guards slice 15).
    const pseudonymise = deps.guards?.pseudonymiseForWeb
    const infoRoute = pseudonymise ? withPseudonymisedInputs({ pseudonymise })(infoLoop) : infoLoop
    return withInjectionGuard(infoGuard)(infoRoute)
  }
  const info = infoWithBudget()
  // The documents guard declares `ingressGuard` and NOT `screen` (revision 6):
  // the citation chip is the marking surface (O39), so the retriever's hits
  // carry a classification — one Decide call per hit, where the screen would
  // have been two (content and filename) — and no screen runs there (ruling 4).
  const retrieve = withInjectionGuard({ tools: ['retriever'], spotlight: 'always', ingressGuard })(
    retriever<AgentData>({
      patternId: 'retriever',
      backends: [deps.createRedisBackend(sessionId)],
      generateQuery: true,
      rewrite: baml.retrieveQuery,
      liveEvents: true,
      // Opt-in paging (#927 slice 2): this route advances through a long
      // document across re-dispatches instead of returning the same chunks.
      page: true,
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
  // N and τe are the composition root's GUARD_EGRESS_* settings (#844),
  // validated at boot; absent, these declared values stand.
  // A fetch address must come from the user or from content the run did not
  // compute: web pages, library docs and Microsoft 365 data give addresses; a
  // Cypher RETURN and the office box's output do not (O21).
  const fetchTools = (tools.web ?? []).filter((name) => name.includes('fetch'))
  const egressGate = withEgressGate({
    local: ['neo4j', 'graph'],
    localTools: officeLocalTools(officeAttach, sandboxTools),
    catalog: tools.all,
    fetchTools,
    toolTags: toolTagsFor(tools.all),
    detectors: (() => {
      // Lenny's Data tools carry model-written query text to a third party, as
      // web search does, so they get the same default pair.
      const search = [...(tools.web ?? []).filter((name) => !fetchTools.includes(name)), ...pmTools]
      const pair = {
        nameMatch: deps.guards?.egressNameMatch ?? 'evidence',
        decide: deps.guards?.egressDecide ?? 'on',
      } as const
      const selected = deps.guards?.egressTools ?? search
      const exact: Record<string, typeof pair> = {}
      const tags: Record<string, typeof pair> = {}
      for (const selector of selected) {
        if (selector.startsWith('tag:')) tags[selector.slice(4)] = pair
        else exact[selector] = pair
      }
      return { default: { nameMatch: 'off', decide: 'off' } as const, tools: exact, tags }
    })(),
    // Like the info guard, context7 only when the gateway offers it: the gate
    // refuses, on every turn, a source namespace no catalog tool resolves to.
    // Lenny's Data is published third-party content, like library docs.
    addressSources: [
      'web',
      ...(docTools.length ? ['context7'] : []),
      ...(pmTools.length ? ['lennys'] : []),
      'graph',
    ],
    roster: deps.egressRoster,
    decide: createDecideAdapter(),
    // The composition root validates these bounds at boot.
    threshold: deps.guards?.egressThreshold,
    maxOutgoingRetriesPostTripwire:
      deps.guards?.maxOutgoingRetriesPostTripwire ?? GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE,
    // An attended turn asks the person where the gate would refuse; an
    // unattended one (a routine, an eval) still refuses (slice 10).
    askPerson: true,
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
            withBudget: (budget) => withInjectionGuard(docGuard)(officeWithBudget(budget)),
            description:
              'Read mail, calendar date ranges and files; compute and save files in the office sandbox; exact calculation on numbers in the user’s message is run here as code.\n' +
              (deps.graphFileIngest === true
                ? 'Tools: mail/calendar (graph_mail_recent, graph_mail_attachments, graph_calendar_today, graph_calendar_range), files (graph_files_search, graph_files_list, graph_files_recent, graph_files_shared, graph_file_ingest copies in), sandbox (run code, save deliverables), profile (graph_me).'
                : 'Tools: mail/calendar (graph_mail_recent, graph_mail_attachments, graph_calendar_today, graph_calendar_range), files (graph_files_search, graph_files_list, graph_files_recent, graph_files_shared; file copying unavailable), sandbox (run code, save deliverables), profile (graph_me).'),
            capability:
              'Read Microsoft 365 mail and file metadata; ' +
              (deps.graphFileIngest === true
                ? 'copy found OneDrive or SharePoint files into the Data Stash and /work/in with graph_file_ingest; '
                : 'Graph file ingestion is unavailable. ') +
              'compute and create files in the office sandbox. ' +
              "A file saved under /work/out is kept in this conversation's documents; this route never indexes a saved file. When asked to index one, save it and tell the user they can index a text file from the Data Stash.",
          },
          'info-retrieval': {
            pattern: info,
            withBudget: infoWithBudget,
            description:
              'Look things up in the knowledge graph, on the public web and in library docs' +
              (pmTools.length ? ", and in Lenny's Data's product-management archive" : '') +
              '; cannot open files uploaded to this conversation.\n' +
              'Tools: graph query (read_neo4j_cypher), web (search, fetch), library docs (resolve-library-id, get-library-docs)' +
              (pmTools.length ? ', product-management archive (lennys_* tools)' : '') +
              '.',
            capability:
              'Read the knowledge graph; search or fetch public web sources and library documentation' +
              (pmTools.length ? "; search Lenny's Data's newsletter and podcast archive" : '') +
              '.',
            siblingResults: ['retriever'],
          },
          'read-documents': {
            pattern: retrieve,
            description:
              'Search this conversation’s uploaded and indexed documents and return cited excerpts.\n' +
              'Tools: document retriever (Data Stash search, cited passages).',
            capability: 'Search this conversation’s Data Stash and return cited excerpts.',
          },
          think: {
            pattern: think,
            description:
              'Decide and write the steps before acting, from the agent map and earlier results.\n' +
              'Tools: none (planning only).',
            capability: 'Write a plan using the agent map and earlier step results.',
          },
        },
        {
          decide: createDecideAdapter(),
          question:
            'Which step should run next? Choose the route whose own tools perform the next step; a person’s mail, calendar and file metadata belong to Microsoft 365 tools.',
          answer:
            "Generate the answer for the user now, from the conversation and any results so far. If a route this turn already ran and its result reports the lookup could not be done (an error, not merely nothing found), choose this and answer with that reported failure instead of dispatching the route again. If the user's latest message asks for a calculation on numbers it gives, choose this only once an office-data result this turn shows the computed number: the answer is that number",
          handoff: { lastN: 2 },
          maxIterations: 6,
          patternId: 'orchestrator',
          liveEvents: true,
          documents: deps.createDecisionDocuments?.(sessionId),
          quoteMemories: deps.quoteMemoriesToDecider,
          // The answer writer reads each route call's complete trace this turn,
          // not its capped record (#1032); the decisions model keeps the records.
          writerEvidence: 'trace',
        },
      ),
    ),
  )
  // "What can you do?" is answered from what this composition actually holds,
  // read from the lists the routes run with (capability-guide.ts states the
  // contract a per-user tool gate must keep): the office route's Graph and
  // sandbox tools, the info route's tools under Tools()'s own namespaces, the
  // retriever route, memory if wired, and the host's page of example questions.
  const guided = createSynthesizer({
    guide: capabilityGuide({
      office: collectToolNames(office),
      info: infoTools,
      namespaceOf: (name) =>
        Object.entries(tools).find(([ns, list]) => ns !== 'all' && list?.includes(name))?.[0],
      documents: true,
      memory: deps.memory !== undefined,
      examplesPage: deps.examplesPage,
    }),
  })
  const patterns = [
    // One resolved intent per turn (#1006): the compact-intent step runs FIRST,
    // every turn `continueSession` re-runs the chain, so `data.intent` is always
    // THIS turn's brief — never turn 1's. describe role: DescribeAnthropic on
    // the Anthropic tier, SmallQwen on the private tier, via the adapter's
    // clientOverrideFor('describe'). Skipped entirely (no call) on a
    // conversation's first turn; on a failed call it clears the intent and the
    // routes run on the raw message, as before #1006. The brief is the ROUTES'
    // task only: the synthesizer below answers what the user said.
    compactIntent<AgentData>(baml.compactIntent, {
      patternId: 'intent',
      liveEvents: true,
    }),
    orchestrator,
    compactExecution<AgentData>({
      mode: 'thread',
      patternId: 'response-synth',
      // Records of the previous turn too (`threadTurns`), but errors of this turn only.
      viewConfig: { fromPatterns: ['orchestrator'], fromLastNTurns: 1 },
      threadTurns: 2,
      // The guide rides only a turn that ran no route (`stepsThisTurn` 0):
      // onboarding is answered directly, and a turn with tool results does not
      // pay ~400 uncached prompt tokens for a block it is told to ignore.
      // INTENT is the user's own message, never the compact-intent brief
      // (#1006): the answer is to what the user said, as before #1006 —
      // `compactExecution` would otherwise read `data.intent` first.
      synthesize: (input) => {
        const own = { ...input, intent: input.userMessage }
        return own.stepsThisTurn ? baml.synthesize(own) : guided(own)
      },
      liveEvents: true,
    }),
  ]
  // Synthesis and the decisions model read memory (the latter its text only where the
  // host's tier line allows, a count elsewhere); decisionLoop builds fresh, memory-free
  // child data, so no route reads it.
  const remembered = deps.memory ? withMemory<AgentData>(deps.memory)(patterns) : patterns
  // The organizational-knowledge hook: an opt-in the host settles after the
  // reply; it changes nothing about how a pattern runs (slice 4).
  return deps.orgKnowledge ? withOrgKnowledge()(remembered) : remembered
}

export const generalNextAgent: AgentDefinition = {
  id: 'general-next',
  egressPolicy: 'gate',
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
    'lennys-data (app-side, hosted, opt-in)',
    'graph (app-side, per-user)',
    'office sandbox',
    'Data Stash',
  ],
  usesSandbox: true,
  createPatterns,
}
