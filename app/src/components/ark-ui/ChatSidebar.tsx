import { For, Show, Switch, Match, createSignal, createEffect, onCleanup } from 'solid-js'
import { Dialog } from '@ark-ui/solid/dialog'
import { SettingsPanel } from './SettingsPanel'
import { regenerateConversationTitle } from '../../lib/harness-client'
import { accentColor } from '../../lib/agent-palette'
import type { CompletionMark } from '../../lib/run-registry'
import type { ChainProgressSnapshot } from './useChainProgress'
import { useSessionRegistry } from '../../lib/session-registry-context'

/** Mirror of the server's ConversationKind/Status (kept local so the sidebar
 *  has no server-module import). */
export type ThreadKind = 'conversation' | 'action'
export type ThreadStatus = 'running' | 'paused' | 'done' | 'error'

export interface ChatThreadSummary {
  id: string
  title: string | null
  /** The agent's iconify class, pre-resolved server-side (#60). The route
   *  passes ConversationSummary rows straight through, so this is populated
   *  at runtime for persisted threads; absent on placeholders and for
   *  agents that no longer exist. */
  agentIcon?: string
  /** The agent's accent-family token, pre-resolved server-side alongside
   *  the icon. Arrives by the same structural passthrough; `accentColor()`
   *  maps an absent or unknown token to neutral zinc. */
  agentAccent?: string
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
  if (threads.some((t) => t.id === placeholderId)) return threads
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
  return threads.filter((t) => t.kind === filter)
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
  /** Delete the given conversations (#71). The sidebar owns the confirm UX;
   *  the route owns the mutation (thread list + registry disposal).
   *  Rejects → the dialog stays open for retry. */
  onDeleteThreads?: (ids: string[]) => Promise<void>
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
export function completionBorderColor(completion?: CompletionMark): string | undefined {
  if (!completion) return undefined
  return completion.outcome === 'error' ? 'rgba(248, 113, 113, 0.55)' : 'rgba(74, 222, 128, 0.55)'
}

/** One-shot flash class while a completion is still animating. */
export function rowFlashClass(completion?: CompletionMark): string {
  if (!completion?.flashing) return ''
  return completion.outcome === 'error' ? 'thread-flash-error' : 'thread-flash-done'
}

/**
 * Which leading badge a thread row shows.
 *
 * Badges are otherwise the *persisted* action-row set (POST-triggered runs have
 * no client-side stream, so their persisted `status` is the freshest signal we
 * have). A live run in THIS browser is indicated by the per-row progress strip
 * instead — see {@link progressPercent} — which is why a conversation takes no
 * badge for `running`, `paused` or `done`.
 *
 * **`error` is the exception, and it is the one that matters at rest** (F4 on
 * #278). A conversation row that ended badly — a turn that failed, or one the
 * stuck-run reaper reconciled hours after the process behind it died — used to
 * render identically to one that answered: this function opened with
 * `if (args.kind !== 'action') return 'none'` and the repo's own test pinned
 * `'none'` for every status. So the reaper's whole visible effect was an
 * action-row badge, and for the three abandoned CONVERSATIONS in the dev
 * database that motivated it, a reap changed nothing anyone could see. The
 * progress strip cannot cover this: it reports a run happening now, and the
 * rows in question are ones where nothing is happening at all.
 *
 * Pure so the precedence rules can be unit-tested without rendering.
 */
export type RowIndicator =
  'running' | 'error' | 'action-error' | 'action-paused' | 'action-done' | 'none'

export function rowIndicator(args: { kind: ThreadKind; status: ThreadStatus }): RowIndicator {
  if (args.kind !== 'action') return args.status === 'error' ? 'error' : 'none'
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

/**
 * Icon class for a thread row (#60). Placeholders show nothing — the real
 * icon appears within ~1s once the run-start refetch lands the persisted
 * row. Threads whose agent no longer exists fall back to a generic robot
 * (the fallback literal lives in this scanned .tsx, so it always emits).
 */
export function threadIcon(t: { isPlaceholder?: boolean; agentIcon?: string }): string | null {
  if (t.isPlaceholder) return null
  return t.agentIcon ?? 'i-material-symbols-smart-toy-outline'
}

/**
 * Status dot for a collapsed-rail thread button (#60). At 3rem there is no
 * room for the progress strip or flash border, so run state compresses to a
 * 6px dot: pulsing cyan while live (live outranks a completion mark — it is
 * fresher), completion color until the thread is opened, nothing at rest.
 */
export function railDot(args: {
  live: boolean
  completion?: CompletionMark
}): { color: string; pulse: boolean } | null {
  if (args.live) return { color: '#22d3ee', pulse: true }
  const c = completionBorderColor(args.completion)
  if (c) return { color: c, pulse: false }
  return null
}

/**
 * Whether a row may be deleted (#71). Placeholders have nothing persisted;
 * running rows are blocked because the run's end-save upsert would silently
 * recreate the deleted row — mid-run cancellation is out of scope (#105 PR 3).
 */
export function canDeleteRow(args: { isPlaceholder?: boolean; isProcessing: boolean }): boolean {
  return !args.isPlaceholder && !args.isProcessing
}

/** What the delete-confirm dialog is being asked to delete (#71). */
export type DeleteTarget =
  | { kind: 'single'; id: string; title: string | null }
  | { kind: 'bulk'; ids: string[]; skippedRunning: number }

/** Confirm copy — single line, no "Are you sure" hedge (house tone). */
export function deleteConfirmCopy(target: DeleteTarget): string {
  if (target.kind === 'single') {
    return `Delete "${target.title ?? '(untitled)'}"? This can't be undone.`
  }
  const n = target.ids.length
  const base = `Delete ${n} conversation${n === 1 ? '' : 's'}? This can't be undone.`
  return target.skippedRunning > 0 ? `${base} ${target.skippedRunning} running — skipped.` : base
}

// ---------------------------------------------------------------------------
// Select-mode helpers (#71) — pure so the eligibility/skip rules are testable.
// Eligible = deletable: not a placeholder, not running (see canDeleteRow).
// ---------------------------------------------------------------------------

/** Immutably toggle one id in a selection set. */
export function toggleSelection(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** Select every eligible thread in the given (visible) list, counting the
 *  running rows that had to be skipped for the confirm copy. */
export function selectAllEligible(
  threads: ReadonlyArray<Pick<ChatThreadSummary, 'id' | 'isPlaceholder'>>,
  isProcessing: (id: string) => boolean,
): { selected: ReadonlySet<string>; skippedRunning: number } {
  const selected = new Set<string>()
  let skippedRunning = 0
  for (const t of threads) {
    if (t.isPlaceholder) continue
    if (isProcessing(t.id)) {
      skippedRunning++
      continue
    }
    selected.add(t.id)
  }
  return { selected, skippedRunning }
}

/** True when every eligible thread in the list is selected (and there is at
 *  least one) — flips the header button label from "Select all" to "Clear". */
export function allEligibleSelected(
  threads: ReadonlyArray<Pick<ChatThreadSummary, 'id' | 'isPlaceholder'>>,
  selected: ReadonlySet<string>,
  isProcessing: (id: string) => boolean,
): boolean {
  let any = false
  for (const t of threads) {
    if (t.isPlaceholder || isProcessing(t.id)) continue
    any = true
    if (!selected.has(t.id)) return false
  }
  return any
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
      <div text="xs ui-text-tertiary" truncate>
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

/**
 * Icon-only status glyph for a thread row, keyed by {@link rowIndicator}.
 *
 * Icons are `material-symbols` (SA-L7). They used to be `i-mdi-*`, which is
 * **not** a registered collection in `uno.config.ts` — those classes emitted no
 * CSS at all, so every state rendered as the same empty 14px box and a failed
 * action was visually identical to a completed one. This is the load-bearing
 * case for the icon-set rule, not a cosmetic one.
 *
 * Each state carries an `aria-label` (icon-only, so the glyph *is* the control's
 * name) and a `title` — the text alternative `color-not-only` requires, since a
 * row has no space for a visible caption.
 *
 * Branches live in <Switch>/<Match>, not early returns — Solid components run
 * once, so a body-level `if (props.…) return …` freezes the branch at mount
 * (solid/components-return-once).
 */
const StatusBadge = (props: { indicator: RowIndicator }) => (
  <Switch>
    <Match when={props.indicator === 'running'}>
      <span
        title="Running"
        role="img"
        aria-label="Running"
        class="i-material-symbols-progress-activity animate-spin"
        w="3.5"
        h="3.5"
        text="cyan-400"
        style={{ 'flex-shrink': 0 }}
      />
    </Match>
    {/* Both failure states share a glyph: what the row is telling the reader is
        "this ended badly", and whether it was triggered over POST is what the
        `action-done` bolt is for. The conversation half arrived with F4 on
        #278 — before it, a reaped or failed conversation was indistinguishable
        from one that answered. */}
    <Match when={props.indicator === 'error' || props.indicator === 'action-error'}>
      <span
        title="Failed"
        role="img"
        aria-label="Failed"
        class="i-material-symbols-error-outline"
        w="3.5"
        h="3.5"
        text="red-400"
        style={{ 'flex-shrink': 0 }}
      />
    </Match>
    <Match when={props.indicator === 'action-paused'}>
      <span
        title="Awaiting approval"
        role="img"
        aria-label="Awaiting approval"
        class="i-material-symbols-pause-circle-outline"
        w="3.5"
        h="3.5"
        text="amber-500"
        style={{ 'flex-shrink': 0 }}
      />
    </Match>
    {/* Done action — a subtle bolt marks it as POST-triggered. 'none'
        matches nothing and renders nothing. */}
    <Match when={props.indicator === 'action-done'}>
      <span
        title="Action (completed)"
        role="img"
        aria-label="Action, completed"
        class="i-material-symbols-bolt-outline"
        w="3.5"
        h="3.5"
        text="ui-text-tertiary"
        style={{ 'flex-shrink': 0 }}
      />
    </Match>
  </Switch>
)

const FILTER_LABELS: ReadonlyArray<{ value: ThreadFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'conversation', label: 'Chats' },
  { value: 'action', label: 'Actions' },
]

export const ChatSidebar = (props: ChatSidebarProps) => {
  // Live per-session run state, progress and completion marks come from the
  // session registry in context (#226 B1) rather than three accessor props
  // that only handed the sidebar back into the route's maps.
  const registry = useSessionRegistry()
  // Per-thread pending state for the ↻ button — keyed by sessionId.
  const [pendingRegen, setPendingRegen] = createSignal<ReadonlySet<string>>(new Set())
  // Delete confirm state (#71): non-null while the dialog is up. `deleting`
  // keeps the dialog open (buttons disabled) during the server round trip.
  const [confirmTarget, setConfirmTarget] = createSignal<DeleteTarget | null>(null)
  const [deleting, setDeleting] = createSignal(false)

  const requestDelete = (e: MouseEvent, thread: ChatThreadSummary) => {
    // Stop the click from also selecting the thread.
    e.stopPropagation()
    e.preventDefault()
    setConfirmTarget({ kind: 'single', id: thread.id, title: thread.title })
  }

  const performDelete = async () => {
    const target = confirmTarget()
    if (!target || deleting() || !props.onDeleteThreads) return
    const ids = target.kind === 'single' ? [target.id] : target.ids
    setDeleting(true)
    try {
      await props.onDeleteThreads(ids)
      setConfirmTarget(null)
      // A successful bulk delete is a natural end to select mode.
      if (target.kind === 'bulk') exitSelectMode()
    } catch (err) {
      // Leave the dialog open so the user can retry or cancel.
      console.error('[sidebar] delete failed:', err)
    } finally {
      setDeleting(false)
    }
  }

  // ---- Select mode (#71) ----------------------------------------------------
  const [selectionMode, setSelectionMode] = createSignal(false)
  const [selectedIds, setSelectedIds] = createSignal<ReadonlySet<string>>(new Set())
  // Running rows skipped by the last select-all — reported in the confirm.
  const [skippedRunning, setSkippedRunning] = createSignal(0)

  const isRunning = (id: string) => registry.runState(id).isProcessing

  const exitSelectMode = () => {
    setSelectionMode(false)
    setSelectedIds(new Set<string>())
    setSkippedRunning(0)
  }

  const toggleRow = (thread: ChatThreadSummary) => {
    if (!canDeleteRow({ isPlaceholder: thread.isPlaceholder, isProcessing: isRunning(thread.id) }))
      return
    setSelectedIds((prev) => toggleSelection(prev, thread.id))
  }

  // Select-all acts on the VISIBLE (filtered) threads; selections persist
  // across filter switches because they're a set of ids, not row references.
  // "Clear" drops everything, visible or not.
  const toggleSelectAllVisible = () => {
    if (allEligibleSelected(visibleThreads(), selectedIds(), isRunning)) {
      setSelectedIds(new Set<string>())
      setSkippedRunning(0)
    } else {
      const { selected, skippedRunning: skipped } = selectAllEligible(visibleThreads(), isRunning)
      setSelectedIds((prev) => new Set([...prev, ...selected]))
      setSkippedRunning(skipped)
    }
  }

  const requestBulkDelete = () => {
    // Re-check run state at confirm time — a run may have started in a
    // selected thread since it was ticked. Newly-running rows move into the
    // skip count rather than being deleted out from under their run.
    const chosen = [...selectedIds()]
    const stillIdle = chosen.filter((id) => !isRunning(id))
    const newlyRunning = chosen.length - stillIdle.length
    if (stillIdle.length === 0) return
    setConfirmTarget({
      kind: 'bulk',
      ids: stillIdle,
      skippedRunning: skippedRunning() + newlyRunning,
    })
  }

  // Collapsing the sidebar hides every select-mode affordance — exit rather
  // than leaving invisible state armed.
  createEffect(() => {
    if (props.collapsed && selectionMode()) exitSelectMode()
  })

  // Keyboard, scoped to select mode (first document-level keydown in the
  // codebase): Esc exits, Cmd/Ctrl-A toggles select-all. The Ark dialog owns
  // its own Esc while open, and typing surfaces (composer!) keep native
  // select-all — both are bypassed explicitly.
  createEffect(() => {
    if (!selectionMode()) return
    const onKey = (e: KeyboardEvent) => {
      if (confirmTarget()) return
      const t = e.target as HTMLElement | null
      if (
        t &&
        (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable)
      )
        return
      if (e.key === 'Escape') {
        exitSelectMode()
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        toggleSelectAllVisible()
      }
    }
    document.addEventListener('keydown', onKey)
    onCleanup(() => document.removeEventListener('keydown', onKey))
  })
  // Segmented Actions/Conversations/All filter (#agent-trigger). Local state —
  // the parent passes the full thread list; we filter for display.
  const [filter, setFilter] = createSignal<ThreadFilter>('all')
  const visibleThreads = () => filterThreads(props.threads, filter())

  const handleRegenerate = async (e: MouseEvent, threadId: string) => {
    // Stop the click from also selecting the thread.
    e.stopPropagation()
    e.preventDefault()
    if (pendingRegen().has(threadId)) return
    setPendingRegen((prev) => new Set(prev).add(threadId))
    try {
      const title = await regenerateConversationTitle(threadId)
      if (title) props.onTitleRegenerated?.(threadId, title)
    } catch (err) {
      console.error('[sidebar] regenerate title failed:', err)
    } finally {
      setPendingRegen((prev) => {
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
      bg="ui-bg-primary"
      border="r ui-border-primary"
      transition="width"
      style={{ width: props.collapsed ? '3rem' : '16rem' }}
    >
      {/* Header with Toggle */}
      <div p="4" border="b ui-border-primary" flex="~" items="center" justify="between">
        {!props.collapsed && (
          <div flex="~" items="center" gap="2">
            <span text="sm ui-text-primary" font="medium">
              Chat History
            </span>
            {/* Select-mode toggle (#71) */}
            <button
              onClick={() => (selectionMode() ? exitSelectMode() : setSelectionMode(true))}
              title={selectionMode() ? 'Exit select mode' : 'Select conversations'}
              aria-pressed={selectionMode() ? 'true' : 'false'}
              p="1"
              rounded="md"
              hover="bg-ui-bg-hover"
              transition="colors"
            >
              <span
                class="i-material-symbols-checklist"
                aria-hidden="true"
                style={{
                  width: '16px',
                  height: '16px',
                  display: 'block',
                  color: selectionMode() ? '#22d3ee' : 'var(--ui-text-tertiary)',
                }}
              />
            </button>
          </div>
        )}
        <button
          onClick={() => props.onToggle()}
          p="2"
          rounded="md"
          hover="bg-ui-bg-hover"
          transition="colors"
          text="ui-accent"
          flex="shrink-0"
          title={props.collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d={props.collapsed ? 'M9 5l7 7-7 7' : 'M15 19l-7-7 7-7'}
            />
          </svg>
        </button>
      </div>

      {/* Collapsed icon rail (#60) — one agent-icon button per thread.
          Deliberately ignores the kind filter: that control is invisible
          while collapsed, and a hidden control silently subsetting the list
          would confuse. Selected/live state uses inline styles — the
          attributify extractor drops dynamic values (see rowFlashClass
          notes), and `border="1 ui-accent/40"` is a known dead selector. */}
      {props.collapsed && (
        <>
          <div flex="1" overflow="y-auto" p="y-2">
            <For each={props.threads}>
              {(thread) => {
                const isSelected = () => thread.id === props.selectedId
                const dot = () =>
                  railDot({
                    live: registry.runState(thread.id).isProcessing,
                    completion: registry.completion(thread.id),
                  })
                return (
                  <button
                    onClick={() => props.onSelectThread(thread.id)}
                    title={thread.isPlaceholder ? 'new chat' : (thread.title ?? '(untitled)')}
                    aria-label={thread.isPlaceholder ? 'new chat' : (thread.title ?? '(untitled)')}
                    aria-current={isSelected() ? 'true' : undefined}
                    style={{
                      position: 'relative',
                      display: 'flex',
                      'align-items': 'center',
                      'justify-content': 'center',
                      width: '32px',
                      height: '32px',
                      margin: '0 auto 4px',
                      'border-radius': '0.375rem',
                      border: isSelected()
                        ? '1px solid rgba(0, 255, 255, 0.4)'
                        : '1px solid transparent',
                      background: isSelected() ? 'rgba(67, 56, 202, 0.3)' : 'transparent',
                      cursor: 'pointer',
                    }}
                    hover="bg-ui-bg-hover"
                  >
                    {/* Always accented here, unlike the expanded rows: with
                        no title to read, colour is the only thing telling
                        one 32px button from the next. Selection is carried
                        by the button's border + background instead. */}
                    <span
                      class={threadIcon(thread) ?? 'i-material-symbols-smart-toy-outline'}
                      aria-hidden="true"
                      style={{
                        width: '16px',
                        height: '16px',
                        color: accentColor(thread.agentAccent),
                        opacity: thread.isPlaceholder ? 0.5 : 1,
                      }}
                    />
                    <Show when={dot()}>
                      {(d) => (
                        <span
                          aria-hidden="true"
                          class={d().pulse ? 'animate-pulse' : ''}
                          style={{
                            position: 'absolute',
                            bottom: '2px',
                            right: '2px',
                            width: '6px',
                            height: '6px',
                            'border-radius': '9999px',
                            'background-color': d().color,
                          }}
                        />
                      )}
                    </Show>
                  </button>
                )
              }}
            </For>
          </div>
          {/* Compact new-chat button — Settings stays expanded-only. */}
          <div p="y-3" border="t ui-border-primary" flex="~" justify="center">
            <button
              onClick={() => props.onNewChat()}
              title="New chat"
              aria-label="New chat"
              bg="cyber-700 hover:cyber-600"
              rounded="md"
              transition="all"
              style={{
                width: '32px',
                height: '32px',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
              }}
            >
              <span
                class="i-material-symbols-add-2"
                aria-hidden="true"
                style={{ width: '16px', height: '16px', color: 'white' }}
              />
            </button>
          </div>
        </>
      )}

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
                    text={active() ? 'xs ui-accent' : 'xs ui-text-tertiary'}
                    bg={active() ? 'cyber-700/30' : 'transparent hover:ui-bg-hover'}
                    border={active() ? '1 ui-accent/40' : '1 transparent'}
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
          {/* Select-mode action bar (#71). The filter stays usable above —
              selections persist across filter switches. */}
          <Show when={selectionMode()}>
            <div p="x-2 t-2" flex="~" gap="1" items="center">
              <button
                onClick={toggleSelectAllVisible}
                p="x-2 y-1"
                rounded="md"
                text="xs ui-text-secondary"
                bg="transparent hover:ui-bg-hover"
                border="1 ui-border-secondary"
                transition="all"
              >
                {allEligibleSelected(visibleThreads(), selectedIds(), isRunning)
                  ? 'Clear'
                  : 'Select all'}
              </button>
              <button
                onClick={requestBulkDelete}
                disabled={selectedIds().size === 0}
                flex="1"
                p="x-2 y-1"
                rounded="md"
                text="xs white"
                bg="red-600 hover:red-500"
                font="medium"
                transition="all"
                style={{ opacity: selectedIds().size === 0 ? 0.4 : 1 }}
              >
                Delete selected ({selectedIds().size})
              </button>
              <button
                onClick={exitSelectMode}
                p="x-2 y-1"
                rounded="md"
                text="xs ui-text-secondary"
                bg="transparent hover:ui-bg-hover"
                border="1 ui-border-secondary"
                transition="all"
              >
                Cancel
              </button>
            </div>
          </Show>
          <div flex="1" overflow="auto">
            <Show
              when={visibleThreads().length > 0}
              fallback={
                <div p="4" text="xs ui-text-tertiary">
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
                    const live = () => registry.runState(thread.id).isProcessing
                    const indicator = () =>
                      rowIndicator({ kind: thread.kind, status: thread.status })
                    const completion = () => registry.completion(thread.id)
                    const completionTitle = () => {
                      const c = completion()
                      if (!c) return undefined
                      return c.outcome === 'error'
                        ? 'Finished with an error while you were away'
                        : 'Finished while you were away'
                    }
                    return (
                      <button
                        onClick={() =>
                          selectionMode() ? toggleRow(thread) : props.onSelectThread(thread.id)
                        }
                        w="full"
                        text="left"
                        p="3"
                        rounded="md"
                        bg={isSelected() ? 'cyber-700/30' : ''}
                        hover="bg-ui-bg-hover"
                        transition="all"
                        border={
                          isSelected() ? '1 ui-accent/40' : '1 transparent hover:ui-accent/30'
                        }
                        cursor="pointer"
                        data-placeholder={thread.isPlaceholder ? '' : undefined}
                        data-completed={completion()?.outcome}
                        title={completionTitle()}
                        relative=""
                        class={`group ${rowFlashClass(completion())}`}
                        style={{ 'border-color': completionBorderColor(completion()) }}
                      >
                        {/* Inline padding-right: two hover actions need
                            ~3.5rem clearance, and new attributify spacing
                            literals are extractor roulette (see t-1.5). */}
                        <div
                          flex="~"
                          items="center"
                          gap="1.5"
                          style={{ 'padding-right': '3.5rem' }}
                        >
                          {/* Select-mode checkbox (#71) — a styled span, not
                              an <input>: rows are <button>s and nesting an
                              interactive element would break semantics.
                              Running/placeholder rows render it dimmed and
                              toggleRow() no-ops for them. */}
                          <Show when={selectionMode()}>
                            <span
                              role="checkbox"
                              aria-checked={selectedIds().has(thread.id) ? 'true' : 'false'}
                              aria-disabled={
                                canDeleteRow({
                                  isPlaceholder: thread.isPlaceholder,
                                  isProcessing: live(),
                                })
                                  ? undefined
                                  : 'true'
                              }
                              class={
                                selectedIds().has(thread.id)
                                  ? 'i-material-symbols-check-box'
                                  : 'i-material-symbols-check-box-outline-blank'
                              }
                              style={{
                                width: '16px',
                                height: '16px',
                                'flex-shrink': 0,
                                color: selectedIds().has(thread.id)
                                  ? '#22d3ee'
                                  : 'var(--ui-text-tertiary)',
                                opacity: canDeleteRow({
                                  isPlaceholder: thread.isPlaceholder,
                                  isProcessing: live(),
                                })
                                  ? 1
                                  : 0.35,
                              }}
                            />
                          </Show>
                          {/* Agent identity (#60) — muted so the title stays
                              the row's anchor, taking the agent's accent
                              family on row hover and while selected. The
                              colour rides in as a custom property because
                              it's per-row: `.agent-glyph` (a preflight rule)
                              owns the rest states, since a dynamic utility
                              class would never be extracted. */}
                          <Show when={threadIcon(thread)}>
                            {(icon) => (
                              <span
                                class={`${icon()} agent-glyph`}
                                aria-hidden="true"
                                data-lit={isSelected() ? 'true' : undefined}
                                style={{
                                  width: '14px',
                                  height: '14px',
                                  'flex-shrink': 0,
                                  '--agent-accent': accentColor(thread.agentAccent),
                                }}
                              />
                            )}
                          </Show>
                          <StatusBadge indicator={indicator()} />
                          <div
                            text={
                              thread.isPlaceholder ? 'sm ui-text-tertiary' : 'sm ui-text-primary'
                            }
                            font={thread.isPlaceholder ? 'normal italic' : 'medium'}
                            truncate
                            flex="1"
                          >
                            {thread.isPlaceholder
                              ? PLACEHOLDER_TITLE
                              : (thread.title ?? '(untitled)')}
                          </div>
                        </div>
                        {/* While a run streams, the timestamp row gives way
                            to the live status + mini progress strip — the
                            same per-session controller that feeds the
                            in-chat bar (#105). Reappears when the run ends. */}
                        <Show
                          when={live()}
                          fallback={
                            <div text="xs ui-text-tertiary" m="t-1">
                              {formatTimestamp(thread.updatedAt)}
                            </div>
                          }
                        >
                          <RowProgress snapshot={registry.progress(thread.id).snapshot()} />
                        </Show>
                        {/* Hover-reveal delete button (#71). Hidden — not
                            disabled — for placeholders and running rows: a
                            mid-run delete would be resurrected by the run's
                            end-save upsert, so the affordance simply isn't
                            offered (mid-run cancel is #105 PR 3 scope). Same
                            span-not-button idiom as the regenerate action. */}
                        <Show
                          when={
                            !selectionMode() &&
                            canDeleteRow({
                              isPlaceholder: thread.isPlaceholder,
                              isProcessing: live(),
                            })
                          }
                        >
                          <span
                            aria-hidden="true"
                            onClick={(e) => requestDelete(e, thread)}
                            title="Delete conversation"
                            style={{
                              position: 'absolute',
                              top: '0.5rem',
                              right: '0.5rem',
                              padding: '0.25rem',
                              'border-radius': '0.375rem',
                              cursor: 'pointer',
                            }}
                            text="xs ui-text-tertiary hover:red-400"
                            transition="opacity"
                            class="opacity-0 group-hover:opacity-100"
                          >
                            <span
                              class="i-material-symbols-delete-outline"
                              style={{ width: '14px', height: '14px', display: 'block' }}
                            />
                          </span>
                        </Show>
                        {/* Hover-reveal regenerate-title button. Hidden for
                            placeholder rows (nothing persisted yet). Spinning
                            while the LLM call is in flight. Sits in a span
                            outside the outer <button> hit area so nested-
                            interactive semantics stay valid. Shifted left to
                            make room for the delete action at right:0.5rem. */}
                        <Show when={!selectionMode() && !thread.isPlaceholder}>
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
                            text="xs ui-text-tertiary hover:ui-accent"
                            transition="opacity"
                            class={
                              isRegenerating() ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                            }
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
          <div p="4" border="t ui-border-primary" flex="~" gap="2" items="center">
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

      {/* Delete confirm (#71) — Ark Dialog for free Escape + focus trap.
          `lazyMount unmountOnExit` is LOAD-BEARING: without it Ark keeps the
          closed dialog mounted with the `hidden` attribute, and an
          attributify display utility (flex="~") overrides the UA's
          [hidden]{display:none} — the "hidden" positioner rendered as an
          in-flow full-height div inside this flex column, starving the
          thread list to zero height. Positioning is inline because
          `position` is not an attributify rule at all (silently a no-op).
          See Rendering gotchas #4 in docs/UI_ARCHITECTURE.md. */}
      <Dialog.Root
        open={confirmTarget() != null}
        onOpenChange={(d) => {
          if (!d.open && !deleting()) setConfirmTarget(null)
        }}
        lazyMount
        unmountOnExit
      >
        <Dialog.Backdrop
          style={{
            position: 'fixed',
            inset: '0',
            'z-index': '40',
            background: 'rgba(0, 0, 0, 0.5)',
          }}
        />
        <Dialog.Positioner
          style={{
            position: 'fixed',
            inset: '0',
            'z-index': '50',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
          }}
        >
          <Dialog.Content
            bg="ui-bg-secondary"
            border="1 ui-border-primary"
            rounded="lg"
            shadow="2xl"
            p="5"
            m="4"
            style={{ 'max-width': '24rem' }}
          >
            <Show when={confirmTarget()}>
              {(target) => (
                <>
                  <Dialog.Title
                    text="sm ui-text-primary"
                    font="medium"
                    flex="~"
                    items="center"
                    gap="2"
                  >
                    <span
                      class="i-material-symbols-delete-outline"
                      aria-hidden="true"
                      style={{
                        width: '18px',
                        height: '18px',
                        color: 'var(--ui-danger)',
                        'flex-shrink': 0,
                      }}
                    />
                    {target().kind === 'single' ? 'Delete conversation' : 'Delete conversations'}
                  </Dialog.Title>
                  <Dialog.Description
                    text="xs ui-text-secondary"
                    m="t-2 b-4"
                    style={{ 'line-height': '1.5' }}
                  >
                    {deleteConfirmCopy(target())}
                  </Dialog.Description>
                  <div flex="~" gap="2" justify="end">
                    <button
                      onClick={() => setConfirmTarget(null)}
                      disabled={deleting()}
                      p="x-3 y-1.5"
                      rounded="md"
                      text="xs ui-text-secondary"
                      bg="transparent hover:ui-bg-hover"
                      border="1 ui-border-secondary"
                      transition="all"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => void performDelete()}
                      disabled={deleting()}
                      p="x-3 y-1.5"
                      rounded="md"
                      text="xs white"
                      bg="red-600 hover:red-500"
                      font="medium"
                      transition="all"
                    >
                      {deleting() ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                </>
              )}
            </Show>
          </Dialog.Content>
        </Dialog.Positioner>
      </Dialog.Root>
    </div>
  )
}
