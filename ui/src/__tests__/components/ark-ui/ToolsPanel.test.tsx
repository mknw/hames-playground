/**
 * ToolsPanel — the per-conversation code-mode tool allowlist.
 *
 * The panel is a thin, stateful editor over four server round-trips. What it
 * owns, and what these tests pin, is everything between them: the tristate
 * roll-up from a flat tool-name list to server rows and the pinned "All
 * tools" box, the "Default code mode" preset switch (on iff the selection is
 * exactly the preset), search filtering with auto-expansion, the meta-tool
 * lock, and the two gates that hide the body (no session, non-code-mode
 * agent).
 *
 * `~/lib/tool-config` is stubbed wholesale — its function exports are
 * SolidStart `"use server"` RPCs that would try to fetch. The constants are
 * re-declared here with the same shape the real module exports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@solidjs/testing-library'
import type { CatalogServer, CodedTool, CodeModeToolsState } from '~/lib/tool-config'

const DEFAULTS = ['mcp-find', 'code-mode']

const catalog: CatalogServer[] = [
  {
    key: 'neo4j-cypher',
    tools: [{ name: 'read_neo4j_cypher' }, { name: 'write_neo4j_cypher' }],
  } as CatalogServer,
  { key: 'memory', tools: [{ name: 'read_graph' }] } as CatalogServer,
  {
    key: 'github',
    secretGated: true,
    tools: [{ name: 'create_issue' }, { name: 'search_code' }],
  } as CatalogServer,
]

const state = (over: Partial<CodeModeToolsState> = {}): CodeModeToolsState => ({
  allowed: [...DEFAULTS],
  available: catalog.flatMap((s) => s.tools.map((t) => t.name)),
  defaults: DEFAULTS,
  usesCodeMode: true,
  ...over,
})

const hoisted = vi.hoisted(() => ({
  getCodeModeAllowedTools: vi.fn(),
  setCodeModeAllowedTools: vi.fn(),
  getServerCatalog: vi.fn(),
  searchMasterCatalog: vi.fn(),
  fetchCodedTools: vi.fn(),
}))

vi.mock('~/lib/tool-config', () => ({
  ...hoisted,
  MINIMAL_TOOLS: ['read_neo4j_cypher'],
  CODE_MODE_PRESET_SERVERS: ['neo4j-cypher', 'memory'],
}))

const { ToolsPanel } = await import('../../../components/ark-ui/ToolsPanel')

/** Resources resolve on microtasks; the accordion settles on a macrotask. */
const settle = async () => {
  await new Promise((r) => setTimeout(r, 30))
}

const renderPanel = async (
  props: { sessionId?: string; agentId?: string } = { sessionId: 's1' },
) => {
  const rendered = render(() => <ToolsPanel {...props} />)
  await settle()
  return rendered
}

/** The checkbox row carrying a given label. */
const checkboxFor = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLElement>('[data-scope="checkbox"][data-part="root"]')].find(
    (el) => el.textContent?.trim() === label,
  )!

/** The checkbox in a server's accordion row (the row has no label of its own). */
const serverRow = (container: HTMLElement, key: string) =>
  [...container.querySelectorAll<HTMLElement>('[data-scope="accordion"][data-part="item"]')].find(
    (el) => el.textContent?.includes(key),
  )!

const checkedState = (el: HTMLElement) =>
  el.querySelector('[data-part="control"]')!.getAttribute('data-state')

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.getCodeModeAllowedTools.mockResolvedValue(state())
  hoisted.setCodeModeAllowedTools.mockResolvedValue(undefined)
  hoisted.getServerCatalog.mockResolvedValue(catalog)
  hoisted.searchMasterCatalog.mockResolvedValue({ matches: [], total: 0 })
  hoisted.fetchCodedTools.mockResolvedValue([])
})

describe('ToolsPanel — gates', () => {
  it('asks for a conversation before configuring anything', async () => {
    const { container } = await renderPanel({})

    expect(container.textContent).toContain('Start a conversation to configure tools')
    expect(hoisted.getCodeModeAllowedTools).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Default code mode')
  })

  it('greys the body out for an agent that runs no code-mode pattern', async () => {
    hoisted.getCodeModeAllowedTools.mockResolvedValue(state({ usesCodeMode: false }))
    const { container } = await renderPanel({ sessionId: 's1', agentId: 'neo4j-agent' })

    expect(container.textContent).toContain('Tool selection applies to code-mode agents')
    expect(container.textContent).not.toContain('All tools')
  })

  it('keeps the body when the load failed outright, rather than mis-greying', async () => {
    // getCodeModeAllowedTools throwing yields state() === null, whose
    // `usesCodeMode` is undefined — the `!== false` test keeps the body.
    hoisted.getCodeModeAllowedTools.mockRejectedValue(new Error('db down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = await renderPanel()

    expect(container.textContent).toContain('All tools')
    expect(container.textContent).not.toContain('Tool selection applies to code-mode agents')
  })

  it('re-reads the allowlist when the selected agent changes', async () => {
    const { unmount } = await renderPanel({ sessionId: 's1', agentId: 'a' })
    expect(hoisted.getCodeModeAllowedTools).toHaveBeenCalledWith('s1', 'a')
    unmount()

    await renderPanel({ sessionId: 's1', agentId: 'b' })
    expect(hoisted.getCodeModeAllowedTools).toHaveBeenLastCalledWith('s1', 'b')
  })
})

describe('ToolsPanel — selection roll-up', () => {
  it('counts only data tools as selected, never the always-on meta-tools', async () => {
    hoisted.getCodeModeAllowedTools.mockResolvedValue(
      state({ allowed: [...DEFAULTS, 'read_graph'] }),
    )
    const { container } = await renderPanel()

    expect(container.textContent).toContain('1 of 5 selected')
    // The meta-tools get their own always-on strip instead.
    expect(container.textContent).toContain('Always on:')
    expect(container.textContent).toContain('mcp-find')
  })

  it('rolls a partial server selection up to an indeterminate checkbox', async () => {
    hoisted.getCodeModeAllowedTools.mockResolvedValue(
      state({ allowed: [...DEFAULTS, 'read_neo4j_cypher'] }),
    )
    const { container } = await renderPanel()

    expect(checkedState(serverRow(container, 'neo4j-cypher'))).toBe('indeterminate')
    expect(checkedState(serverRow(container, 'memory'))).toBe('unchecked')
    expect(checkedState(checkboxFor(container, 'All tools'))).toBe('indeterminate')
  })

  it('rolls a complete selection up to checked everywhere', async () => {
    hoisted.getCodeModeAllowedTools.mockResolvedValue(
      state({ allowed: [...DEFAULTS, ...catalog.flatMap((s) => s.tools.map((t) => t.name))] }),
    )
    const { container } = await renderPanel()

    expect(checkedState(checkboxFor(container, 'All tools'))).toBe('checked')
    expect(checkedState(serverRow(container, 'github'))).toBe('checked')
    expect(container.textContent).toContain('5 of 5 selected')
  })
})

describe('ToolsPanel — persisting edits', () => {
  it('adds a tool to the allowlist, always keeping the meta-tools', async () => {
    const { container } = await renderPanel()

    fireEvent.click(serverRow(container, 'memory').querySelector('[data-part="control"]')!)
    await settle()

    expect(hoisted.setCodeModeAllowedTools).toHaveBeenCalledWith('s1', [...DEFAULTS, 'read_graph'])
  })

  it('removes a fully-selected server on a second click', async () => {
    hoisted.getCodeModeAllowedTools.mockResolvedValue(
      state({ allowed: [...DEFAULTS, 'read_graph', 'create_issue'] }),
    )
    const { container } = await renderPanel()

    fireEvent.click(serverRow(container, 'memory').querySelector('[data-part="control"]')!)
    await settle()

    expect(hoisted.setCodeModeAllowedTools).toHaveBeenCalledWith('s1', [
      ...DEFAULTS,
      'create_issue',
    ])
  })

  it('selects and clears every data tool from the pinned All-tools box', async () => {
    const { container } = await renderPanel()
    const all = () => checkboxFor(container, 'All tools').querySelector('[data-part="control"]')!

    fireEvent.click(all())
    await settle()
    expect(hoisted.setCodeModeAllowedTools).toHaveBeenLastCalledWith('s1', [
      ...DEFAULTS,
      'read_neo4j_cypher',
      'write_neo4j_cypher',
      'read_graph',
      'create_issue',
      'search_code',
    ])

    fireEvent.click(all())
    await settle()
    expect(hoisted.setCodeModeAllowedTools).toHaveBeenLastCalledWith('s1', DEFAULTS)
  })

  it('applies and clears the preset from the Default code mode switch', async () => {
    const { container } = await renderPanel()
    const toggle = () =>
      container.querySelector<HTMLElement>('[data-scope="switch"][data-part="control"]')!

    expect(toggle().getAttribute('data-state')).toBe('unchecked')

    fireEvent.click(toggle())
    await settle()
    expect(hoisted.setCodeModeAllowedTools).toHaveBeenLastCalledWith('s1', [
      ...DEFAULTS,
      'read_neo4j_cypher',
      'write_neo4j_cypher',
      'read_graph',
    ])
  })

  it('shows the switch as on when the selection is exactly the preset', async () => {
    hoisted.getCodeModeAllowedTools.mockResolvedValue(
      state({ allowed: [...DEFAULTS, 'read_neo4j_cypher', 'write_neo4j_cypher', 'read_graph'] }),
    )
    const { container } = await renderPanel()

    const toggle = container.querySelector('[data-scope="switch"][data-part="control"]')!
    expect(toggle.getAttribute('data-state')).toBe('checked')

    fireEvent.click(toggle)
    await settle()
    // Turning it off drops back to the meta-tools alone.
    expect(hoisted.setCodeModeAllowedTools).toHaveBeenLastCalledWith('s1', DEFAULTS)
  })

  it('refuses to unpick a meta-tool', async () => {
    hoisted.getServerCatalog.mockResolvedValue([
      { key: 'meta', tools: [{ name: 'code-mode' }] } as CatalogServer,
    ])
    const { container } = await renderPanel()

    fireEvent.click(checkboxFor(container, 'code-mode').querySelector('[data-part="control"]')!)
    await settle()

    expect(hoisted.setCodeModeAllowedTools).not.toHaveBeenCalled()
  })

  it('surfaces a save failure without losing the panel', async () => {
    hoisted.setCodeModeAllowedTools.mockRejectedValue(new Error('conflict on write'))
    const { container } = await renderPanel()

    fireEvent.click(serverRow(container, 'memory').querySelector('[data-part="control"]')!)
    await settle()

    expect(container.textContent).toContain('Save failed: conflict on write')
    expect(container.textContent).toContain('All tools')
  })
})

describe('ToolsPanel — search', () => {
  const type = async (container: HTMLElement, value: string) => {
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')!
    fireEvent.input(input, { target: { value } })
    await settle()
  }

  it('narrows to the servers and tools that match, and expands them', async () => {
    const { container } = await renderPanel()

    await type(container, 'neo4j')
    expect(container.textContent).toContain('neo4j-cypher')
    expect(container.textContent).not.toContain('github')
    // Auto-expanded: the tool rows underneath are visible.
    expect(serverRow(container, 'neo4j-cypher').getAttribute('data-state')).toBe('open')
  })

  it('keeps every tool of a server whose own name matches', async () => {
    const { container } = await renderPanel()

    await type(container, 'github')
    const row = serverRow(container, 'github')
    expect(row.textContent).toContain('create_issue')
    expect(row.textContent).toContain('search_code')
  })

  it('filters within a server when only a tool name matches', async () => {
    const { container } = await renderPanel()

    await type(container, 'create_issue')
    const row = serverRow(container, 'github')
    expect(row.textContent).toContain('create_issue')
    expect(row.textContent).not.toContain('search_code')
  })

  it('says so when nothing enabled matches', async () => {
    const { container } = await renderPanel()

    await type(container, 'zzzz')
    expect(container.textContent).toContain('No enabled servers match')
  })

  it('previews master-catalog hits that are not enabled yet', async () => {
    hoisted.searchMasterCatalog.mockResolvedValue({
      matches: ['slack_post', 'slack_read', 'slack_list', 'slack_extra'],
      total: 12,
    })
    const { container } = await renderPanel()

    await type(container, 'slack')
    expect(container.textContent).toContain('+12 more in the catalog')
    expect(container.textContent).toContain('slack_post, slack_read, slack_list')
    expect(container.textContent).not.toContain('slack_extra')
  })

  it('does not query the master catalog for an empty box', async () => {
    await renderPanel()
    expect(hoisted.searchMasterCatalog).not.toHaveBeenCalled()
  })
})

describe('ToolsPanel — badges and coded tools', () => {
  it('badges secret-gated servers and core tools', async () => {
    const { container } = await renderPanel()

    expect(serverRow(container, 'github').textContent).toContain('secret')
    expect(serverRow(container, 'neo4j-cypher').textContent).toContain('Core')
    expect(serverRow(container, 'memory').textContent).not.toContain('Core')
  })

  it('shows an empty repository message when nothing has been saved', async () => {
    const { container } = await renderPanel()
    expect(container.textContent).toContain('No coded tools yet')
  })

  it('lists coded tools and reveals the script on click', async () => {
    const tool: CodedTool = {
      name: 'count_concepts',
      description: 'counts Concept nodes',
      script: 'return await neo4j("MATCH (c:Concept) RETURN count(c)")',
      usageCount: 7,
      createdAt: '2026-08-01T10:00:00Z',
      updatedAt: '2026-08-02T10:00:00Z',
    } as CodedTool
    hoisted.fetchCodedTools.mockResolvedValue([tool])
    const { container, getByText } = await renderPanel()

    expect(container.textContent).toContain('count_concepts')
    expect(container.textContent).toContain('7 uses')
    expect(container.textContent).not.toContain('MATCH (c:Concept)')

    fireEvent.click(getByText('count_concepts'))
    expect(container.textContent).toContain('MATCH (c:Concept)')
    expect(container.textContent).toContain('Updated:')
  })

  it('re-fetches the repository on Refresh', async () => {
    const { getByText } = await renderPanel()
    expect(hoisted.fetchCodedTools).toHaveBeenCalledTimes(1)

    fireEvent.click(getByText('Refresh'))
    await settle()
    expect(hoisted.fetchCodedTools).toHaveBeenCalledTimes(2)
  })

  it('renders an empty catalog without a server list', async () => {
    hoisted.getServerCatalog.mockRejectedValue(new Error('gateway down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = await renderPanel()

    expect(container.textContent).toContain('Servers')
    expect(container.textContent).toContain('0 of 0 selected')
  })
})
