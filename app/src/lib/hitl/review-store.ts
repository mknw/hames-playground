/**
 * Client-side hand-off between the header inbox and the conversation's prompt
 * (#433 S8). The inbox lives in the app header and the dialog in the chat, so
 * "open this request" has to cross components — and, when the request belongs
 * to another conversation, a navigation. A module signal is enough: it carries
 * two ids, never memory text, and is only written from click handlers.
 */
import { createSignal } from 'solid-js'

export interface ReviewTarget {
  readonly sessionId: string
  readonly requestId: string
}

const [reviewTarget, setReviewTarget] = createSignal<ReviewTarget | null>(null)
const [inboxVersion, setInboxVersion] = createSignal(0)

export { reviewTarget }

/** Ask the conversation's prompt to open the dialog on this request. */
export const requestReview = (target: ReviewTarget): void => {
  setReviewTarget(target)
}
export const clearReview = (): void => {
  setReviewTarget(null)
}

/** Bumped whenever the prompt changes what is pending (an answer, a poll that
 *  found something), so the inbox re-reads instead of waiting for its timer. */
export { inboxVersion }
export const notifyInboxChanged = (): void => {
  setInboxVersion((v) => v + 1)
}

const [erasedVersion, setErasedVersion] = createSignal(0)

/** Bumped when the person erased memory or switched it off (#589 F1). Separate
 *  from `inboxVersion` on purpose: the prompt bumps that on every read, so a
 *  prompt subscribed to it would loop. Everything holding memory text on screen
 *  (card, dialog, toast, inbox rows, a pending review ask) drops it here. */
export { erasedVersion }
export const notifyMemoryErased = (): void => {
  setErasedVersion((v) => v + 1)
}
