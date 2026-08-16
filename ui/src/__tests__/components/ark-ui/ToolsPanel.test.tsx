/**
 * ToolsPanel — the per-conversation code-mode allowlist.
 *
 * Everything the panel writes goes through `setCodeModeAllowedTools`, so the
 * assertions are mostly "which list did the panel try to persist" — that is the
 * observable contract the code-mode actor reads back. The rest is the gating:
 * no session, a non-code-mode agent, and the tristate derivation that decides
 * what a server row's checkbox means.
 *
 * `~/lib/tool-config` is a "use server" barrel, so it is stubbed wholesale; the
 * constants it also exports are re-supplied as the real values.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { installDomStubs } from './dom-stubs'
import type { CatalogServer, CodeModeToolsState } from '../../../lib/tool-config/constants'
import type { CodedTool } from '../../../lib/tool-config/repository.server'

beforeAll(() => installDomStubs())

const getCodeModeAllowedTools =
  vi.fn<(sessionId: string, agentId?: string) => Promise<CodeModeToolsState | null>>()
const setCodeModeAllowedTools = vi.fn<(sessionId: string, tools: string[]) => Promise<void>>(
  async () => {},
)
const getServerCatalog = vi.fn<() => Promise<CatalogServer[]>>()
const searchMasterCatalog = vi.fn<(q: string) => Promise<{ matches: string[]; total: number }>>()
const fetchCodedTools = vi.fn<() => Promise<CodedTool[]>>()

vi.mock('~/lib/tool-config', () => ({
  getCodeModeAllowedTools: (sid: string, agentId?: string) => getCodeModeAllowedTools(sid, agentId),
  setCodeModeAllowedTools: (sid: string, tools: string[]) => setCodeModeAllowedTools(sid, tools),
  getServerCatalog: () => getServerCatalog(),
  searchMasterCatalog: (q: string) => searchMasterCatalog(q),
  fetchCodedTools: () => fetchCodedTools(),
  MINIMAL_TOOLS: ['read_neo4j_cypher'],
  CODE_MODE_PRESET_SERVERS: ['neo4j-cypher', 'web_search'],
}))

const { render } = await import('@solidjs/testing-library')
const { ToolsPanel } = await import('../../../components/ark-ui/ToolsPanel')

const tick = () => new Promise((r) => setTimeout(r, 30))

function server(key: string, tools: string[], extra: Partial<CatalogServer> = {}): CatalogServer {
  return {
    key,
    title: key,
    tools: tools.map((name) => ({ name })),
    enabled: true,
    secretGated: false,
    secrets: [],
    ...extra,
  }
}

const CATALOG: CatalogServer[] = [
  server('neo4j-cypher', ['read_neo4j_cypher', 'write_neo4j_cypher']),
  server('web_search', ['search', 'fetch_content']),
  server('github', ['create_issue'], { secretGated: true, secrets: ['GITHUB_TOKEN'] }),
]

const DEFAULTS = ['mcp-find', 'code-mode']

const state = (allowed: string[], usesCodeMode = true) => ({
  allowed,
  available: CATALOG.flatMap((s) => s.tools.map((t) => t.name)),
  defaults: DEFAULTS,
  usesCodeMode,
})

/** The list the panel last asked the server to persist. */
const persisted = () => setCodeModeAllowedTools.mock.calls.at(-1)![1]

const labelled = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll<HTMLElement>('[data-part="label"]')].find(
    (el) => el.textContent?.trim() === text,
  )

/** The clickable checkbox root that owns a given label. */
const checkboxFor = (container: HTMLElement, text: string) =>
  labelled(container, text)?.closest<HTMLElement>('[data-scope="checkbox"][data-part="root"]')

const trigger = (container: HTMLElement, key: string) =>
  [...container.querySelectorAll<HTMLElement>('[data-part="item-trigger"]')].find((el) =>
    el.textContent?.includes(key),
  )

beforeEach(() => {
  vi.clearAllMocks()
  getCodeModeAllowedTools.mockResolvedValue(state(DEFAULTS))
  getServerCatalog.mockResolvedValue(CATALOG)
  searchMasterCatalog.mockResolvedValue({ matches: [], total: 0 })
  fetchCodedTools.mockResolvedValue([])
})

describe('ToolsPanel', () => {
  it('asks for a conversation before offering any configuration', async () => {
    const { container } = render(() => <ToolsPanel />)
    await tick()

    expect(container.textContent).toContain('Start a conversation to configure tools')
    expect(getCodeModeAllowedTools).not.toHaveBeenCalled()
  })

  it('greys out for an agent that does not run a code-mode pattern', async () => {
    getCodeModeAllowedTools.mockResolvedValue(state(DEFAULTS, false))
    const { container } = render(() => <ToolsPanel sessionId="s1" agentId="graph" />)
    await tick()

    expect(container.textContent).toContain('Tool selection applies to code-mode agents')
    expect(container.textContent).not.toContain('Default code mode')
  })

  it('re-reads the allowlist when the agent changes on the same conversation', async () => {
    const { createSignal } = await import('solid-js')
    const [agentId, setAgentId] = createSignal('code-mode')
    render(() => <ToolsPanel sessionId="s1" agentId={agentId()} />)
    await tick()
    expect(getCodeModeAllowedTools).toHaveBeenCalledWith('s1', 'code-mode')

    setAgentId('graph')
    await tick()
    expect(getCodeModeAllowedTools).toHaveBeenCalledWith('s1', 'graph')
  })

  it('lists the always-on meta-tools and the selected counter', async () => {
    getCodeModeAllowedTools.mockResolvedValue(state([...DEFAULTS, 'search']))
    const { container } = render(() => <ToolsPanel sessionId="s1" />)
    await tick()

    expect(container.textContent).toContain('Always on:')
    expect(container.textContent).toContain('mcp-find')
    // Meta-tools don't count towards the data-tool tally: 1 of 5.
    expect(container.textContent).toContain('1 of 5 selected')
  })

  it('selects every data tool from the "All tools" checkbox, keeping meta-tools', async () => {
    const { container } = render(() => <ToolsPanel sessionId="s1" />)
    await tick()

    checkboxFor(container, 'All tools')!.click()
    await tick()

    expect(persisted()).toEqual([
      ...DEFAULTS,
      'read_neo4j_cypher',
      'write_neo4j_cypher',
      'search',
      'fetch_content',
      'create_issue',
    ])
  })

  it('clears the data tools when "All tools" is already full', async () => {
    const all = CATALOG.flatMap((s) => s.tools.map((t) => t.name))
    getCodeModeAllowedTools.mockResolvedValue(state([...DEFAULTS, ...all]))
    const { container } = render(() => <ToolsPanel sessionId="s1" />)
    await tick()

    checkboxFor(container, 'All tools')!.click()
    await tick()

    expect(persisted()).toEqual(DEFAULTS)
  })

  it('applies the preset servers from the "Default code mode" switch', async () => {
    const { container } = render(() => <ToolsPanel sessionId="s1" />)
    await tick()

    const sw = container.querySelector<HTMLElement>('[data-scope="switch"][data-part="root"]')!
    expect(sw.getAttribute('data-state')).toBe('unchecked')
    sw.click()
    await tick()

    expect(persisted()).toEqual([
      ...DEFAULTS,
      'read_neo4j_cypher',
      'write_neo4j_cypher',
      'search',
      'fetch_content',
    ])
  })

  it('reads as ON only when exactly the preset is selected, and clears on flip', async () => {
    const preset = ['read_neo4j_cypher', 'write_neo4j_cypher', 'search', 'fetch_content']
    getCodeModeAllowedTools.mockResolvedValue(state([...DEFAULTS, ...preset]))
    const { container } = render(() => <ToolsPanel sessionId="s1" />)
    await tick()

    const sw = container.querySelector<HTMLElement>('[data-scope="switch"][data-part="root"]')!
    expect(sw.getAttribute('data-state')).toBe('checked')

    sw.click()
    await tick()
    expect(persisted()).toEqual(DEFAULTS)
  })

  it('toggles a whole server from its row checkbox', async () => {
    const { container } = render(() => <ToolsPanel sessionId="s1" />)
    await tick()

    // The server rows carry an unlabelled checkbox next to the accordion trigger.
    const row = trigger(container, 'neo4j-cypher')!.parentElement!
    row.querySelector<HTMLElement>('[data-scope="checkbox"][data-part="root"]')!.click()
    await tick()

    expect(persisted()).toEqual([...DEFAULTS, 'read_neo4j_cypher', 'write_neo4j_cypher'])
  })

  it('toggles a single tool and refuses to drop a meta-tool', async () => {
    getCodeModeAllowedTools.mockResolvedValue(state([...DEFAULTS, 'search']))
    const { container } = render(() => <ToolsPanel sessionId="s1" />)
    await tick()

    trigger(container, 'web_search')!.click()
    await tick()

    checkboxFor(container, 'search')!.click()
    await tick()
    expect(persisted(), 'deselecting removes just that tool').toEqual(DEFAULTS)

    checkboxFor(container, 'fetch_content')!.click()
    await tick()
    expect(persisted()).toContain('fetch_content')
    expect(persisted(), 'meta-tools are always merged back in').toEqual(
      expect.arrayContaining(DEFAULTS),
    )
  })

  it('shows the partial state of a server with some tools selected', async () => {
    getCodeModeAllowedTools.mockResolvedValue(state([...DEFAULTS, 'read_neo4j_cypher']))
    const { container } = render(() => <ToolsPanel sessionId="s1" />)
    await tick()

    expect(trigger(container, 'neo4j-cypher')!.textContent).toContain('1/2')
    const row = trigger(container, 'neo4j-cypher')!.parentElement!
    expect(
      row.querySelector('[data-scope="checkbox"][data-part="root"]')!.getAttribute('data-state'),
    ).toBe('indeterminate')
  })

  it('filters the catalog by search and auto-expands the matches', async () => {
    const { container } = render(() => <ToolsPanel sessionId="s1" />)
    await tick()

    const box = container.querySelector<HTMLInputElement>('input[type="text"]')!
    box.value = 'create_issue'
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    expect(trigger(container, 'github')).toBeTruthy()
    expect(trigger(container, 'neo4j-cypher')).toBeUndefined()
    // Auto-expanded, so the matching tool is already visible.
    expect(labelled(container, 'create_issue')).toBeTruthy()
  })

  it('reports when nothing in the enabled catalog matches', async () => {
    const { container } = render(() => <ToolsPanel sessionId="s1" />)
    await tick()

    const box = container.querySelector<HTMLInputElement>('input[type="text"]')!
    box.value = 'nothing-here'
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    expect(container.textContent).toContain('No enabled servers match')
  })

  it('previews master-catalog hits the enabled catalog does not carry', async () => {
    searchMasterCatalog.mockResolvedValue({
      matches: ['slack', 'notion', 'jira', 'linear'],
      total: 9,
    })
    const { container } = render(() => <ToolsPanel sessionId="s1" />)
    await tick()

    const box = container.querySelector<HTMLInputElement>('input[type="text"]')!
    box.value = 'slack'
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    expect(container.textContent).toContain('+9 more in the catalog')
    expect(container.textContent).toContain('slack, notion, jira')
    expect(container.textContent).not.toContain('linear')
  })

  it('surfaces a failed save without losing the panel', async () => {
    setCodeModeAllowedTools.mockRejectedValue(new Error('postgres unreachable'))
    const { container } = render(() => <ToolsPanel sessionId="s1" />)
    await tick()

    checkboxFor(container, 'All tools')!.click()
    await tick()

    expect(container.textContent).toContain('Save failed: postgres unreachable')
    expect(container.textContent).toContain('Default code mode')
  })

  it('renders an empty panel body when the allowlist cannot be loaded', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    getCodeModeAllowedTools.mockRejectedValue(new Error('offline'))
    const { container } = render(() => <ToolsPanel sessionId="s1" />)
    await tick()

    // A load error must NOT be read as "not a code-mode agent".
    expect(container.textContent).toContain('Default code mode')
    expect(container.textContent).not.toContain('Always on:')
    consoleError.mockRestore()
  })

  it('falls back to an empty catalog when the gateway is unreachable', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    getServerCatalog.mockRejectedValue(new Error('gateway down'))
    const { container } = render(() => <ToolsPanel sessionId="s1" />)
    await tick()

    expect(container.textContent).toContain('0 of 0 selected')
    consoleError.mockRestore()
  })

  it('marks core tools and secret-gated servers', async () => {
    const { container } = render(() => <ToolsPanel sessionId="s1" />)
    await tick()

    expect(trigger(container, 'github')!.textContent).toContain('secret')

    trigger(container, 'neo4j-cypher')!.click()
    await tick()
    const coreRow = labelled(container, 'read_neo4j_cypher')!.closest('div')!.parentElement!
    expect(coreRow.textContent).toContain('Core')
  })

  it('shows the empty state for the coded-tool repository and refreshes it', async () => {
    const { container } = render(() => <ToolsPanel sessionId="s1" />)
    await tick()

    expect(container.textContent).toContain('No coded tools yet')
    expect(fetchCodedTools).toHaveBeenCalledTimes(1)

    const refresh = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Refresh',
    )!
    refresh.click()
    await tick()
    expect(fetchCodedTools).toHaveBeenCalledTimes(2)
  })

  it('expands a coded tool to reveal its script', async () => {
    fetchCodedTools.mockResolvedValue([
      {
        name: 'count_nodes',
        description: 'Counts nodes by label',
        script: 'return await neo4j.run("MATCH (n) RETURN count(n)")',
        createdAt: '2026-05-01T10:00:00Z',
        updatedAt: '2026-05-02T10:00:00Z',
        usageCount: 7,
      },
    ])
    const { container } = render(() => <ToolsPanel sessionId="s1" />)
    await tick()

    expect(container.textContent).toContain('count_nodes')
    expect(container.textContent).toContain('7 uses')
    expect(container.querySelector('pre')).toBeNull()

    const header = [...container.querySelectorAll<HTMLElement>('div[cursor="pointer"]')].find((d) =>
      d.textContent?.includes('Counts nodes by label'),
    )!
    header.click()
    await tick()

    expect(container.querySelector('pre')!.textContent).toContain('MATCH (n) RETURN count(n)')
    expect(container.textContent).toContain('Updated:')
  })
})
