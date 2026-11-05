/**
 * Session-scoped link acceptance (#901 slice 3).
 *
 * The store behind "Accept as safe": the browser-session record that a
 * message's ONE exact resolved link was explicitly accepted
 * (`docs/plan/link-verification.md`, owner ruling Q2 of 2026-11-03).
 *
 * ## What a key is
 *
 * One acceptance is (message id, exact resolved destination). Nothing else:
 *
 *  - the destination is `data-link-dest` — the canonical, page-resolved form
 *    slice 1 stamps — NOT the raw spelling (`data-link-raw` is the *defang*
 *    identity, ruling Q5, and a different concern) and NOT the hostname: two
 *    addresses on one host are two links, and accepting one must never accept
 *    the other.
 *  - the message id scopes the same destination in another message: replayed
 *    transcripts reuse ids across sessions (`replay-N`, one counter per
 *    conversation), so the store is created PER SESSION by the live mount
 *    (`ChatInterface`, one per `sessionId`) rather than shared globally. The
 *    shared transcript (`s/[token].tsx`) and tests fall back to one store per
 *    `ChatMessages` instance — a page load, which is the same lifetime.
 *
 * ## What it is not
 *
 * Nothing here reaches a server, nothing crosses reloads, nothing is shared
 * between viewers. The store is client-side signal state; a new page starts
 * empty, fail-closed — every unrecognised link reviews again, exactly as the
 * rulings require.
 *
 * ## The persisted mark (ruling Q5 as overridden — issue #901 comment
 * ## 6618793027, 2026-11-04)
 *
 * The dialog's "Cancel and mark unsafe" records a MARK — the fact that this
 * address was marked unsafe — that is PERSISTED, not rendering-only ("No
 * session state beyond the persisted mark"): the chosen message's re-render
 * re-derives the inert text from the mark, so the link does not come back
 * with the next rendering. The mark is keyed like acceptance — one mark is
 * (message id, exact raw spelling), where the raw spelling is the defang
 * identity (`data-link-raw`), not the resolved destination — and it rides
 * this same session-scoped store, so its lifetime is the acceptance store's:
 * client-side, per session, a reload starts empty. A server-side record is
 * NOT authorised by the comment; no session state beyond the mark is stored.
 *
 * ## How acceptance disables the intercept (not the stamp)
 *
 * The store never touches rendered HTML. Slice 1's stamps stay on the anchor
 * (`data-link-review="unverified"` et al) through every re-render, so the
 * sanitizer's string and the stamps are never rewritten; the click intercept
 * (`ChatMessages`) consults `isAccepted` per activation and lets an accepted
 * anchor navigate exactly as a recognised one does. The store is the layer
 * that decides; the DOM records nothing.
 */
import { createSignal } from 'solid-js'

/** The session-scoped link decisions (#901 slice 3): the "Accept as safe"
 *  record (ruling Q2) and the persisted "Cancel and mark unsafe" mark (ruling
 *  Q5 as overridden — issue #901 comment 6618793027). */
export interface LinkAcceptanceStore {
  /** Whether the exact resolved destination `dest` is accepted in message
   *  `messageId`. Reactive when read inside a tracking scope. */
  isAccepted: (messageId: string, dest: string) => boolean
  /** Accept the exact resolved destination `dest` in message `messageId` —
   *  one link in one message, never another. */
  accept: (messageId: string, dest: string) => void
  /** Whether the raw spelling `raw` (the defang identity, `data-link-raw`)
   *  was marked unsafe in message `messageId` — the persisted mark the
   *  re-render re-derives the inert text from. */
  isMarkedUnsafe: (messageId: string, raw: string) => boolean
  /** Mark the raw spelling `raw` unsafe in message `messageId`: the chosen
   *  link in the chosen message stays inert through re-renders. */
  markUnsafe: (messageId: string, raw: string) => void
}

/** One store per session (or per page load): message id → accepted dests,
 *  message id → marked-unsafe raw spellings. */
export function createLinkAcceptanceStore(): LinkAcceptanceStore {
  const [accepted, setAccepted] = createSignal<ReadonlyMap<string, ReadonlySet<string>>>(new Map())
  const [markedUnsafe, setMarkedUnsafe] = createSignal<ReadonlyMap<string, ReadonlySet<string>>>(
    new Map(),
  )
  return {
    // Read and written outside JSX on purpose: `isAccepted` runs inside the
    // strip's tracked expressions (and fresh in event handlers), and `accept`
    // runs from the menu item's selection — the two scopes the rule names.
    isAccepted: (messageId, dest) => accepted().get(messageId)?.has(dest) ?? false,
    accept: (messageId, dest) =>
      setAccepted((prev) => {
        const next = new Map(prev)
        const forMessage = new Set(next.get(messageId) ?? [])
        forMessage.add(dest)
        next.set(messageId, forMessage)
        return next
      }),
    isMarkedUnsafe: (messageId, raw) => markedUnsafe().get(messageId)?.has(raw) ?? false,
    markUnsafe: (messageId, raw) =>
      setMarkedUnsafe((prev) => {
        const next = new Map(prev)
        const forMessage = new Set(next.get(messageId) ?? [])
        forMessage.add(raw)
        next.set(messageId, forMessage)
        return next
      }),
  }
}
