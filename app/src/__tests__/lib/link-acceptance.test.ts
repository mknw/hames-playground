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
