/**
 * Thread-list store — the sidebar's list of conversations, and the four ways
 * it changes (#226 B1).
 *
 * The chat route used to hold this inline alongside the per-session registry:
 * a `createResource`, an optimistic placeholder, two in-place cache patches
 * (`title_updated`, promotion), a poll for background actions, and a bulk
 * delete. None of it is per-session state, so it does not belong in
 * `SessionRegistry`; all of it is route-level and reused by exactly one
 * consumer, so it does not belong in the route body either.
 *
 * Everything here is *list* state. The registry owns everything keyed by a
 * session id; deleting rows is the one place the two meet, and the route
 * wires that (delete here, then `registry.dispose`).
 */
import { createEffect, createResource, onCleanup, type Accessor } from 'solid-js'
import {
  listConversations,
  deleteConversationsBulk,
  type ConversationSummary,
} from '~/lib/harness-client'

/** How often a still-`running` background action is re-polled. */
export const RUNNING_ACTION_POLL_MS = 5000

export interface ThreadListStore {
  /** Persisted rows, newest first. Stale-while-revalidating — see note below. */
  threads: Accessor<ConversationSummary[]>
  /** Re-query the list. Safe to call from anywhere; the resource dedupes. */
  refetch(): void
  /** Show an optimistic row for a freshly-minted "+ New Chat" id (#44). */
  showPlaceholder(sessionId: string): void
  /** Drop the optimistic row (the user picked an existing thread). */
  clearPlaceholder(): void
  /** Patch one row's title in place — the `title_updated` SSE event already
   *  carries the new title, so no refetch is needed. */
  applyTitle(sessionId: string, title: string): void
  /** Flip a row's kind so a promoted action moves from Actions to Chats. */
  markPromoted(sessionId: string): void
  /** Delete rows server-side and drop the confirmed ones from the cache.
   *  Returns the ids the server actually deleted (ground truth). */
  remove(ids: string[]): Promise<string[]>
}

/**
 * Create the store. Must be called from a component body (or another reactive
 * owner): it opens a resource and an effect that are torn down with the owner.
 *
 * `placeholderId` is supplied by the caller rather than owned here because the
 * route also needs it as the selected session id — one signal, two readers,
 * rather than two that can disagree.
 */
export function createThreadListStore(args: {
  placeholderId: Accessor<string | null>
  setPlaceholderId: (id: string | null) => void
}): ThreadListStore {
  const [resource, { refetch, mutate }] = createResource(() => listConversations())

  // IMPORTANT: read via `resource.latest`, never `resource()` (#105). The app
  // root wraps routes in an empty-fallback <Suspense>; a plain read
  // re-registers with that boundary on every refetch, detaching the ENTIRE
  // route for the duration of the DB query — a blank flash that drops composer
  // focus and chat scroll (typed text survives because the nodes are
  // re-attached, not recreated). `latest` returns the stale list without
  // touching Suspense once a first value exists; the initial page load still
  // suspends as before.
  const threads: Accessor<ConversationSummary[]> = () => resource.latest ?? []

  // Once the persisted row for the placeholder lands, drop the optimistic row
  // so the real one (with its sticky title) takes over.
  createEffect(() => {
    const ph = args.placeholderId()
    if (!ph) return
    if (threads().some((t) => t.id === ph)) args.setPlaceholderId(null)
  })

  // Background actions complete off any browser channel, so poll the list
  // while at least one action is still `running` to surface the running→done
  // flip. The effect re-runs on every list change; it only arms an interval
  // when a running action exists, and clears it as soon as none remain.
  createEffect(() => {
    const hasRunningAction = threads().some((t) => t.kind === 'action' && t.status === 'running')
    if (!hasRunningAction) return
    const interval = setInterval(() => refetch(), RUNNING_ACTION_POLL_MS)
    onCleanup(() => clearInterval(interval))
  })

  return {
    threads,
    refetch: () => {
      refetch()
    },
    showPlaceholder: (sessionId) => args.setPlaceholderId(sessionId),
    clearPlaceholder: () => args.setPlaceholderId(null),
    applyTitle: (sessionId, title) => {
      mutate((list) => (list ?? []).map((t) => (t.id === sessionId ? { ...t, title } : t)))
    },
    markPromoted: (sessionId) => {
      mutate((list) =>
        (list ?? []).map((t) => (t.id === sessionId ? { ...t, kind: 'conversation' as const } : t)),
      )
    },
    remove: async (ids) => {
      const { deleted } = await deleteConversationsBulk(ids)
      if (deleted.length === 0) return deleted
      const gone = new Set(deleted)
      mutate((list) => (list ?? []).filter((t) => !gone.has(t.id)))
      return deleted
    },
  }
}
