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
 * A quiet notice appears; the dialog opens only on "Review", never by itself —
 * an unrequested focus change while someone reads the answer would fail the
 * accessibility checklist and teach people to dismiss it. Escape or the
 * backdrop closes the dialog and DECIDES NOTHING: the notice stays.
 *
 * Every string shown is model-derived from the person's own message, so it is
 * untrusted. It is rendered as a text node and never as markup, and the server
 * has already stripped what a text node cannot defend against (`displayText`).
 * What this component sends back is a choice id and one flag per item.
 */
import { Checkbox } from '@ark-ui/solid/checkbox'
import { Dialog } from '@ark-ui/solid/dialog'
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'
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

const EFFECT_COPY = {
  new: 'New memory',
  reinforces: 'Already remembered',
  updates: 'Replaces an older memory',
} as const

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
    try {
      const found = await listMemoryProposals(sessionId)
      if (alive && sessionId === props.sessionId) setProposals(found)
      return found.length
    } catch {
      // An unreadable list is no notice, never a fabricated one.
      return 0
    }
  }

  // A conversation switch re-reads at once; a settled turn re-reads on the backoff.
  createEffect(
    on(
      () => [props.sessionId, props.settledTick] as const,
      ([sessionId, tick]) => {
        clearTimers()
        setProposals([])
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

      {/* `lazyMount unmountOnExit`, positioned inline: see ShareConversationButton. */}
      <Dialog.Root
        open={open()}
        onOpenChange={(d) => {
          // Closing decides nothing: the notice stays until a choice is made.
          if (!d.open && !busy()) setOpen(false)
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
            data-testid="memory-proposal-dialog"
            bg="ui-bg-secondary"
            border="1 ui-border-primary"
            rounded="lg"
            shadow="2xl"
            p="5"
            m="4"
            style={{ 'max-width': '34rem', width: '100%', 'max-height': '90vh', overflow: 'auto' }}
          >
            <Dialog.Title text="sm ui-text-primary" font="medium">
              Save to memory?
            </Dialog.Title>
            <Dialog.Description
              text="xs ui-text-secondary"
              m="t-2"
              style={{ 'line-height': '1.5' }}
            >
              These were taken from what you said. Nothing is saved until you choose.
            </Dialog.Description>

            <Show when={current()}>
              {(p) => (
                <ul m="t-4" p="0" flex="~ col" gap="3" style={{ 'list-style': 'none' }}>
                  <For each={p().items}>
                    {(item) => (
                      <li border="1 ui-border-secondary" rounded="md" p="3" bg="ui-bg-tertiary">
                        <Checkbox.Root
                          checked={isChecked(p(), item.ref)}
                          disabled={bound(p()) !== null}
                          onCheckedChange={(d) =>
                            toggle(p().requestId, item.ref, d.checked === true)
                          }
                          data-testid={`memory-proposal-item-${item.ref}`}
                          flex="~"
                          gap="2"
                          items="start"
                        >
                          <Checkbox.Control
                            w="4"
                            h="4"
                            m="t-0.5"
                            flex="~"
                            items="center"
                            justify="center"
                            border="1 ui-border-primary"
                            rounded="sm"
                            style={{ 'flex-shrink': 0 }}
                          >
                            <Checkbox.Indicator>
                              <span
                                class="i-material-symbols-check-small"
                                w="4"
                                h="4"
                                text="ui-accent"
                                aria-hidden="true"
                              />
                            </Checkbox.Indicator>
                          </Checkbox.Control>
                          <div flex="~ col" gap="1" style={{ 'min-width': 0 }}>
                            <Checkbox.Label text="sm ui-text-primary">
                              <span
                                text="xs ui-text-primary"
                                border="1 ui-accent/50"
                                p="x-1.5 y-0.5"
                                rounded="sm"
                                font="mono"
                                m="r-2"
                              >
                                {item.kind}
                              </span>
                              {item.content}
                            </Checkbox.Label>
                            <span text="xs ui-text-secondary">
                              from your message: “{item.evidence}”
                            </span>
                            <span text="xs ui-text-secondary">
                              {EFFECT_COPY[item.effect]}
                              <Show when={item.previous}>{(prev) => <>: “{prev()}”</>}</Show>
                            </span>
                          </div>
                          <Checkbox.HiddenInput />
                        </Checkbox.Root>
                      </li>
                    )}
                  </For>
                </ul>
              )}
            </Show>

            <Show when={notice()}>
              <p text="xs ui-danger" m="t-3" role="alert">
                {notice()}
              </p>
            </Show>

            <div flex="~" gap="2" justify="end" m="t-4">
              <button
                type="button"
                data-testid="memory-proposal-discard"
                onClick={() => void answer('discard')}
                disabled={busy() || (!!current() && ['save'].includes(bound(current()!) ?? ''))}
                p="x-3 y-1.5"
                text="xs ui-text-secondary"
                bg="transparent hover:ui-bg-hover"
                border="1 ui-border-secondary"
                rounded="md"
                cursor="pointer"
              >
                Don't save
              </button>
              <button
                type="button"
                data-testid="memory-proposal-save"
                cyber-button=""
                onClick={() => void answer('save')}
                disabled={
                  busy() ||
                  !current() ||
                  bound(current()!) === 'discard' ||
                  selected(current()!).length === 0
                }
                p="x-3 y-1.5"
                text="xs"
              >
                Save selected
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Positioner>
      </Dialog.Root>
    </>
  )
}
