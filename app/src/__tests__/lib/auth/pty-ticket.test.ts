/**
 * The sandbox terminal's stream tickets (#429): each property the stream's
 * `GET` relies on — single use, short life, bound to one user and one session —
 * and the one that makes the two-step open work at all: the `POST` and the
 * `GET` reach the same store even when they run from different module copies.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const { mintPtyTicket, redeemPtyTicket, PTY_TICKET_TTL_MS } =
  await import('~/lib/auth/pty-ticket.server')

afterEach(() => {
  vi.useRealTimers()
})

describe('pty tickets', () => {
  it('grant the session they were minted for, to the user who minted them', () => {
    const ticket = mintPtyTicket('user-1', 'sess-1')
    expect(redeemPtyTicket(ticket, 'user-1')).toBe('sess-1')
  })

  it('are unguessable and distinct', () => {
    const a = mintPtyTicket('user-1', 'sess-1')
    const b = mintPtyTicket('user-1', 'sess-1')
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 random bytes, base64url
  })

  it('are single-use: a second presentation gets nothing', () => {
    const ticket = mintPtyTicket('user-1', 'sess-1')
    redeemPtyTicket(ticket, 'user-1')
    expect(redeemPtyTicket(ticket, 'user-1')).toBeNull()
  })

  it('are no use to another user, and are spent by the attempt', () => {
    const ticket = mintPtyTicket('user-1', 'sess-1')
    expect(redeemPtyTicket(ticket, 'user-2')).toBeNull()
    expect(redeemPtyTicket(ticket, 'user-1')).toBeNull()
  })

  it('expire after the TTL', () => {
    vi.useFakeTimers()
    const ticket = mintPtyTicket('user-1', 'sess-1')
    vi.advanceTimersByTime(PTY_TICKET_TTL_MS)
    expect(redeemPtyTicket(ticket, 'user-1')).toBeNull()
  })

  it('still work just inside the TTL', () => {
    vi.useFakeTimers()
    const ticket = mintPtyTicket('user-1', 'sess-1')
    vi.advanceTimersByTime(PTY_TICKET_TTL_MS - 1)
    expect(redeemPtyTicket(ticket, 'user-1')).toBe('sess-1')
  })

  it('refuse a ticket nobody minted', () => {
    expect(redeemPtyTicket('made-up', 'user-1')).toBeNull()
  })

  it('are shared across copies of the module', async () => {
    // SolidStart builds a route's POST and GET from separate `?pick=` copies
    // of the route file; this module is what they share. A store held in
    // module scope would be one per copy, and every GET would be refused.
    const ticket = mintPtyTicket('user-1', 'sess-1')
    vi.resetModules()
    const fresh = await import('~/lib/auth/pty-ticket.server')
    expect(fresh.redeemPtyTicket).not.toBe(redeemPtyTicket)
    expect(fresh.redeemPtyTicket(ticket, 'user-1')).toBe('sess-1')
  })
})
