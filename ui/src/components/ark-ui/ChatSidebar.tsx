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
      <div p="4" border="b dark-border-primary" flex="~" items="center" justify="between">
        {!props.collapsed && (
          <span text="sm dark-text-primary" font="medium">Chat History</span>
        )}
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
                    return (
                      <button
                        onClick={() => props.onSelectThread(thread.id)}
                        w="full"
                        text="left"
                        p="3"
                        rounded="md"
                        bg={isSelected() ? 'cyber-700/30' : ''}
                        hover="bg-dark-bg-hover"
                        transition="all"
                        border={isSelected() ? '1 neon-cyan/40' : '1 transparent hover:neon-cyan/30'}
                        cursor="pointer"
                        data-placeholder={thread.isPlaceholder ? '' : undefined}
                        relative=""
                        class="group"
                      >
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
                        {/* Hover-reveal regenerate-title button. Hidden for
                            placeholder rows (nothing persisted yet). Spinning
                            while the LLM call is in flight. Sits in a span
                            outside the outer <button> hit area so nested-
                            interactive semantics stay valid. */}
                        <Show when={!thread.isPlaceholder}>
                          <span
                            aria-hidden="true"
                            onClick={(e) => handleRegenerate(e, thread.id)}
                            title="Regenerate title"
                            style={{
                              position: 'absolute',
                              top: '0.5rem',
                              right: '0.5rem',
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
                        </Show>
                      </button>
                    )
                  }}
                </For>
              </div>
            </Show>
          </div>

          {/* Footer: Settings + New Chat */}
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
        </>
      )}
    </div>
  )
}
