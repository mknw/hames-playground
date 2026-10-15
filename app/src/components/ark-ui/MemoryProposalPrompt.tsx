/**
 * "Save to memory?" — the confirmation of a prepared memory (#419 M6).
 *
 * After a reply, the store step may have PREPARED memories from what the person
 * said and proposed them (core: a non-blocking `memory.confirm` request).
 * Nothing is saved until they agree here. The proposal arrives after the stream
 * closed, so it cannot ride it: this component asks the server (`listMemoryProposals`)
 * when a turn settles — with a short backoff, because the store step runs after
 * the reply — and again when the window regains focus or the conversation
 * changes. No push channel.
 *
 * (The card sits at the end of the transcript, not under the message that produced
 * the proposal as spec §7.2 draws it: the payload records the conversation, not
 * a message id — a deliberate deviation under the option-A ruling, #589 F8.)
 * A toast and a quiet card appear (#433 S8); the shared `HitlDialog` opens only on
 * "Review" (the toast, the card or the header inbox), never by itself —
 * an unrequested focus change while someone reads the answer would fail the
 * accessibility checklist and teach people to dismiss it. Escape or the
 * backdrop closes the dialog and DECIDES NOTHING: the notice stays.
 *
 * Every string shown is model-derived from the person's own message, so it is
 * untrusted. It is rendered as a text node and never as markup, and the server
 * has already stripped what a text node cannot defend against (`displayText`).
 * What this component sends back is a choice id and one flag per item.
 */
import { createToaster, Toast, Toaster } from '@ark-ui/solid/toast'
import { createEffect, createSignal, on, onCleanup, onMount, Show, untrack } from 'solid-js'
import { HitlDialog } from './HitlDialog'
import {
  clearReview,
  erasedVersion,
  notifyInboxChanged,
  requestReview,
  reviewTarget,
} from '~/lib/hitl/review-store'
import { answerMemoryProposal, listMemoryProposals } from '~/lib/memory/confirm-actions.server'
import type { MemoryProposalView } from '~/lib/memory/proposals.server'

export interface MemoryProposalPromptProps {
  /** The conversation on screen. Changing it re-reads. */
  sessionId: string
  /** Bumped by the parent each time a turn of this conversation settles. */
  settledTick: number
}

/** When to look again after a turn settles: the store step runs after the reply
 *  and may wait on a box that is starting. Stops at the first proposal. */
export const PROPOSAL_POLL_MS = [2_000, 8_000, 30_000] as const

export function MemoryProposalPrompt(props: MemoryProposalPromptProps) {
  const [proposals, setProposals] = createSignal<readonly MemoryProposalView[]>([])
  const [open, setOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [notice, setNotice] = createSignal<string | null>(null)
  // Keyed by `${requestId}:${ref}`: the refs (`i0`, `i1`) repeat across
  // proposals, and one proposal's unchecked items must not open the next one
  // unchecked (#579 review 6).
  const [unchecked, setUnchecked] = createSignal<ReadonlySet<string>>(new Set())
  const itemKey = (requestId: string, ref: string) => `${requestId}:${ref}`
  /** After a refused or failed save the answer is bound server-side: only that
   *  same answer may be retried (#579 review 2). */
  const [retrying, setRetrying] = createSignal<{ requestId: string; choice: string } | null>(null)
  const bound = (p: MemoryProposalView): string | null =>
    p.recorded?.choice ?? (retrying()?.requestId === p.requestId ? retrying()!.choice : null)

  // The toast says a proposal ARRIVED; it is never raised for one already on
  // screen when the conversation opened (that is the card's job), nor twice for
  // the same request.
  const toaster = createToaster({ placement: 'bottom-end', max: 1, overlap: false })
  let seen = new Set<string>()
  let baselined = false
  /** Bumped on a conversation switch and on an erase: a read that began before
   *  either must not repaint what they cleared (#589 F1/F3). */
  let generation = 0
  /** The ids last shown, joined: the inbox is told only when THIS changes. */
  let shownKey = ''
  /** The last completed read (success or failure) of the conversation on
   *  screen, and the ask revision it STARTED under — what decides a pending
   *  review ask: only a read that began after the ask may drop it (#589 F4/R4). */
  const [readDone, setReadDone] = createSignal<{ sessionId: string | null; rev: number }>({
    sessionId: null,
    rev: 0,
  })
  let askRev = 0
  let ask: { requestId: string; rev: number } | null = null

  let alive = true
  let timers: ReturnType<typeof setTimeout>[] = []
  const clearTimers = () => {
    timers.forEach(clearTimeout)
    timers = []
  }
  onCleanup(() => {
    alive = false
    clearTimers()
  })

  const refresh = async (sessionId: string): Promise<number> => {
    const gen = generation
    const startRev = askRev
    try {
      const found = await listMemoryProposals(sessionId)
      if (alive && sessionId === props.sessionId && gen === generation) {
        const fresh = found.filter((p) => !seen.has(p.requestId))
        found.forEach((p) => seen.add(p.requestId))
        if (baselined && fresh.length > 0) {
          const n = fresh.reduce((sum, p) => sum + p.items.length, 0)
          toaster.create({
            type: 'info',
            title: 'Save to memory?',
            description: `${n} ${n === 1 ? 'item' : 'items'}`,
            duration: 10_000,
            // The same open path as the card and the inbox, for the request this
            // toast announced (#589 F5).
            action: {
              label: 'Review',
              onClick: () => requestReview({ sessionId, requestId: fresh[0].requestId }),
            },
          })
        }
        baselined = true
        setProposals(found)
        const key = found.map((p) => p.requestId).join(',')
        if (key !== shownKey) {
          shownKey = key
          notifyInboxChanged()
        }
        setReadDone({ sessionId, rev: startRev })
      }
      return found.length
    } catch {
      // An unreadable list is no notice, never a fabricated one. A failed read
      // still settles a pending review ask (it is dropped, not kept for later).
      if (alive && sessionId === props.sessionId && gen === generation) {
        setReadDone({ sessionId, rev: startRev })
      }
      return 0
    }
  }

  // A conversation switch re-reads at once; a settled turn re-reads on the backoff.
  createEffect(
    on(
      () => [props.sessionId, props.settledTick] as const,
      ([sessionId, tick]) => {
        clearTimers()
        generation++
        setProposals([])
        seen = new Set()
        baselined = false
        shownKey = ''
        setReadDone({ sessionId: null, rev: 0 })
        ask = null
        // A toast belongs to the conversation that raised it (#589 F5), and a
        // review ask for another conversation is dropped here (#589 F4).
        toaster.dismiss()
        if (reviewTarget() && reviewTarget()!.sessionId !== sessionId) clearReview()
        setOpen(false)
        setNotice(null)
        setUnchecked(new Set<string>())
        setRetrying(null)
        void refresh(sessionId)
        if (tick === 0) return
        PROPOSAL_POLL_MS.forEach((ms) =>
          timers.push(
            setTimeout(() => {
              if (proposals().length === 0) void refresh(sessionId)
            }, ms),
          ),
        )
      },
    ),
  )

  onMount(() => {
    const onFocus = () => void refresh(props.sessionId)
    window.addEventListener('focus', onFocus)
    onCleanup(() => window.removeEventListener('focus', onFocus))
  })

  const current = () => proposals()[0]

  // Memory erased or switched off (#589 F1): every surface holding memory text
  // goes at once, before any round trip, and a read already in flight is void.
  createEffect(
    on(
      erasedVersion,
      () => {
        generation++
        setProposals([])
        seen = new Set()
        shownKey = ''
        setOpen(false)
        setNotice(null)
        setRetrying(null)
        setUnchecked(new Set<string>())
        toaster.dismiss()
        clearReview()
        void refresh(props.sessionId)
      },
      { defer: true },
    ),
  )

  // The header inbox and the toast ask for a request by id. It opens once it is
  // in THIS conversation's list. The ask is decided by a read that began AFTER
  // it (or, on arriving in a conversation, its first read): found → open; not
  // found (answered meanwhile, erased, read failed) → dropped, so a later
  // arrival can never open a modal nobody asked for (#589 F4). An ask for the
  // conversation already on screen makes that read happen: its list may predate
  // the proposal (#589 R4). An ask for ANOTHER conversation is left alone until
  // the navigation lands (#589 R3).
  createEffect(() => {
    const t = reviewTarget()
    if (!t) {
      ask = null
      return
    }
    if (t.sessionId !== props.sessionId) return
    if (!ask || ask.requestId !== t.requestId) {
      if (untrack(readDone).sessionId === props.sessionId) {
        ask = { requestId: t.requestId, rev: ++askRev }
        untrack(() => void refresh(props.sessionId))
      } else {
        ask = { requestId: t.requestId, rev: askRev }
      }
    }
    const done = readDone()
    if (done.sessionId !== props.sessionId || done.rev < ask.rev) return
    const at = proposals().findIndex((p) => p.requestId === t.requestId)
    clearReview()
    if (at < 0) return
    if (at > 0) setProposals([proposals()[at], ...proposals().filter((_, i) => i !== at)])
    setNotice(null)
    setOpen(true)
  })
  const itemCount = () => proposals().reduce((n, p) => n + p.items.length, 0)
  const isChecked = (p: MemoryProposalView, ref: string): boolean =>
    p.recorded ? p.recorded.flags[ref] !== false : !unchecked().has(itemKey(p.requestId, ref))
  const selected = (p: MemoryProposalView) => p.items.filter((i) => isChecked(p, i.ref))

  const toggle = (requestId: string, ref: string, checked: boolean) => {
    const next = new Set(unchecked())
    if (checked) next.delete(itemKey(requestId, ref))
    else next.add(itemKey(requestId, ref))
    setUnchecked(next)
  }

  const answer = async (choice: 'save' | 'discard') => {
    const p = current()
    if (!p || busy()) return
    setBusy(true)
    setNotice(null)
    try {
      const result =
        choice === 'discard'
          ? await answerMemoryProposal(props.sessionId, p.requestId, 'discard')
          : await answerMemoryProposal(props.sessionId, p.requestId, {
              choice: 'save',
              flags: Object.fromEntries(p.items.map((i) => [i.ref, isChecked(p, i.ref)])),
            })
      switch (result.outcome) {
        case 'saved':
          setNotice(
            result.stale > 0
              ? `Saved ${result.written}. ${result.stale} changed since it was suggested and was not saved.`
              : `Saved ${result.written}.`,
          )
          break
        case 'discarded':
          setNotice('Nothing was saved.')
          break
        case 'memory-off':
          setNotice('Memory is turned off, so nothing was saved.')
          return
        case 'conflict':
        case 'failed':
          // The answer may already be bound: lock to it, keep the selection.
          setRetrying({ requestId: p.requestId, choice })
          setNotice('That could not be saved right now. Please try again.')
          return
        case 'already-answered':
          setNotice('That suggestion was already answered, so nothing changed.')
          break
        case 'full':
          setNotice('Your memory is full, so nothing was saved. Forget something and try again.')
          return
        default:
          setNotice('This suggestion is no longer available.')
      }
      setOpen(false)
      setRetrying(null)
      await refresh(props.sessionId)
    } catch {
      setNotice('That could not be saved right now. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Show when={current()}>
        <div
          role="status"
          data-testid="memory-proposal-notice"
          flex="~"
          items="center"
          gap="2"
          p="x-4 y-2"
          border="t ui-border-primary"
          bg="ui-bg-tertiary"
          text="xs ui-text-secondary"
        >
          <span
            class="i-material-symbols-bookmark-add-outline"
            w="4"
            h="4"
            text="ui-accent"
            aria-hidden="true"
          />
          <span>
            Save to memory? {itemCount()} {itemCount() === 1 ? 'item' : 'items'}
          </span>
          <button
            type="button"
            data-testid="memory-proposal-review"
            onClick={() => {
              setNotice(null)
              setOpen(true)
            }}
            p="x-2 y-0.5"
            text="xs ui-text-primary"
            bg="transparent hover:ui-bg-hover"
            border="1 ui-accent/50"
            rounded="md"
            cursor="pointer"
          >
            Review
          </button>
        </div>
      </Show>
      <Show when={!current() && notice()}>
        <p
          role="status"
          data-testid="memory-proposal-result"
          p="x-4 y-2"
          border="t ui-border-primary"
          text="xs ui-text-secondary"
        >
          {notice()}
        </p>
      </Show>

      <Toaster toaster={toaster}>
        {(toast) => (
          <Toast.Root
            data-testid="memory-proposal-toast"
            bg="ui-bg-secondary"
            border="1 ui-border-primary"
            rounded="lg"
            shadow="lg"
            p="3"
            flex="~"
            items="center"
            gap="3"
            style={{ 'min-width': '16rem' }}
          >
            <span
              class="i-material-symbols-bookmark-add-outline"
              w="5"
              h="5"
              text="ui-accent"
              aria-hidden="true"
            />
            <div flex="~ col" style={{ flex: 1 }}>
              <Toast.Title text="sm ui-text-primary" font="medium">
                {toast().title}
              </Toast.Title>
              <Toast.Description text="xs ui-text-secondary">
                {toast().description}
              </Toast.Description>
            </div>
            <Show when={toast().action}>
              {(action) => (
                <Toast.ActionTrigger
                  p="x-2 y-0.5"
                  text="xs ui-text-primary"
                  bg="transparent hover:ui-bg-hover"
                  border="1 ui-accent/50"
                  rounded="md"
                  cursor="pointer"
                >
                  {action().label}
                </Toast.ActionTrigger>
              )}
            </Show>
            <Toast.CloseTrigger
              aria-label="Dismiss"
              flex="~"
              items="center"
              justify="center"
              w="6"
              h="6"
              rounded="md"
              bg="transparent hover:ui-bg-hover"
              cursor="pointer"
            >
              <span
                class="i-material-symbols-close"
                w="4"
                h="4"
                text="ui-text-secondary"
                aria-hidden="true"
              />
            </Toast.CloseTrigger>
          </Toast.Root>
        )}
      </Toaster>
      <HitlDialog
        open={open()}
        onClose={() => setOpen(false)}
        proposal={current()}
        busy={busy()}
        notice={notice()}
        isChecked={isChecked}
        bound={bound}
        selectedCount={current() ? selected(current()!).length : 0}
        onToggle={toggle}
        onAnswer={(choice) => void answer(choice)}
      />
    </>
  )
}
