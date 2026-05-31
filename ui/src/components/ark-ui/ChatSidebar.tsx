import { For, Show, createSignal, createResource, createMemo } from 'solid-js'
import { SettingsPanel } from './SettingsPanel'
import { regenerateConversationTitle, getAgentList } from '../../lib/harness-client'

export interface ChatThreadSummary {
  id: string
  title: string | null
  /** Agent that owns this conversation. Drives the agent icon + name shown
   *  below the title (#60/#61). Undefined for the optimistic placeholder
   *  (no agent committed until the first turn persists). */
  agentId?: string
  /** ISO 8601 timestamp from the server. */
  updatedAt: string
  /** Optimistic client-side row for a brand-new chat that hasn't been
   *  persisted yet. Replaced in place once the real row appears in the
   *  threadsResource refetch. */
  isPlaceholder?: boolean
}

/** Minimal shape of an agent's display metadata (subset of getAgentList()). */
interface AgentBadge {
  icon: string
  name: string
}

const PLACEHOLDER_TITLE = 'new chat'

/**
 * Merge the optimistic "+ New Chat" placeholder with the persisted thread
 * list. When the persisted list already contains a row with the placeholder's
 * id (the conversation has been saved), the placeholder is dropped — the real
 * row takes over with its sticky title and timestamp. See #44.
 *
 * Pure: no Solid signals, no DOM — straightforward to unit test.
 */
export function mergeThreadsWithPlaceholder(
  threads: ChatThreadSummary[],
  placeholderId: string | null,
  /** Defaults to `Date.now()` — overrideable for deterministic tests. */
  nowIso: () => string = () => new Date().toISOString(),
): ChatThreadSummary[] {
  if (!placeholderId) return threads
  if (threads.some(t => t.id === placeholderId)) return threads
  const placeholder: ChatThreadSummary = {
    id: placeholderId,
    title: null,
    updatedAt: nowIso(),
    isPlaceholder: true,
  }
  return [placeholder, ...threads]
}

const formatTimestamp = (iso: string): string => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / (1000 * 60))
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

interface ChatSidebarProps {
  collapsed: boolean
  onToggle: () => void
  threads: ChatThreadSummary[]
  selectedId: string | null
  onSelectThread: (threadId: string) => void
  onNewChat: () => void
  /** Called when the user clicks the per-row ↻ button to regenerate the
   *  LLM title. The sidebar handles the server action itself, then forwards
   *  the new title so the parent can patch its threads cache in-place. */
  onTitleRegenerated?: (sessionId: string, title: string) => void
  /** Delete one or more conversations (#71). The sidebar drives both the
   *  single per-row trash button and the bulk select-mode delete; the parent
   *  performs the server action and patches its threads cache + handles the
   *  case where the active thread was deleted. */
  onDeleteThreads?: (ids: string[]) => void | Promise<void>
}

export const ChatSidebar = (props: ChatSidebarProps) => {
  // Per-thread pending state for the ↻ button — keyed by sessionId.
  const [pendingRegen, setPendingRegen] = createSignal<ReadonlySet<string>>(new Set())

  // Agent display metadata (icon + name), keyed by agent id. Fetched once;
  // used to render the agent badge below each conversation title (#60/#61).
  const [agentList] = createResource(async () => {
    try {
      return await getAgentList()
    } catch (err) {
      console.error('[sidebar] failed to load agent metadata:', err)
      return []
    }
  })
  const agentBadges = createMemo(() => {
    const map = new Map<string, AgentBadge>()
    for (const a of agentList() ?? []) map.set(a.id, { icon: a.icon, name: a.name })
    return map
  })
  const badgeFor = (agentId: string | undefined): AgentBadge | undefined =>
    agentId ? agentBadges().get(agentId) : undefined

  // ---- Bulk select / delete state (#71) ----
  const [selectMode, setSelectMode] = createSignal(false)
  const [selectedForDelete, setSelectedForDelete] = createSignal<ReadonlySet<string>>(new Set())
  const [deleting, setDeleting] = createSignal(false)

  // Persisted (non-placeholder) rows are the only deletable ones.
  const deletableThreads = createMemo(() => props.threads.filter(t => !t.isPlaceholder))
  const selectedCount = () => selectedForDelete().size
  const allSelected = () =>
    deletableThreads().length > 0 && selectedCount() === deletableThreads().length

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelectedForDelete(new Set<string>())
  }

  const toggleSelected = (threadId: string) => {
    setSelectedForDelete(prev => {
      const next = new Set(prev)
      if (next.has(threadId)) next.delete(threadId)
      else next.add(threadId)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (allSelected()) setSelectedForDelete(new Set<string>())
    else setSelectedForDelete(new Set<string>(deletableThreads().map(t => t.id)))
  }

  const runDelete = async (ids: string[]) => {
    if (ids.length === 0 || deleting()) return
    const plural = ids.length > 1 ? `${ids.length} conversations` : 'this conversation'
    if (!confirm(`Delete ${plural}? This cannot be undone.`)) return
    setDeleting(true)
    try {
      await props.onDeleteThreads?.(ids)
      exitSelectMode()
    } catch (err) {
      console.error('[sidebar] delete failed:', err)
    } finally {
      setDeleting(false)
    }
  }

  const handleDeleteSingle = async (e: MouseEvent, threadId: string) => {
    // Stop the click from also selecting/navigating to the thread.
    e.stopPropagation()
    e.preventDefault()
    await runDelete([threadId])
  }

  const handleRowClick = (threadId: string) => {
    if (selectMode()) {
      toggleSelected(threadId)
      return
    }
    props.onSelectThread(threadId)
  }

  const handleRegenerate = async (e: MouseEvent, threadId: string) => {
    // Stop the click from also selecting the thread.
    e.stopPropagation()
    e.preventDefault()
    if (pendingRegen().has(threadId)) return
    setPendingRegen(prev => new Set(prev).add(threadId))
    try {
      const title = await regenerateConversationTitle(threadId)
      if (title) props.onTitleRegenerated?.(threadId, title)
    } catch (err) {
      console.error('[sidebar] regenerate title failed:', err)
    } finally {
      setPendingRegen(prev => {
        const next = new Set(prev)
        next.delete(threadId)
        return next
      })
    }
  }

  return (
    <div
      flex="~ col"
      h="full"
      bg="dark-bg-primary"
      border="r dark-border-primary"
      transition="width"
      style={{width: props.collapsed ? '3rem' : '16rem'}}
    >
      {/* Header with Toggle */}
      <div p="4" border="b dark-border-primary" flex="~" items="center" justify="between" gap="2">
        {!props.collapsed && (
          <span text="sm dark-text-primary" font="medium">Chat History</span>
        )}
        <div flex="~ items-center gap-1 shrink-0">
          {/* Select / Cancel toggle for bulk delete (#71). Only shown when
              expanded and at least one deletable conversation exists. */}
          <Show when={!props.collapsed && deletableThreads().length > 0}>
            <button
              onClick={() => (selectMode() ? exitSelectMode() : setSelectMode(true))}
              px="2"
              py="1"
              rounded="md"
              hover="bg-dark-bg-hover"
              transition="colors"
              text={selectMode() ? 'xs neon-cyan' : 'xs dark-text-secondary'}
              title={selectMode() ? 'Cancel selection' : 'Select conversations to delete'}
            >
              {selectMode() ? 'Cancel' : 'Select'}
            </button>
          </Show>
          <button
            onClick={() => props.onToggle()}
            p="2"
            rounded="md"
            hover="bg-dark-bg-hover"
            transition="colors"
            text="neon-cyan"
            flex="shrink-0"
            title={props.collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <svg
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d={props.collapsed ? "M9 5l7 7-7 7" : "M15 19l-7-7 7-7"}
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Thread List */}
      {!props.collapsed && (
        <>
          <div flex="1" overflow="auto">
            <Show
              when={props.threads.length > 0}
              fallback={
                <div p="4" text="xs dark-text-tertiary">
                  No conversations yet. Send a message to start.
                </div>
              }
            >
              <div p="2" space="y-1">
                <For each={props.threads}>
                  {(thread) => {
                    const isSelected = () => thread.id === props.selectedId
                    const isRegenerating = () => pendingRegen().has(thread.id)
                    const isChecked = () => selectedForDelete().has(thread.id)
                    // In select mode, placeholder rows aren't selectable.
                    const selectable = () => selectMode() && !thread.isPlaceholder
                    return (
                      <button
                        onClick={() => handleRowClick(thread.id)}
                        w="full"
                        text="left"
                        p="3"
                        rounded="md"
                        bg={
                          selectable() && isChecked()
                            ? 'neon-cyan/10'
                            : isSelected() && !selectMode()
                              ? 'cyber-700/30'
                              : ''
                        }
                        hover="bg-dark-bg-hover"
                        transition="all"
                        border={
                          selectable() && isChecked()
                            ? '1 neon-cyan/40'
                            : isSelected() && !selectMode()
                              ? '1 neon-cyan/40'
                              : '1 transparent hover:neon-cyan/30'
                        }
                        cursor="pointer"
                        data-placeholder={thread.isPlaceholder ? '' : undefined}
                        relative=""
                        class="group"
                        flex="~ items-start gap-2"
                      >
                        {/* Checkbox indicator — only in select mode. */}
                        <Show when={selectable()}>
                          <span
                            flex="~ shrink-0 items-center justify-center"
                            w="4"
                            h="4"
                            m="t-0.5"
                            rounded="sm"
                            border="~ dark-border-secondary"
                            bg={isChecked() ? 'neon-cyan' : 'transparent'}
                          >
                            <Show when={isChecked()}>
                              <svg width="12" height="12" fill="none" stroke="#0a0a0f" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                              </svg>
                            </Show>
                          </span>
                        </Show>
                        <div flex="1" overflow="hidden">
                        <div
                          text={thread.isPlaceholder ? 'sm dark-text-tertiary' : 'sm dark-text-primary'}
                          font={thread.isPlaceholder ? 'normal italic' : 'medium'}
                          truncate
                          pr="6"
                        >
                          {thread.isPlaceholder
                            ? PLACEHOLDER_TITLE
                            : thread.title ?? '(untitled)'}
                        </div>
                        {/* Agent badge below the title — icon + agent name
                            (#60/#61). Hidden for placeholders (no agent yet)
                            and when the agent id isn't in the metadata list. */}
                        <Show when={!thread.isPlaceholder && badgeFor(thread.agentId)}>
                          {(badge) => (
                            <div flex="~ items-center gap-1" m="t-1" text="xs dark-text-tertiary">
                              <span text="sm" leading="none">{badge().icon}</span>
                              <span truncate>{badge().name}</span>
                            </div>
                          )}
                        </Show>
                        <div text="xs dark-text-tertiary" m="t-1">
                          {formatTimestamp(thread.updatedAt)}
                        </div>
                        </div>
                        {/* Hover-reveal row actions — regenerate ↻ + delete 🗑.
                            Hidden for placeholder rows (nothing persisted yet)
                            and while in select mode (the checkbox + bulk bar own
                            deletion then). Each sits in a span outside the outer
                            <button>'s primary action via stopPropagation so
                            nested-interactive semantics stay valid. */}
                        <Show when={!thread.isPlaceholder && !selectMode()}>
                          {/* Regenerate title */}
                          <span
                            aria-hidden="true"
                            onClick={(e) => handleRegenerate(e, thread.id)}
                            title="Regenerate title"
                            style={{
                              position: 'absolute',
                              top: '0.5rem',
                              right: '2rem',
                              padding: '0.25rem',
                              'border-radius': '0.375rem',
                              cursor: 'pointer',
                              opacity: isRegenerating() ? 1 : undefined,
                              'pointer-events': isRegenerating() ? 'none' : 'auto',
                            }}
                            text="xs dark-text-tertiary hover:neon-cyan"
                            transition="opacity"
                            class={isRegenerating() ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}
                          >
                            <svg
                              width="14"
                              height="14"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                              class={isRegenerating() ? 'animate-spin' : ''}
                            >
                              <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                              />
                            </svg>
                          </span>
                          {/* Delete (single) */}
                          <span
                            aria-hidden="true"
                            onClick={(e) => handleDeleteSingle(e, thread.id)}
                            title="Delete conversation"
                            style={{
                              position: 'absolute',
                              top: '0.5rem',
                              right: '0.5rem',
                              padding: '0.25rem',
                              'border-radius': '0.375rem',
                              cursor: 'pointer',
                              'pointer-events': deleting() ? 'none' : 'auto',
                            }}
                            text="xs dark-text-tertiary hover:red-400"
                            transition="opacity"
                            class="opacity-0 group-hover:opacity-100"
                          >
                            <svg
                              width="14"
                              height="14"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                              />
                            </svg>
                          </span>
                        </Show>
                      </button>
                    )
                  }}
                </For>
              </div>
            </Show>
          </div>

          {/* Footer — in select mode it becomes the bulk-delete bar (#71),
              otherwise the usual Settings + New Chat row. */}
          <Show
            when={selectMode()}
            fallback={
              <div p="4" border="t dark-border-primary" flex="~" gap="2" items="center">
                <SettingsPanel />
                <button
                  onClick={() => props.onNewChat()}
                  flex="1"
                  p="2"
                  bg="cyber-700 hover:cyber-600"
                  text="white sm"
                  font="medium"
                  rounded="md"
                  transition="all"
                  shadow="hover:[0_0_15px_rgba(79,70,229,0.5)]"
                >
                  + New Chat
                </button>
              </div>
            }
          >
            <div p="3" border="t dark-border-primary" flex="~ col" gap="2">
              <div flex="~ items-center justify-between" text="xs dark-text-secondary">
                <span>{selectedCount()} selected</span>
                <button
                  onClick={toggleSelectAll}
                  text="xs neon-cyan hover:neon-cyan/80"
                  transition="colors"
                >
                  {allSelected() ? 'Clear all' : 'Select all'}
                </button>
              </div>
              <button
                onClick={() => runDelete(Array.from(selectedForDelete()))}
                disabled={selectedCount() === 0 || deleting()}
                w="full"
                p="2"
                bg={selectedCount() === 0 ? 'dark-bg-tertiary' : 'red-600/80 hover:red-600'}
                text={selectedCount() === 0 ? 'sm dark-text-tertiary' : 'sm white'}
                font="medium"
                rounded="md"
                transition="all"
                cursor={selectedCount() === 0 || deleting() ? 'not-allowed' : 'pointer'}
                opacity={deleting() ? '60' : '100'}
              >
                {deleting()
                  ? 'Deleting…'
                  : selectedCount() > 0
                    ? `Delete ${selectedCount()}`
                    : 'Delete'}
              </button>
            </div>
          </Show>
        </>
      )}
    </div>
  )
}
