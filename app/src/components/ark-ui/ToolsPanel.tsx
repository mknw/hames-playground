/**
 * Tools Panel Component
 *
 * Per-conversation tool allowlist for the code-mode agent. Reads/writes the
 * `data.codeModeAllowedTools` field on the conversation's serialized context
 * (Postgres JSONB) via `getCodeModeAllowedTools` / `setCodeModeAllowedTools`.
 * The code-mode agent's `toolNamesProvider` reads the same field live per
 * actor invocation, so checkbox edits take effect on the next turn without
 * a pattern rebuild.
 *
 * Layout: a fixed header with the "Default code mode" Switch, a pinned "All
 * tools" checkbox, and a search box; below it a scrolling Accordion grouped by
 * real gateway server name (neo4j-cypher, web_search, …) with per-tool
 * checkboxes. Selection persists as a tool-name list (backward compatible);
 * server rows are tristate (all/some/none) derived from it.
 */

import { Switch } from '@ark-ui/solid/switch'
import { Checkbox } from '@ark-ui/solid/checkbox'
import { Accordion } from '@ark-ui/solid/accordion'
import {
  createSignal,
  createResource,
  createMemo,
  createEffect,
  Suspense,
  For,
  Show,
} from 'solid-js'
import {
  getCodeModeAllowedTools,
  setCodeModeAllowedTools,
  getServerCatalog,
  searchMasterCatalog,
  fetchCodedTools,
  MINIMAL_TOOLS,
  CODE_MODE_PRESET_SERVERS,
  type CodedTool,
  type CatalogServer,
} from '~/lib/tool-config'

// ============================================================================
// Component
// ============================================================================

interface ToolsPanelProps {
  /** Active conversation id. Required for the per-conversation allowlist;
   *  when undefined the panel renders an empty state. */
  sessionId?: string
  /** The conversation's currently-selected agent. Drives the code-mode gate
   *  (grey-out for agents that don't run a code-mode pattern) off the live
   *  selection, so a fresh chat re-evaluates the moment the agent changes
   *  rather than waiting for the session to persist. */
  agentId?: string
}

export const ToolsPanel = (props: ToolsPanelProps) => {
  const [isSaving, setIsSaving] = createSignal(false)
  const [saveError, setSaveError] = createSignal<string | null>(null)

  // Single round-trip: returns allowed + available + meta-tool defaults + the
  // code-mode gate. Re-fetches when EITHER the session (different chat) or the
  // selected agent changes — the latter is what makes the grey-out track agent
  // switches on a not-yet-persisted conversation.
  const [state, { mutate }] = createResource(
    () => [props.sessionId, props.agentId] as const,
    async ([sid, agentId]) => {
      if (!sid) return null
      try {
        return await getCodeModeAllowedTools(sid, agentId)
      } catch (err) {
        console.error('[ToolsPanel] load failed:', err)
        return null
      }
    },
  )

  const [codedTools, { refetch: refetchCodedTools }] = createResource(fetchCodedTools)

  // Real-server-name catalog: servers grouped by their gateway name + tools.
  const [catalog] = createResource(async () => {
    try {
      return await getServerCatalog()
    } catch (err) {
      console.error('[ToolsPanel] catalog load failed:', err)
      return [] as CatalogServer[]
    }
  })

  // Tool search + read-only master-catalog preview (enabling is follow-up #87).
  const [search, setSearch] = createSignal('')
  const [masterPreview] = createResource(
    () => search().trim(),
    async (q) => (q ? searchMasterCatalog(q) : { matches: [], total: 0 }),
    // initialValue keeps the resource in "ready" state; reads use `.latest`
    // below so a search keystroke never suspends (which would flash the app).
    { initialValue: { matches: [], total: 0 } },
  )

  // Accordion open state — auto-expands matching servers while searching.
  const [openItems, setOpenItems] = createSignal<string[]>([])

  // --- selection helpers (selection persists as a tool-name list) ---
  const isSelected = (tool: string) => state()?.allowed.includes(tool) ?? false

  const allDataTools = createMemo(() =>
    (catalog() ?? []).flatMap((s) => s.tools.map((t) => t.name)),
  )
  const presetTools = createMemo(() => {
    const preset = new Set(CODE_MODE_PRESET_SERVERS)
    return (catalog() ?? [])
      .filter((s) => preset.has(s.key))
      .flatMap((s) => s.tools.map((t) => t.name))
  })

  /** Persist a new allowlist (meta-tools always retained) + refetch. */
  const persist = async (next: string[]) => {
    const sid = props.sessionId
    if (!sid) return
    const defaults = state()?.defaults ?? []
    const merged = Array.from(new Set([...defaults, ...next]))
    setIsSaving(true)
    setSaveError(null)
    try {
      await setCodeModeAllowedTools(sid, merged)
      // Optimistic local update instead of refetch: the resource never enters
      // a loading state, so the panel can't re-suspend (which would flash the
      // app white via the empty-fallback root <Suspense> in app.tsx). The
      // server stores exactly `merged`, so the local value already matches.
      mutate((s) => (s ? { ...s, allowed: merged } : s))
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSaving(false)
    }
  }

  /** Toggle a single tool. Meta-tools (defaults) are locked-on. */
  const handleToolToggle = async (tool: string) => {
    const s = state()
    if (!s || s.defaults.includes(tool)) return
    const next = s.allowed.includes(tool)
      ? s.allowed.filter((t) => t !== tool)
      : [...s.allowed, tool]
    await persist(next)
  }

  /** Tristate for a set of tool names: 'all' | 'some' | 'none'. */
  const triState = (names: string[]): 'all' | 'some' | 'none' => {
    if (names.length === 0) return 'none'
    const sel = names.filter((n) => isSelected(n)).length
    return sel === 0 ? 'none' : sel === names.length ? 'all' : 'some'
  }

  /** Select/deselect every tool of a server. */
  const toggleServer = async (server: CatalogServer) => {
    const names = server.tools.map((t) => t.name)
    const allowed = state()?.allowed ?? []
    const next =
      triState(names) === 'all' ? allowed.filter((t) => !names.includes(t)) : [...allowed, ...names]
    await persist(next)
  }

  /** "All tools" pinned checkbox. */
  const allToolsState = createMemo(() => triState(allDataTools()))
  const toggleAllTools = async () => {
    const next = allToolsState() === 'all' ? [] : allDataTools()
    await persist(next)
  }

  const selectedDataCount = createMemo(() => {
    const data = new Set(allDataTools())
    return (state()?.allowed ?? []).filter((t) => data.has(t)).length
  })

  /** "Default code mode" switch: ON iff exactly the preset data-tools are
   *  selected (no more, no fewer). Flipping applies/clears the preset. */
  const presetActive = createMemo(() => {
    const sel = new Set((state()?.allowed ?? []).filter((t) => allDataTools().includes(t)))
    const preset = presetTools()
    return preset.length > 0 && sel.size === preset.length && preset.every((t) => sel.has(t))
  })
  const togglePreset = async (on: boolean) => {
    await persist(on ? presetTools() : [])
  }

  // Filter the catalog by the search query (server name or tool name).
  const filteredCatalog = createMemo<CatalogServer[]>(() => {
    const q = search().trim().toLowerCase()
    const cat = catalog() ?? []
    if (!q) return cat
    return cat
      .map((s) => ({
        ...s,
        tools: s.key.toLowerCase().includes(q)
          ? s.tools
          : s.tools.filter((t) => t.name.toLowerCase().includes(q)),
      }))
      .filter((s) => s.key.toLowerCase().includes(q) || s.tools.length > 0)
  })

  // Auto-expand matching servers while a search is active.
  createEffect(() => {
    const q = search().trim()
    if (q) setOpenItems(filteredCatalog().map((s) => s.key))
  })

  return (
    <div flex="~ col" h="full" bg="dark-bg-primary" overflow="auto">
      {/* Header */}
      <div p="4" border="b dark-border-primary">
        <h2 text="lg dark-text-primary" font="semibold">
          Tool Configuration
        </h2>
        <p text="sm dark-text-tertiary" m="t-1">
          Pick which MCP tools the code-mode agent can call in this conversation
        </p>
      </div>

      {/* No session — empty state */}
      <Show when={!props.sessionId}>
        <div p="6" text="center" flex="~ col 1" justify="center" items="center">
          <div text="sm dark-text-secondary">Start a conversation to configure tools.</div>
          <div text="xs dark-text-tertiary" m="t-1">
            The allowlist is saved per chat thread.
          </div>
        </div>
      </Show>

      <Show when={props.sessionId}>
        {/* Saving indicator + error toast — signal-driven, outside Suspense
            so they stay visible even while the body is loading. */}
        <Show when={isSaving()}>
          <div p="2" bg="dark-bg-secondary" text="xs dark-text-secondary" text-align="center">
            Saving...
          </div>
        </Show>
        <Show when={saveError()}>
          <div p="2" bg="red-900/30" border="b red-700" text="xs" style={{ color: '#fca5a5' }}>
            Save failed: {saveError()}
          </div>
        </Show>

        {/* Local Suspense: contains the resource-dependent body so its initial
            load shows a panel skeleton instead of blanking the whole app via
            the empty-fallback root <Suspense> in app.tsx. */}
        <Suspense
          fallback={
            <div p="4" text="sm dark-text-tertiary">
              Loading tools…
            </div>
          }
        >
          {/* Gate the whole code-mode-specific body on whether the conversation's
            agent actually composes a code-mode pattern (the sole consumer of
            this allowlist). Reading state() here stays inside the local
            <Suspense> so a pending load can't bubble to the app-root boundary
            and flash the app. `usesCodeMode !== false` keeps the body for the
            true case AND the error case (state() === null → undefined). */}
          <Show
            when={state()?.usesCodeMode !== false}
            fallback={
              <div p="6" text="center" flex="~ col 1" justify="center" items="center">
                <div text="sm dark-text-secondary">Tool selection applies to code-mode agents.</div>
                <div text="xs dark-text-tertiary" m="t-1">
                  This conversation's agent doesn't run a code-mode pattern, so the allowlist has no
                  effect here.
                </div>
              </div>
            }
          >
            {/* Controls header — always in sight */}
            <div p="4" border="b dark-border-primary" flex="~ col" gap="3">
              {/* "Default code mode" preset switch */}
              <div flex="~" items="center" justify="between" gap="3">
                <div flex="1">
                  <div text="sm dark-text-primary" font="medium">
                    Default code mode
                  </div>
                  <div text="xs dark-text-tertiary" m="t-0.5">
                    Scope to the preset servers: {CODE_MODE_PRESET_SERVERS.join(', ')}
                  </div>
                </div>
                <Switch.Root
                  checked={presetActive()}
                  onCheckedChange={(d) => togglePreset(d.checked)}
                >
                  <Switch.Control
                    w="14"
                    h="7"
                    rounded="full"
                    p="1"
                    flex="~"
                    items="center"
                    border="1 dark-border-primary"
                    bg={presetActive() ? 'neon-cyan/30' : 'dark-bg-tertiary'}
                    style={{ transition: 'background 0.15s', cursor: 'pointer' }}
                  >
                    <Switch.Thumb
                      w="5"
                      h="5"
                      rounded="full"
                      bg={presetActive() ? 'neon-cyan' : 'dark-text-tertiary'}
                      style={{
                        transform: presetActive() ? 'translateX(28px)' : 'translateX(0)',
                        transition: 'transform 0.15s',
                      }}
                    />
                  </Switch.Control>
                  <Switch.HiddenInput />
                </Switch.Root>
              </div>

              {/* Pinned "All tools" + selected counter */}
              <div flex="~" items="center" justify="between">
                <CheckBox state={allToolsState()} onToggle={toggleAllTools} label="All tools" />
                <span text="xs dark-text-tertiary">
                  {selectedDataCount()} of {allDataTools().length} selected
                </span>
              </div>

              {/* Search */}
              <input
                type="text"
                value={search()}
                onInput={(e) => setSearch(e.currentTarget.value)}
                placeholder="Search servers and tools…"
                w="full"
                p="x-3 y-2"
                text="sm dark-text-primary"
                bg="dark-bg-tertiary"
                border="1 dark-border-secondary focus:neon-cyan"
                rounded="md"
                outline="none"
                style={{ 'box-sizing': 'border-box' }}
              />
              <Show when={(masterPreview.latest?.total ?? 0) > 0}>
                <div text="xs dark-text-tertiary">
                  +{masterPreview.latest!.total} more in the catalog
                  <Show when={masterPreview.latest!.matches.length > 0}>
                    {' '}
                    (e.g. {masterPreview.latest!.matches.slice(0, 3).join(', ')})
                  </Show>{' '}
                  — enabling coming soon (#87)
                </div>
              </Show>
            </div>

            {/* Always-on meta-tools */}
            <Show when={(state()?.defaults.length ?? 0) > 0}>
              <div
                p="x-4 y-2"
                border="b dark-border-primary"
                flex="~"
                items="center"
                gap="2"
                flex-wrap="wrap"
              >
                <span text="xs dark-text-tertiary">Always on:</span>
                <For each={state()!.defaults}>
                  {(tool) => (
                    <span
                      text="xs"
                      p="x-1.5 y-0.5"
                      bg="neon-magenta/10"
                      border="1 neon-magenta/30"
                      rounded="full"
                      style={{ color: '#ff66ff' }}
                    >
                      {tool}
                    </span>
                  )}
                </For>
              </div>
            </Show>

            {/* Servers — Accordion grouped by real gateway server name */}
            <div
              p="4"
              border="b dark-border-primary"
              flex="~ col"
              overflow="hidden"
              style={{ 'max-height': '45vh' }}
            >
              <h3 text="sm dark-text-primary" font="medium" m="b-2" flex-shrink="0">
                Servers
              </h3>
              <Show when={catalog.loading}>
                <div text="xs dark-text-tertiary">Loading servers…</div>
              </Show>
              <Show when={!catalog.loading}>
                <div overflow="auto" p="r-1">
                  <Accordion.Root
                    multiple
                    value={openItems()}
                    onValueChange={(d) => setOpenItems(d.value)}
                  >
                    <For each={filteredCatalog()}>
                      {(server) => {
                        const names = () => server.tools.map((t) => t.name)
                        const selCount = () => names().filter((n) => isSelected(n)).length
                        return (
                          <Accordion.Item value={server.key} border="b dark-border-primary/40">
                            <div flex="~" items="center" gap="2" p="y-2">
                              <CheckBox
                                state={triState(names())}
                                onToggle={() => toggleServer(server)}
                              />
                              <Accordion.ItemTrigger
                                flex="1 ~"
                                items="center"
                                justify="between"
                                bg="transparent"
                                text="left"
                                p="0"
                                style={{ border: 'none', cursor: 'pointer' }}
                              >
                                <span flex="~" items="center" gap="2">
                                  <span text="sm dark-text-primary" font="medium">
                                    {server.key}
                                  </span>
                                  <Show when={server.secretGated}>
                                    <span
                                      text="xs"
                                      p="x-1.5 y-0.5"
                                      bg="neon-orange/10"
                                      border="1 neon-orange/30"
                                      rounded="full"
                                      style={{ color: '#ff6600' }}
                                    >
                                      secret
                                    </span>
                                  </Show>
                                </span>
                                <span flex="~" items="center" gap="2">
                                  <span text="xs dark-text-tertiary">
                                    {selCount()}/{names().length}
                                  </span>
                                  <Accordion.ItemIndicator>
                                    <svg
                                      width="14"
                                      height="14"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      stroke-width="2"
                                      style={{ color: '#a1a1aa' }}
                                    >
                                      <path d="M6 9l6 6 6-6" />
                                    </svg>
                                  </Accordion.ItemIndicator>
                                </span>
                              </Accordion.ItemTrigger>
                            </div>
                            <Accordion.ItemContent>
                              <div flex="~ col" gap="1" p="l-6 b-2">
                                <For each={server.tools}>
                                  {(t) => (
                                    <div
                                      flex="~"
                                      items="center"
                                      justify="between"
                                      gap="2"
                                      p="x-2 y-1"
                                      rounded="md"
                                      hover:bg="dark-bg-tertiary"
                                    >
                                      <CheckBox
                                        state={isSelected(t.name) ? 'all' : 'none'}
                                        onToggle={() => handleToolToggle(t.name)}
                                        label={t.name}
                                      />
                                      <Show when={MINIMAL_TOOLS.includes(t.name)}>
                                        <span
                                          text="xs"
                                          p="x-1.5 y-0.5"
                                          bg="neon-cyan/10"
                                          border="1 neon-cyan/30"
                                          rounded="full"
                                          style={{ color: '#00ffff' }}
                                        >
                                          Core
                                        </span>
                                      </Show>
                                    </div>
                                  )}
                                </For>
                              </div>
                            </Accordion.ItemContent>
                          </Accordion.Item>
                        )
                      }}
                    </For>
                  </Accordion.Root>
                  <Show when={filteredCatalog().length === 0}>
                    <div text="xs dark-text-tertiary" p="2">
                      No enabled servers match “{search()}”.
                    </div>
                  </Show>
                </div>
              </Show>
            </div>

            {/* Coded Tools Repository Section */}
            <div p="4">
              <div flex="~" items="center" justify="between" m="b-3">
                <h3 text="sm dark-text-primary" font="medium">
                  Coded Tools Repository
                </h3>
                <button
                  onClick={() => refetchCodedTools()}
                  p="x-2 y-1"
                  text="xs dark-text-secondary hover:dark-text-primary"
                  bg="dark-bg-secondary hover:dark-bg-tertiary"
                  border="1 dark-border-primary"
                  rounded="md"
                  cursor="pointer"
                  transition="all"
                >
                  Refresh
                </button>
              </div>

              <Show when={codedTools.loading}>
                <div text="xs dark-text-tertiary">Loading coded tools...</div>
              </Show>

              <Show when={!codedTools.loading && codedTools()?.length === 0}>
                <div p="4" bg="dark-bg-secondary" rounded="md" text="center">
                  <div text="sm dark-text-secondary">No coded tools yet</div>
                  <div text="xs dark-text-tertiary" m="t-1">
                    Tools will appear here as they are created and saved during code mode execution
                  </div>
                </div>
              </Show>

              <Show when={!codedTools.loading && (codedTools()?.length || 0) > 0}>
                <div flex="~ col" gap="2">
                  <For each={codedTools()}>{(tool) => <CodedToolCard tool={tool} />}</For>
                </div>
              </Show>
            </div>
          </Show>
        </Suspense>
      </Show>
    </div>
  )
}

// ============================================================================
// Tristate checkbox — shared by All-tools, server rows, and tool rows
// ============================================================================

interface CheckBoxProps {
  state: 'all' | 'some' | 'none'
  onToggle: () => void
  disabled?: boolean
  label?: string
}

const CheckBox = (props: CheckBoxProps) => {
  const checked = () =>
    props.state === 'all' ? true : props.state === 'some' ? ('indeterminate' as const) : false
  return (
    <Checkbox.Root
      checked={checked()}
      disabled={props.disabled}
      onCheckedChange={() => props.onToggle()}
      flex="~"
      items="center"
      gap="2"
      style={{ cursor: props.disabled ? 'not-allowed' : 'pointer' }}
    >
      <Checkbox.Control
        w="4"
        h="4"
        border="1 dark-border-primary"
        rounded="sm"
        bg={props.state === 'none' ? 'transparent' : 'neon-cyan'}
        flex="~"
        items="center"
        justify="center"
      >
        <Show when={props.state === 'all'}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M2 6L5 9L10 3"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              style={{ color: '#0d1117' }}
            />
          </svg>
        </Show>
        <Show when={props.state === 'some'}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M2.5 6H9.5"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              style={{ color: '#0d1117' }}
            />
          </svg>
        </Show>
      </Checkbox.Control>
      <Show when={props.label}>
        <Checkbox.Label text="sm dark-text-primary">{props.label}</Checkbox.Label>
      </Show>
      <Checkbox.HiddenInput />
    </Checkbox.Root>
  )
}

// ============================================================================
// Coded Tool Card Component
// ============================================================================

interface CodedToolCardProps {
  tool: CodedTool
}

const CodedToolCard = (props: CodedToolCardProps) => {
  const [isExpanded, setIsExpanded] = createSignal(false)

  return (
    <div bg="dark-bg-secondary" border="1 dark-border-primary" rounded="md" overflow="hidden">
      <div
        flex="~"
        items="center"
        justify="between"
        p="3"
        cursor="pointer"
        hover:bg="dark-bg-tertiary"
        onClick={() => setIsExpanded(!isExpanded())}
      >
        <div flex="1">
          <div flex="~" items="center" gap="2">
            <span text="sm dark-text-primary" font="medium">
              {props.tool.name}
            </span>
            <span
              text="xs"
              p="x-1.5 y-0.5"
              bg="neon-orange/10"
              border="1 neon-orange/30"
              rounded="full"
              style={{ color: '#ff6600' }}
            >
              {props.tool.usageCount} uses
            </span>
          </div>
          <div text="xs dark-text-tertiary" m="t-0.5">
            {props.tool.description}
          </div>
        </div>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          style={{
            color: '#a1a1aa',
            transform: isExpanded() ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s',
          }}
        >
          <path d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      <Show when={isExpanded()}>
        <div border="t dark-border-primary" p="3" bg="dark-bg-primary">
          <div text="xs dark-text-tertiary" m="b-2">
            Script:
          </div>
          <pre
            text="xs dark-text-secondary"
            bg="dark-bg-tertiary"
            p="3"
            rounded="md"
            overflow="auto"
            max-h="200px"
            style={{ 'white-space': 'pre-wrap', 'word-break': 'break-all' }}
          >
            {props.tool.script}
          </pre>
          <div text="xs dark-text-tertiary" m="t-2">
            Created: {new Date(props.tool.createdAt).toLocaleString()}
            {props.tool.updatedAt &&
              ` | Updated: ${new Date(props.tool.updatedAt).toLocaleString()}`}
          </div>
        </div>
      </Show>
    </div>
  )
}
