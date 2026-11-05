/**
 * The capability guide general-next's synthesizer answers "what can you do?",
 * "help" and "how do I start?" from (`Synthesize`'s `guide`, compact-execution.baml).
 *
 * Built from the SAME tool lists the agent's routes run with, so a line appears
 * only when its tool is there: a deployment whose gateway offers no web search
 * never hears itself advertise one. A tool with no line below is simply not
 * advertised, which is the safe direction for drift; a lane that adds a tool
 * namespace adds its line here. The limits line is unconditional because it is
 * true of every deployment: no Microsoft 365 write tool ships (AGENTS.md,
 * "Microsoft Graph tools read only").
 *
 * CONTRACT for any per-user tool gate (an allowlist, an opt-in namespace): it
 * must filter BEFORE the routes' tool lists are built — at discovery, so
 * `Tools()` (or the namespace resolver it is given) never returns the tool for
 * that user. The guide then cannot name it, because it reads those lists. A
 * gate that filters only at execution (the executor, `callTool`) leaves the
 * tool in the lists, and the guide would advertise a tool the user cannot run.
 * `general-next.test.ts` pins that the guide and the info route read one list.
 *
 * Pure and client-safe: no tool call, no I/O.
 */

import type { ExamplesPage } from '../types'

export interface CapabilityGuideInput {
  /** The office route's tools: the Microsoft Graph reads and the sandbox's in-VM tools. */
  office: readonly string[]
  /** The information route's tools: the exact list that route is composed with. */
  info: readonly string[]
  /** The namespace `Tools()` grouped a tool under (`neo4j`, `web`, `context7`, …). */
  namespaceOf: (tool: string) => string | undefined
  /** The agent searches this conversation's uploaded documents (its retriever route). */
  documents: boolean
  /** Per-user memory is wired on this deployment (each person still switches it on). */
  memory: boolean
  examplesPage?: ExamplesPage
}

type Tools = {
  office: ReadonlySet<string>
  neo4j: readonly string[]
  web: readonly string[]
  libraryDocs: readonly string[]
}

/** A web tool is a fetch when its name says so — general-next's own rule for its
 *  egress gate's `fetchTools`; every other web tool searches. */
const isFetch = (name: string) => name.includes('fetch')

/** One plain-words line per capability, each gated on the tools that provide it. */
const LINES: ReadonlyArray<{ when: (tools: Tools) => boolean; line: string }> = [
  {
    when: (t) => t.office.has('graph_mail_recent'),
    line: 'Read your Microsoft 365 mail, including which attachments a message has.',
  },
  {
    when: (t) => t.office.has('graph_calendar_today') || t.office.has('graph_calendar_range'),
    line: 'Read your Microsoft 365 calendar for a day or a date range.',
  },
  {
    when: (t) => [...t.office].some((name) => name.startsWith('graph_files_')),
    line: 'Find your OneDrive and SharePoint files by name, and list recent or shared ones.',
  },
  {
    when: (t) => t.office.has('graph_me'),
    line: 'Read your Microsoft 365 profile, such as your name and job title.',
  },
  {
    when: (t) => t.office.has('graph_file_ingest'),
    line: 'Copy a OneDrive or SharePoint file into the conversation to read and analyse it.',
  },
  {
    when: (t) => [...t.office].some((name) => name.startsWith('sandbox_')),
    line: 'Analyse uploaded files and numbers by running code, and create Word, Excel, CSV or Markdown files you can download.',
  },
  {
    when: (t) => t.neo4j.includes('read_neo4j_cypher'),
    line: "Answer questions about the organization's knowledge graph, such as its projects and the people on them.",
  },
  {
    when: (t) => t.web.some((name) => !isFetch(name)),
    line: 'Search the public web.',
  },
  {
    when: (t) => t.web.some(isFetch),
    line: 'Read a public web page.',
  },
  {
    when: (t) => t.libraryDocs.length > 0,
    line: 'Look up developer library documentation.',
  },
]

export function capabilityGuide(input: CapabilityGuideInput): string {
  const inNamespace = (ns: string) => input.info.filter((name) => input.namespaceOf(name) === ns)
  const tools: Tools = {
    office: new Set(input.office),
    neo4j: inNamespace('neo4j'),
    web: inNamespace('web'),
    libraryDocs: inNamespace('context7'),
  }
  const can = LINES.filter((l) => l.when(tools)).map((l) => l.line)
  if (input.documents) can.push('Search the documents uploaded to this conversation and cite them.')
  if (input.memory)
    can.push(
      'Remember what you tell it about yourself for later conversations, when memory is turned on for you.',
    )
  const out = [
    'What the assistant can do here (and nothing else):',
    ...can.map((line) => `- ${line}`),
    'What it cannot do: send mail, create or change calendar events, or edit files in Microsoft 365.',
  ]
  if (input.examplesPage)
    out.push(
      `Example questions to start with, and how each did in the latest test: [${input.examplesPage.label}](${input.examplesPage.href})`,
    )
  return out.join('\n')
}
