/**
 * link-acceptance — the session-scoped "Accept as safe" store (#901 slice 3).
 *
 * The module is one keying decision — (message id, exact resolved
 * destination) — so the suite is mostly the two ways a wrong key fails:
 * accepting another link (host-keying), and accepting another message
 * (dropping the message id). Both are ruling Q2: "accepting one must not
 * silently accept another".
 *
 * Every address here is a synthetic `.example` host (the repo is public).
 */
import { describe, it, expect } from 'vitest'
import { createRoot, createMemo } from 'solid-js'
import { createLinkAcceptanceStore } from '~/lib/link-acceptance'

const DEST_GUIDE = 'https://external.example/guide'
/** Same host, different path — a host-keyed store accepts it, the real one does not. */
const DEST_OTHER_PAGE = 'https://external.example/other-page'
/** Same path, different host. */
const DEST_OTHER_HOST = 'https://other.example/guide'

describe('link acceptance (#901 slice 3)', () => {
  it('starts empty — nothing is accepted without an explicit acceptance', () => {
    const store = createLinkAcceptanceStore()
    expect(store.isAccepted('m1', DEST_GUIDE)).toBe(false)
  })

  it('accepts one exact resolved link in one message', () => {
    const store = createLinkAcceptanceStore()
    store.accept('m1', DEST_GUIDE)
    expect(store.isAccepted('m1', DEST_GUIDE)).toBe(true)
  })

  // MUTATION: key by hostname (new URL(dest).hostname) instead of the exact
  // destination → the same-host link below reads accepted → red. Ruling Q2:
  // one exact, RESOLVED link — two addresses on one host are two links.
  it('never accepts another destination on the same host', () => {
    const store = createLinkAcceptanceStore()
    store.accept('m1', DEST_GUIDE)
    expect(store.isAccepted('m1', DEST_OTHER_PAGE)).toBe(false)
    expect(store.isAccepted('m1', DEST_OTHER_HOST)).toBe(false)
  })

  // MUTATION: drop the message id from the key (one flat Set of dests) → the
  // same destination in another message reads accepted → red. Replayed
  // transcripts reuse ids across sessions (`replay-N`), which is why the
  // LIVE mount recreates the whole store per session rather than widening
  // the key.
  it('never accepts the same destination in another message', () => {
    const store = createLinkAcceptanceStore()
    store.accept('m1', DEST_GUIDE)
    expect(store.isAccepted('m2', DEST_GUIDE)).toBe(false)
    // An acceptance in another message is its own fact, not this one's.
    store.accept('m2', DEST_OTHER_PAGE)
    expect(store.isAccepted('m2', DEST_OTHER_PAGE)).toBe(true)
    expect(store.isAccepted('m1', DEST_OTHER_PAGE)).toBe(false)
  })

  // How the indicator and the intercept consume the store: a tracked read
  // updates when accept() lands — the strip and the intercept both read it
  // exactly this way.
  it('is reactive: a tracked read changes when a link is accepted', () => {
    createRoot((dispose) => {
      const store = createLinkAcceptanceStore()
      const accepted = createMemo(() => store.isAccepted('m1', DEST_GUIDE))
      // eslint-disable-next-line solid/reactivity -- a test read, not a UI scope
      expect(accepted()).toBe(false)
      store.accept('m1', DEST_GUIDE)
      // eslint-disable-next-line solid/reactivity -- a test read, not a UI scope
      expect(accepted()).toBe(true)
      dispose()
    })
  })
})

// The persisted mark (ruling Q5 as overridden — issue #901 comment
// 6618793027, 2026-11-04): "cancel and mark unsafe" — the mark is PERSISTED,
// not rendering-only, and "no session state beyond the persisted mark". The
// mark rides the same session-scoped store as acceptance, keyed like it but
// on the defang identity (`data-link-raw`, what the defang strips on): the
// component re-derives the inert text from it on every re-render. Still
// client-side and per session — nothing is written anywhere else, and a
// reload (a fresh store) starts empty.
describe('mark unsafe — the persisted mark (comment 6618793027)', () => {
  const RAW_GUIDE = 'https://external.example/guide'
  const RAW_OTHER = 'https://external.example/other'

  it('starts empty — nothing is marked without an explicit mark', () => {
    const store = createLinkAcceptanceStore()
    expect(store.isMarkedUnsafe('m1', RAW_GUIDE)).toBe(false)
  })

  it('records the mark for the chosen raw spelling in one message', () => {
    const store = createLinkAcceptanceStore()
    store.markUnsafe('m1', RAW_GUIDE)
    expect(store.isMarkedUnsafe('m1', RAW_GUIDE)).toBe(true)
  })

  // MUTATION: key the mark by the raw spelling alone (drop the message id) →
  // the same spelling in another message reads marked → red. The defang's
  // own scoping is per message (slice 2): only the chosen message's chosen
  // spelling goes inert on re-render.
  it('never marks the same raw spelling in another message', () => {
    const store = createLinkAcceptanceStore()
    store.markUnsafe('m1', RAW_GUIDE)
    // The mark is THIS message's fact — and only this message's fact.
    expect(store.isMarkedUnsafe('m1', RAW_GUIDE)).toBe(true)
    expect(store.isMarkedUnsafe('m2', RAW_GUIDE)).toBe(false)
  })

  // MUTATION: share one set between marks and acceptances (or key marks on
  // the dest) → an acceptance reads as a mark → red. The two decisions are
  // independent facts (Q2 vs Q5).
  it('keeps the mark independent of acceptance', () => {
    const store = createLinkAcceptanceStore()
    store.accept('m1', RAW_GUIDE)
    expect(store.isMarkedUnsafe('m1', RAW_GUIDE)).toBe(false)
    store.markUnsafe('m1', RAW_OTHER)
    expect(store.isAccepted('m1', RAW_OTHER)).toBe(false)
  })

  // Client-side lifetime, like acceptance: a reload creates a fresh store.
  it('a reload starts empty — a fresh store instance carries no mark', () => {
    const store = createLinkAcceptanceStore()
    store.markUnsafe('m1', RAW_GUIDE)
    const reloaded = createLinkAcceptanceStore()
    expect(reloaded.isMarkedUnsafe('m1', RAW_GUIDE)).toBe(false)
  })
})
