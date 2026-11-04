/** The onboarding guide general-next's synthesizer answers "what can you do?" from:
 *  each capability line is there only when its tool is. */
import { describe, expect, it } from 'vitest'
import {
  capabilityGuide,
  type CapabilityGuideInput,
} from '@hames-ai/agents/agents/capability-guide'

const NONE: CapabilityGuideInput = {
  office: [],
  neo4j: [],
  web: [],
  libraryDocs: [],
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
    ['knowledge graph', { neo4j: ['read_neo4j_cypher'] }, "organization's knowledge graph"],
    ['web search', { web: ['web_search_exa'] }, 'Search the public web.'],
    ['web fetch', { web: ['fetch_content'] }, 'Read a public web page.'],
    ['library docs', { libraryDocs: ['get-library-docs'] }, 'developer library documentation'],
    ['documents', { documents: true }, 'Search the documents uploaded to this conversation'],
    ['memory', { memory: true }, 'Remember what you tell it'],
  ])('%s', (_name, has, line) => {
    expect(capabilityGuide({ ...NONE, ...has })).toContain(line)
    expect(capabilityGuide(NONE)).not.toContain(line)
  })

  it('a fetch-only web namespace is not advertised as search, nor a search-only one as reading pages', () => {
    expect(capabilityGuide({ ...NONE, web: ['fetch'] })).not.toContain('Search the public web')
    expect(capabilityGuide({ ...NONE, web: ['search'] })).not.toContain('Read a public web page')
  })

  it('a schema-only graph namespace is not a graph capability', () => {
    expect(capabilityGuide({ ...NONE, neo4j: ['get_neo4j_schema'] })).not.toContain('graph')
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
