import { For, Show, createSignal } from 'solid-js'
import { SettingsPanel } from './SettingsPanel'
import { regenerateConversationTitle } from '../../lib/harness-client'
import type { CompletionMark, SessionRunState } from '../../lib/run-registry'
import type { ChainProgressController, ChainProgressSnapshot } from './useChainProgress'

/** Mirror of the server's ConversationKind/Status (kept local so the sidebar
 *  has no server-module import). */
export type ThreadKind = 'conversation' | 'action'
export type ThreadStatus = 'running' | 'paused' | 'done' | 'error'

export interface ChatThreadSummary {
  id: string
  title: string | null
  /** ISO 8601 timestamp from the server. */
  updatedAt: string
  /** 'conversation' (chat) | 'action' (POST-triggered). Drives the filter. */
  kind: ThreadKind
  /** Lifted run status — drives the in-flight spinner / error badge. */
  status: ThreadStatus
  /** Optimistic client-side row for a brand-new chat that hasn't been
   *  persisted yet. Replaced in place once the real row appears in the
   *  threadsResource refetch. */
  isPlaceholder?: boolean
}

/** The sidebar's segmented filter. */
export type ThreadFilter = 'all' | 'conversation' | 'action'

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
    // A freshly-minted "+ New Chat" is always a chat conversation.
    kind: 'conversation',
    status: 'done',
    isPlaceholder: true,
  }
  return [placeholder, ...threads]
}

/** Filter threads by the selected segment. The optimistic placeholder is a
 *  conversation, so it shows under 'all' and 'conversation' but not 'action'. */
export function filterThreads(
  threads: ChatThreadSummary[],
  filter: ThreadFilter,
): ChatThreadSummary[] {
  if (filter === 'all') return threads
  return threads.filter(t => t.kind === filter)
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
  /** Live per-session run state from the route registry (#105). Drives the
   *  per-row progress readout while *its* run is in flight, regardless of
   *  which thread is selected. Optional so the sidebar renders without it. */
  getRunState?: (sessionId: string) => SessionRunState
  /** Per-session progress controller from the route registry — the same one
   *  feeding the in-chat LiveProgressBar. Only consulted for rows whose run
   *  state says a stream is open (a run's controller always exists by then). */
  getProgress?: (sessionId: string) => ChainProgressController
  /** Completion mark for a run that finished while the user was reading
   *  another thread: the row flashes once, then keeps an accent border
   *  until opened (#105). */
  getCompletion?: (sessionId: string) => CompletionMark | undefined
}

/**
 * Accent border colour for a row carrying a completion mark, as an inline
 * `border-color` value (or undefined to leave the attributify border alone).
 *
 * Deliberately NOT attributify: presetAttributify builds its `[border~="…"]`
 * selectors by scanning literal `border="…"` text in source, so a colour that
 * only ever appears inside a dynamic expression is never emitted. Inline
 * `border-color` sidesteps the extractor entirely and also outranks the
 * hover rule, so the mark stays visible under the cursor.
 *
 * Matches the `thread-flash-*` keyframe colours in `uno.config.ts`.
 *
 * Selection is handled by the existing attributify border and wins by virtue
 * of the mark being cleared on select — the two only collide for a frame.
 */
export function completionBorderColor(
  completion?: CompletionMark,
): string | undefined {
  if (!completion) return undefined
  return completion.outcome === 'error'
    ? 'rgba(248, 113, 113, 0.55)'
    : 'rgba(74, 222, 128, 0.55)'
}

/** One-shot flash class while a completion is still animating. */
export function rowFlashClass(completion?: CompletionMark): string {
  if (!completion?.flashing) return ''
  return completion.outcome === 'error' ? 'thread-flash-error' : 'thread-flash-done'
}

/**
 * Which leading badge a thread row shows.
 *
 * Badges are the *persisted* action-row set only (POST-triggered runs have no
 * client-side stream, so their persisted `status` is the freshest signal we
 * have). A live run in THIS browser is indicated by the per-row progress
 * strip instead — see {@link progressPercent} — so conversations never take
 * a badge.
 *
 * Pure so the precedence rules can be unit-tested without rendering.
 */
export type RowIndicator =
  | 'running'
  | 'action-error'
  | 'action-paused'
  | 'action-done'
  | 'none'

export function rowIndicator(args: {
  kind: ThreadKind
  status: ThreadStatus
}): RowIndicator {
  if (args.kind !== 'action') return 'none'
  if (args.status === 'running') return 'running'
  if (args.status === 'error') return 'action-error'
  if (args.status === 'paused') return 'action-paused'
  return 'action-done'
}

/**
 * Fill fraction (0–100) for the row's mini progress strip, or null while the
 * chain projection hasn't been seeded yet (→ render as indeterminate).
 *
 * Same math as the in-chat LiveProgressBar: currentTurn over the refined
 * path projection, with the stable max as fallback denominator.
 */
export function progressPercent(snap: {
  currentTurn: number
  pathProjection: number
  maxProjection: number
}): number | null {
  const denom = snap.pathProjection || snap.maxProjection
  if (denom <= 0) return null
  return Math.max(0, Math.min(100, (snap.currentTurn / denom) * 100))
}

/** Shared with the in-chat LiveProgressBar so the two read as one system. */
const STRIP_GRADIENT = 'linear-gradient(90deg, rgba(0,255,255,0.85), rgba(157,0,255,0.85))'

/**
 * Row-sized live-run readout: current status line + a 3px progress strip.
 * Replaces the "{x} ago" timestamp while the run streams. Reuses the chat
 * bar's *mechanics* (ChainProgressSnapshot from the route's per-session
 * controller) but not the component — this is a strip, not a labelled bar.
 */
const RowProgress = (props: { snapshot: ChainProgressSnapshot }) => {
  const pct = () => progressPercent(props.snapshot)
  return (
    // m="t-1" and gap="1", not t-1.5: verified against the built sheet —
    // the extractor drops [m~=t-1.5] while these both emit.
    <div m="t-1" flex="~ col" gap="1">
      <div text="xs dark-text-tertiary" truncate>
        {props.snapshot.status ?? 'Starting…'}
      </div>
      <div
        style={{
          height: '3px',
          'border-radius': '9999px',
          overflow: 'hidden',
          'background-color': 'rgb(58, 58, 74)',
        }}
      >
        <Show
          when={pct() !== null}
          fallback={
            // Projection not seeded yet — indeterminate shimmer so the row
            // reacts the instant the run starts, before the first estimate.
            <div
              class="thread-progress-indeterminate"
              style={{
                height: '100%',
                width: '40%',
                'border-radius': '9999px',
                'background-image': STRIP_GRADIENT,
              }}
            />
          }
        >
          <div
            style={{
              height: '100%',
              width: `${pct()}%`,
              'background-image': STRIP_GRADIENT,
              'box-shadow': '0 0 8px rgba(0,255,255,0.45)',
              transition: 'width 420ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          />
        </Show>
      </div>
    </div>
  )
}

/** Renders the indicator chosen by {@link rowIndicator}. */
const StatusBadge = (props: { indicator: RowIndicator }) => {
  if (props.indicator === 'none') return null
  if (props.indicator === 'running') {
    return (
      <span
        title="Running"
        aria-label="running"
        class="i-mdi-loading animate-spin"
        style={{ width: '14px', height: '14px', color: '#22d3ee', 'flex-shrink': 0 }}
      />
    )
  }
  if (props.indicator === 'action-error') {
    return (
      <span
        title="Failed"
        aria-label="error"
        class="i-mdi-alert-circle-outline"
        style={{ width: '14px', height: '14px', color: '#f87171', 'flex-shrink': 0 }}
      />
    )
  }
  if (props.indicator === 'action-paused') {
    return (
      <span
        title="Awaiting approval"
        aria-label="paused"
        class="i-mdi-pause-circle-outline"
        style={{ width: '14px', height: '14px', color: '#f59e0b', 'flex-shrink': 0 }}
      />
    )
  }
  // Done action — a subtle bolt marks it as POST-triggered without shouting.
  return (
    <span
      title="Action (completed)"
      aria-label="action"
      class="i-mdi-lightning-bolt-outline"
      style={{ width: '13px', height: '13px', color: '#71717a', 'flex-shrink': 0 }}
    />
  )
}

const FILTER_LABELS: ReadonlyArray<{ value: ThreadFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'conversation', label: 'Chats' },
  { value: 'action', label: 'Actions' },
]

export const ChatSidebar = (props: ChatSidebarProps) => {
  // Per-thread pending state for the ↻ button — keyed by sessionId.
  const [pendingRegen, setPendingRegen] = createSignal<ReadonlySet<string>>(new Set())
  // Segmented Actions/Conversations/All filter (#agent-trigger). Local state —
  // the parent passes the full thread list; we filter for display.
  const [filter, setFilter] = createSignal<ThreadFilter>('all')
  const visibleThreads = () => filterThreads(props.threads, filter())

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
          {/* Segmented filter: All / Chats / Actions */}
          <div p="x-2 t-2" flex="~" gap="1">
            <For each={FILTER_LABELS}>
              {(opt) => {
                const active = () => filter() === opt.value
                return (
                  <button
                    onClick={() => setFilter(opt.value)}
                    flex="1"
                    p="y-1"
                    rounded="md"
                    text={active() ? 'xs neon-cyan' : 'xs dark-text-tertiary'}
                    bg={active() ? 'cyber-700/30' : 'transparent hover:dark-bg-hover'}
                    border={active() ? '1 neon-cyan/40' : '1 transparent'}
                    transition="all"
                    font="medium"
                    aria-pressed={active() ? 'true' : 'false'}
                  >
                    {opt.label}
                  </button>
                )
              }}
            </For>
          </div>
          <div flex="1" overflow="auto">
            <Show
              when={visibleThreads().length > 0}
              fallback={
                <div p="4" text="xs dark-text-tertiary">
                  {filter() === 'action'
                    ? 'No actions yet. Trigger one via POST /api/agents/:id.'
                    : 'No conversations yet. Send a message to start.'}
                </div>
              }
            >
              <div p="2" space="y-1">
                <For each={visibleThreads()}>
                  {(thread) => {
                    const isSelected = () => thread.id === props.selectedId
                    const isRegenerating = () => pendingRegen().has(thread.id)
                    // Live run state for THIS row — a backgrounded run keeps
                    // its progress readout while the user reads another
                    // thread (#105).
                    const live = () => !!props.getRunState?.(thread.id).isProcessing
                    const indicator = () =>
                      rowIndicator({ kind: thread.kind, status: thread.status })
                    const completion = () => props.getCompletion?.(thread.id)
                    const completionTitle = () => {
                      const c = completion()
                      if (!c) return undefined
                      return c.outcome === 'error'
                        ? 'Finished with an error while you were away'
                        : 'Finished while you were away'
                    }
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
                        data-completed={completion()?.outcome}
                        title={completionTitle()}
                        relative=""
                        class={`group ${rowFlashClass(completion())}`}
                        style={{ 'border-color': completionBorderColor(completion()) }}
                      >
                        <div flex="~" items="center" gap="1.5" pr="6">
                          <StatusBadge indicator={indicator()} />
                          <div
                            text={thread.isPlaceholder ? 'sm dark-text-tertiary' : 'sm dark-text-primary'}
                            font={thread.isPlaceholder ? 'normal italic' : 'medium'}
                            truncate
                            flex="1"
                          >
                            {thread.isPlaceholder
                              ? PLACEHOLDER_TITLE
                              : thread.title ?? '(untitled)'}
                          </div>
                        </div>
                        {/* While a run streams, the timestamp row gives way
                            to the live status + mini progress strip — the
                            same per-session controller that feeds the
                            in-chat bar (#105). Reappears when the run ends. */}
                        <Show
                          when={live() && props.getProgress}
                          fallback={
                            <div text="xs dark-text-tertiary" m="t-1">
                              {formatTimestamp(thread.updatedAt)}
                            </div>
                          }
                        >
                          <RowProgress snapshot={props.getProgress!(thread.id).snapshot()} />
                        </Show>
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
