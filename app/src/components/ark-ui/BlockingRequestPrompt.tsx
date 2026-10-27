/**
 * A paused run's decisions — the controller of the blocking dialog
 * (decision-loop-agent slice 9).
 *
 * When a turn ends `paused`, the run waits on one or more requests. This reads
 * them from the server (`listBlockingRequests`: owner from the session, the
 * blob deciding what waits, each held payload read by its ref) whenever a turn
 * of the conversation settles, when the conversation changes and when the
 * window regains focus. It shows a quiet card in the transcript and announces
 * the arrival once, politely, without moving focus; the dialog opens only on
 * Review (the card or the header inbox), never by itself.
 *
 * Several requests are answered one after another, then recorded together
 * (`answerHitl`), and only then does the run continue: `onResume` starts the
 * resume stream, which the server binds to the recorded answers. Nothing here
 * decides a resume — the server re-checks every answer against the blob.
 * What this sends is choice ids, and nothing else.
 */
import { createEffect, createSignal, on, onCleanup, onMount, Show } from 'solid-js'
import { HitlDialog, expiryText, type BlockingDialogState } from './HitlDialog'
import { answerHitl, listBlockingRequests } from '~/lib/hitl/actions.server'
import type { BlockingRequestView } from '~/lib/hitl/blocking-view'
import {
  blockingReviewTarget,
  clearBlockingReview,
  notifyInboxChanged,
} from '~/lib/hitl/review-store'

export interface BlockingRequestPromptProps {
  /** The conversation on screen. Changing it re-reads. */
  sessionId: string
  /** Bumped by the parent each time a turn of this conversation settles. */
  settledTick: number
  /** A turn of this conversation is streaming: nothing is offered meanwhile. */
  busy: boolean
  /** Continue the paused run: the answers are recorded by then. */
  onResume: () => void
}

export function BlockingRequestPrompt(props: BlockingRequestPromptProps) {
  const [views, setViews] = createSignal<readonly BlockingRequestView[]>([])
  const [read, setRead] = createSignal<'idle' | 'loading' | 'failed'>('idle')
  const [open, setOpen] = createSignal(false)
  const [index, setIndex] = createSignal(0)
  const [submitting, setSubmitting] = createSignal(false)
  const [notice, setNotice] = createSignal<string | null>(null)
  const [closedAs, setClosedAs] = createSignal<'expired' | 'superseded' | null>(null)
  const [announced, setAnnounced] = createSignal('')
  /** The person's choices so far, by request id; sent together after the last. */
  let answers: Record<string, string> = {}
  /** Bumped on a conversation switch: a read begun before it must not paint. */
  let generation = 0

  const refresh = async (sessionId: string) => {
    const gen = generation
    setRead('loading')
    try {
      const found = await listBlockingRequests(sessionId)
      if (gen !== generation || sessionId !== props.sessionId) return
      setViews(found)
      setRead('idle')
      notifyInboxChanged()
      const key = found.map((v) => v.requestId).join(',')
      if (found.length > 0 && key !== announced()) {
        setAnnounced(key)
      }
    } catch {
      if (gen === generation) setRead('failed')
    }
  }

  createEffect(
    on(
      () => [props.sessionId, props.settledTick] as const,
      ([sessionId], previous) => {
        if (!previous || previous[0] !== sessionId) {
          generation++
          setViews([])
          setOpen(false)
          setAnnounced('')
          answers = {}
        }
        void refresh(sessionId)
      },
    ),
  )

  onMount(() => {
    const onFocus = () => {
      if (!open() && !props.busy) void refresh(props.sessionId)
    }
    window.addEventListener('focus', onFocus)
    onCleanup(() => window.removeEventListener('focus', onFocus))
  })

  // The header inbox asks for this conversation's dialog.
  createEffect(() => {
    if (blockingReviewTarget() !== props.sessionId) return
    clearBlockingReview()
    review()
  })

  /** Requests still to be answered by this person: not recorded already. */
  const unanswered = () => views().filter((v) => v.recorded === null)
  const current = () => unanswered()[index()]

  const review = () => {
    answers = {}
    setIndex(0)
    setNotice(null)
    setClosedAs(null)
    setOpen(true)
  }

  const dialogState = (): BlockingDialogState => {
    if (closedAs()) return closedAs()!
    if (read() === 'failed') return 'failed'
    const r = current()
    if (!r) return read() === 'loading' ? 'loading' : 'superseded'
    if (r.expiresAt !== null && Date.now() >= r.expiresAt) return 'expired'
    return 'ready'
  }

  const choose = async (optionId: string) => {
    const r = current()
    if (!r || submitting()) return
    answers[r.requestId] = optionId
    if (index() + 1 < unanswered().length) {
      setIndex(index() + 1)
      return
    }
    setSubmitting(true)
    setNotice(null)
    try {
      const outcomes = await answerHitl(props.sessionId, answers)
      if (outcomes.every((o) => o.outcome === 'answered' || o.outcome === 'already-answered')) {
        setOpen(false)
        setViews([])
        notifyInboxChanged()
        props.onResume()
        return
      }
      if (outcomes.some((o) => o.outcome === 'expired')) setClosedAs('expired')
      else if (outcomes.some((o) => o.outcome === 'unknown-request')) setClosedAs('superseded')
      else setNotice('That answer could not be recorded. Nothing was decided.')
      void refresh(props.sessionId)
    } catch {
      setNotice('That answer could not be recorded. Nothing was decided.')
    } finally {
      setSubmitting(false)
    }
  }

  const earliest = () => {
    const deadlines = views()
      .map((v) => v.expiresAt)
      .filter((t): t is number => t !== null)
    return deadlines.length > 0 ? Math.min(...deadlines) : null
  }
  const count = () => views().length
  const allRecorded = () => count() > 0 && unanswered().length === 0

  return (
    <>
      {/* One polite announcement per new set of requests; focus stays put. */}
      <div sr-only aria-live="polite" data-testid="hitl-blocking-live">
        {announced() && count() > 0
          ? `Approval needed: ${count() === 1 ? 'one decision' : `${count()} decisions`}`
          : ''}
      </div>
      <Show when={!props.busy && (count() > 0 || read() === 'failed')}>
        <div
          data-testid="hitl-blocking-card"
          role="region"
          aria-label="Waiting for your decision"
          m="x-4 b-2"
          p="3"
          flex="~"
          items="center"
          justify="between"
          gap="3"
          border="1 ui-border-primary"
          rounded="md"
          bg="ui-bg-tertiary"
        >
          <div flex="~" items="center" gap="2" style={{ 'min-width': 0 }}>
            <span
              class="i-material-symbols-pending-actions"
              w="5"
              h="5"
              text="ui-accent"
              aria-hidden="true"
              style={{ 'flex-shrink': 0 }}
            />
            <span text="sm ui-text-primary">
              <Show when={read() !== 'failed'} fallback="The waiting decisions could not be read.">
                <Show
                  when={!allRecorded()}
                  fallback="Your answer is recorded. Continue when you are ready."
                >
                  {count() === 1 ? 'One decision needed' : `${count()} decisions needed`}
                </Show>
              </Show>
            </span>
            <Show when={expiryText(earliest())}>
              {(text) => <span text="xs ui-text-secondary">{text()}</span>}
            </Show>
          </div>
          <Show
            when={read() !== 'failed'}
            fallback={
              <button
                type="button"
                data-testid="hitl-blocking-card-retry"
                onClick={() => void refresh(props.sessionId)}
                p="x-3 y-1.5"
                text="xs ui-text-secondary"
                bg="transparent hover:ui-bg-hover"
                border="1 ui-border-secondary"
                rounded="md"
                ring="2 transparent focus:ui-accent/40"
              >
                Retry
              </button>
            }
          >
            <Show
              when={!allRecorded()}
              fallback={
                <button
                  type="button"
                  data-testid="hitl-blocking-continue"
                  cyber-button=""
                  onClick={() => props.onResume()}
                  p="x-3 y-1.5"
                  text="xs"
                  ring="2 transparent focus:ui-accent/40"
                >
                  Continue
                </button>
              }
            >
              <button
                type="button"
                data-testid="hitl-blocking-review"
                cyber-button=""
                onClick={review}
                p="x-3 y-1.5"
                text="xs"
                ring="2 transparent focus:ui-accent/40"
              >
                Review
              </button>
            </Show>
          </Show>
        </div>
      </Show>
      <HitlDialog
        kind="blocking"
        open={open()}
        onClose={() => setOpen(false)}
        request={current()}
        state={dialogState()}
        busy={submitting()}
        notice={notice()}
        position={{ index: index(), count: unanswered().length }}
        onChoose={(id) => void choose(id)}
        onRetry={() => void refresh(props.sessionId)}
      />
    </>
  )
}
