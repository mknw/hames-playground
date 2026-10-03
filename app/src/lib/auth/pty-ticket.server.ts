/**
 * Single-use tickets for the sandbox terminal's output stream (#429) — Server Only.
 *
 * `EventSource` can only `GET`, and a `GET` must not change state
 * (`csrf.server.ts`). So the terminal opens in two steps: an authenticated,
 * same-origin `POST` claims the session and starts its shell, then hands back
 * a ticket; the stream's `GET` presents it. A ticket is:
 *
 * - **unguessable** — 32 random bytes;
 * - **single-use** — spent by its first presentation, whoever presents it, so
 *   `EventSource`'s automatic reconnect cannot replay it;
 * - **short-lived** — {@link PTY_TICKET_TTL_MS} from the moment it is minted;
 * - **bound** to the user who minted it and the session it names, so a ticket
 *   that leaks (it rides in a URL, and so in an access log) is no use to anyone
 *   else, and no use to its owner either once it has been redeemed.
 *
 * The store is in this process's memory, which is where the shell itself lives
 * (`PtyManager`): a ticket redeemed on another instance would find no shell.
 *
 * It is a separate module, and parked on a `globalThis` symbol, rather than a
 * `Map` in the route file: SolidStart builds each exported method of a route
 * from its own `?pick=` copy of that file, so a `Map` declared there would be
 * one per method, and the `POST` would mint into a store the `GET` never reads.
 */
import { randomBytes } from 'node:crypto'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'

assertServerOnImport()

/** Long enough for the browser to open the stream right after the `POST`. */
export const PTY_TICKET_TTL_MS = 30_000

interface Grant {
  userId: string
  sessionId: string
  expiresAt: number
}

const STORE = Symbol.for('hames.ptyTickets')

function tickets(): Map<string, Grant> {
  const g = globalThis as { [STORE]?: Map<string, Grant> }
  return (g[STORE] ??= new Map())
}

/** Mint a ticket for `userId` to stream `sessionId`'s terminal. */
export function mintPtyTicket(userId: string, sessionId: string): string {
  const store = tickets()
  const now = Date.now()
  // Expired tickets go on every mint, so the map stays as small as the number
  // of terminals opened in the last TTL.
  for (const [ticket, grant] of store) if (grant.expiresAt <= now) store.delete(ticket)
  const ticket = randomBytes(32).toString('base64url')
  store.set(ticket, { userId, sessionId, expiresAt: now + PTY_TICKET_TTL_MS })
  return ticket
}

/**
 * Spend a ticket: the session it grants, or `null` when it is unknown, expired,
 * already spent or minted for someone else.
 */
export function redeemPtyTicket(ticket: string, userId: string): string | null {
  const store = tickets()
  const grant = store.get(ticket)
  store.delete(ticket)
  if (!grant || grant.expiresAt <= Date.now() || grant.userId !== userId) return null
  return grant.sessionId
}
