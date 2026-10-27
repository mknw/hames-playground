/**
 * Header inbox — what is waiting on the person, across conversations (#433 S8).
 *
 * Lists the conversations whose run waits on a decision (`listBlockingInbox`,
 * decision-loop-agent slice 9) and the pending memory proposals
 * (`listMemoryInbox`: owner from the session, memory-off and erased proposals
 * already absent server-side).
 * Choosing a row hands the request id to the conversation's prompt
 * (`requestReview`) and navigates there; the shared `HitlDialog` opens once
 * that conversation has loaded. The row shows a count and the conversation
 * title only — memory text is shown in the dialog, as text, and nowhere else.
 * Nothing is decided here.
 */
import { Menu } from '@ark-ui/solid/menu'
import { useNavigate } from '@solidjs/router'
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'
import { listMemoryInbox } from '~/lib/memory/confirm-actions.server'
import type { MemoryInboxEntry } from '~/lib/memory/proposals.server'
import { listBlockingInbox } from '~/lib/hitl/actions.server'
import type { BlockingInboxEntry } from '~/lib/hitl/blocking-view'
import {
  erasedVersion,
  inboxVersion,
  requestBlockingReview,
  requestReview,
} from '~/lib/hitl/review-store'
import { CONVERSATION_PARAM } from '~/lib/share-link'

/** A background re-read: the prompt's own polling is per conversation, so a
 *  proposal raised in one you are not viewing is found here. */
export const INBOX_POLL_MS = 60_000

/** A window focus re-reads at most this often: the prompt's own focus read
 *  already tells the inbox when something CHANGED, so the inbox's is only for
 *  conversations the prompt is not looking at (#589 F3). */
export const INBOX_FOCUS_MIN_GAP_MS = 15_000

export function HitlInbox() {
  const navigate = useNavigate()
  const [entries, setEntries] = createSignal<readonly MemoryInboxEntry[]>([])
  const [waiting, setWaiting] = createSignal<readonly BlockingInboxEntry[]>([])
  const total = () => entries().length + waiting().length
  /** Reads are sequenced: an older response never overwrites a newer state, and
   *  an erase voids every read begun before it (#589 F1/F3). */
  let latest = 0
  let lastRead = 0

  const refresh = async () => {
    const mine = ++latest
    lastRead = Date.now()
    // Each list on its own: one failing read must not hide the other.
    const [memory, blocking] = await Promise.allSettled([listMemoryInbox(), listBlockingInbox()])
    if (mine !== latest) return
    // Unreadable is empty, never a fabricated count.
    setEntries(memory.status === 'fulfilled' ? memory.value : [])
    setWaiting(blocking.status === 'fulfilled' ? blocking.value : [])
  }

  createEffect(on(inboxVersion, () => void refresh()))
  // Erased or switched off: the rows go NOW, then the server is asked again.
  createEffect(
    on(
      erasedVersion,
      () => {
        setEntries([])
        void refresh() // bumps `latest`: any read begun before the erase is void
      },
      { defer: true },
    ),
  )
  onMount(() => {
    const timer = setInterval(() => void refresh(), INBOX_POLL_MS)
    const onFocus = () => {
      if (Date.now() - lastRead >= INBOX_FOCUS_MIN_GAP_MS) void refresh()
    }
    window.addEventListener('focus', onFocus)
    onCleanup(() => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    })
  })

  const review = (e: MemoryInboxEntry) => {
    requestReview({ sessionId: e.sessionId, requestId: e.requestId })
    navigate(`/?${CONVERSATION_PARAM}=${encodeURIComponent(e.sessionId)}`)
  }
  const decide = (e: BlockingInboxEntry) => {
    requestBlockingReview(e.sessionId)
    navigate(`/?${CONVERSATION_PARAM}=${encodeURIComponent(e.sessionId)}`)
  }

  return (
    <Show when={total() > 0}>
      <Menu.Root>
        <Menu.Trigger
          data-testid="hitl-inbox-trigger"
          aria-label={`Waiting on you: ${total()}`}
          title="Waiting on you"
          flex="~"
          items="center"
          justify="center"
          w="10"
          h="10"
          rounded="full"
          bg="cyber-800/20 hover:cyber-700/30"
          border="1 cyber-700/50"
          cursor="pointer"
          style={{ position: 'relative' }}
        >
          <span
            class="i-material-symbols-inbox-outline"
            w="5"
            h="5"
            text="ui-accent"
            aria-hidden="true"
          />
          <span
            data-testid="hitl-inbox-count"
            aria-hidden="true"
            bg="ui-accent"
            text="xs ui-bg-primary"
            rounded="full"
            p="x-1"
            style={{
              position: 'absolute',
              top: '-2px',
              right: '-2px',
              'min-width': '1rem',
              'text-align': 'center',
              'line-height': '1rem',
            }}
          >
            {total()}
          </span>
        </Menu.Trigger>
        <Menu.Positioner>
          <Menu.Content
            data-testid="hitl-inbox-menu"
            bg="ui-bg-secondary"
            border="1 ui-border-primary"
            rounded="lg"
            shadow="lg"
            p="y-1"
            z="50"
            style={{ 'min-width': '16rem' }}
          >
            <For each={waiting()}>
              {(e) => (
                <Menu.Item
                  value={`blocking:${e.sessionId}`}
                  onClick={() => decide(e)}
                  data-testid="hitl-inbox-blocking-item"
                  flex="~ col"
                  p="x-3 y-2"
                  cursor="pointer"
                  bg="hover:ui-bg-hover"
                >
                  <span text="sm ui-text-primary">Decision needed</span>
                  <span text="xs ui-text-secondary">{e.title ?? 'Untitled conversation'}</span>
                </Menu.Item>
              )}
            </For>
            <For each={entries()}>
              {(e) => (
                <Menu.Item
                  value={e.requestId}
                  onClick={() => review(e)}
                  data-testid="hitl-inbox-item"
                  flex="~ col"
                  p="x-3 y-2"
                  cursor="pointer"
                  bg="hover:ui-bg-hover"
                >
                  <span text="sm ui-text-primary">
                    Save to memory? {e.itemCount} {e.itemCount === 1 ? 'item' : 'items'}
                  </span>
                  <span text="xs ui-text-secondary">{e.title ?? 'Untitled conversation'}</span>
                </Menu.Item>
              )}
            </For>
          </Menu.Content>
        </Menu.Positioner>
      </Menu.Root>
    </Show>
  )
}
