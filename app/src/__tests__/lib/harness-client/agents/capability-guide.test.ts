/** The onboarding guide general-next's synthesizer answers "what can you do?" from:
 *  each capability line is there only when its tool is. */
import { describe, expect, it } from 'vitest'
import {
  capabilityGuide,
  type CapabilityGuideInput,
} from '@hames-ai/agents/agents/capability-guide'

// The namespaces Tools() would group these names under (the app's mcp-catalog does).
const NAMESPACE: Record<string, string> = {
  read_neo4j_cypher: 'neo4j',
  get_neo4j_schema: 'neo4j',
  search: 'web',
  fetch: 'web',
  fetch_content: 'web',
  web_search_exa: 'web',
  'get-library-docs': 'context7',
  'resolve-library-id': 'context7',
}
const NONE: CapabilityGuideInput = {
  office: [],
  info: [],
  namespaceOf: (name) => NAMESPACE[name],
  documents: false,
  memory: false,
}

// MUTATION: make any line's `when` return true (or drop its tool test) — its "absent"
// half goes red; delete a line from LINES — its "present" half goes red.
describe('capabilityGuide gates every line on the tool that provides it', () => {
  it.each<[string, Partial<CapabilityGuideInput>, string]>([
    ['mail', { office: ['graph_mail_recent'] }, 'Read your Microsoft 365 mail'],
    ['calendar', { office: ['graph_calendar_range'] }, 'Read your Microsoft 365 calendar'],
    ['files', { office: ['graph_files_search'] }, 'Find your OneDrive and SharePoint files'],
    ['profile', { office: ['graph_me'] }, 'Read your Microsoft 365 profile'],
    ['ingest', { office: ['graph_file_ingest'] }, 'Copy a OneDrive or SharePoint file'],
    ['sandbox', { office: ['sandbox_bash'] }, 'by running code'],
    ['knowledge graph', { info: ['read_neo4j_cypher'] }, "organization's knowledge graph"],
    ['web search', { info: ['web_search_exa'] }, 'Search the public web.'],
    ['web fetch', { info: ['fetch_content'] }, 'Read a public web page.'],
    ['library docs', { info: ['get-library-docs'] }, 'developer library documentation'],
    ['documents', { documents: true }, 'Search the documents uploaded to this conversation'],
    ['memory', { memory: true }, 'Remember what you tell it'],
  ])('%s', (_name, has, line) => {
    expect(capabilityGuide({ ...NONE, ...has })).toContain(line)
    expect(capabilityGuide(NONE)).not.toContain(line)
  })

  it('a fetch-only web namespace is not advertised as search, nor a search-only one as reading pages', () => {
    expect(capabilityGuide({ ...NONE, info: ['fetch'] })).not.toContain('Search the public web')
    expect(capabilityGuide({ ...NONE, info: ['search'] })).not.toContain('Read a public web page')
  })

  // MUTATION: classify by tool name instead of `namespaceOf` (e.g. treat any name
  // containing 'search' as web) — the second case goes red.
  it('reads namespaces from namespaceOf, so a tool in a namespace with no line is not advertised', () => {
    const gated = { ...NONE, namespaceOf: (name: string) => NAMESPACE[name] ?? 'archive' }
    expect(capabilityGuide({ ...gated, info: ['search'] })).toContain('Search the public web.')
    expect(capabilityGuide({ ...gated, info: ['archive_search'] })).toBe(capabilityGuide(NONE))
  })

  it('a schema-only graph namespace is not a graph capability', () => {
    expect(capabilityGuide({ ...NONE, info: ['get_neo4j_schema'] })).not.toContain('graph')
  })
})

describe('capabilityGuide limits and the examples page', () => {
  it('always states the Microsoft 365 limits, which hold on every deployment', () => {
    expect(capabilityGuide(NONE)).toContain(
      'What it cannot do: send mail, create or change calendar events, or edit files in Microsoft 365.',
    )
  })

  // MUTATION: drop the examplesPage line from capabilityGuide — the first case goes red.
  it('links the examples page as a Markdown link, and links nothing without one', () => {
    const guide = capabilityGuide({
      ...NONE,
      examplesPage: { href: '/use-cases', label: 'Use cases' },
    })
    expect(guide.split('\n').at(-1)).toBe(
      'Example questions to start with, and how each did in the latest test: [Use cases](/use-cases)',
    )
    expect(capabilityGuide(NONE)).not.toContain('](')
  })
})
