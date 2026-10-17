/**
 * Request admission behind stock Caddy (#432 G20 row 6). Per-process token
 * buckets: 600/minute per verified user (burst 120), 6000/minute globally
 * (burst 1000). No timers, IP/header trust, or response-stream work.
 *
 * Pre-auth traffic has only the generous global backstop. Session cookies are
 * resolved in the existing store; arbitrary cookies never mint user buckets.
 * An unavailable session store returns 503, never an anonymous fallback.
 * State resets on restart and is NOT shared across replicas or app clones.
 */
import type { FetchEvent } from '@solidjs/start/server'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { readCookie, SESSION_COOKIE } from './auth/cookies.server'
import { getSession } from './auth/session-store.server'

assertServerOnImport()

const USER_BURST = 120
const USER_PER_SECOND = 10
const GLOBAL_BURST = 1000
const GLOBAL_PER_SECOND = 100
const MAX_USERS = 256

interface Bucket {
  tokens: number
  updated: number
}

function refill(bucket: Bucket, burst: number, perSecond: number, now: number): void {
  bucket.tokens = Math.min(
    burst,
    bucket.tokens + (Math.max(0, now - bucket.updated) * perSecond) / 1000,
  )
  bucket.updated = Math.max(now, bucket.updated)
}

function take(bucket: Bucket, burst: number, perSecond: number, now: number): number {
  refill(bucket, burst, perSecond, now)
  if (bucket.tokens < 1) return Math.max(1, Math.ceil((1 - bucket.tokens) / perSecond))
  bucket.tokens -= 1
  return 0
}

function refused(seconds: number, status = 429): Response {
  return new Response(status === 429 ? 'Too many requests' : 'Session service unavailable', {
    status,
    headers: {
      'Retry-After': String(seconds),
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  })
}

/** Fresh state for tests; the deployed hook below shares one instance across routers. */
export function createRequestLimiter(now: () => number = () => performance.now()) {
  const global: Bucket = { tokens: GLOBAL_BURST, updated: now() }
  const users = new Map<string, Bucket>()
  return async (event: Pick<FetchEvent, 'request'>): Promise<Response | undefined> => {
    // Before the DB lookup and before any request-body read or route work.
    const retry = take(global, GLOBAL_BURST, GLOBAL_PER_SECOND, now())
    if (retry) return refused(retry)

    const sessionId = readCookie(event.request, SESSION_COOKIE)
    if (!sessionId) return undefined
    let session
    try {
      session = await getSession(sessionId)
    } catch {
      return refused(1, 503)
    }
    if (!session) return undefined

    const time = now()
    let bucket = users.get(session.userId)
    if (!bucket) {
      if (users.size >= MAX_USERS) {
        // Reclaim only fully refilled entries. Evicting an active entry would
        // let key churn restore its burst. Refuse new keys if none are idle.
        for (const [id, entry] of users) {
          refill(entry, USER_BURST, USER_PER_SECOND, time)
          if (entry.tokens === USER_BURST) users.delete(id)
        }
        if (users.size >= MAX_USERS) return refused(60)
      }
      bucket = { tokens: USER_BURST, updated: time }
      users.set(session.userId, bucket)
    }
    const userRetry = take(bucket, USER_BURST, USER_PER_SECOND, time)
    return userRetry ? refused(userRetry) : undefined
  }
}

// SolidStart builds middleware into both routers; module-local state would
// silently grant separate allowances. The symbol owns one limiter per process.
const KEY = Symbol.for('hames.request-rate-limit')
const shared = globalThis as typeof globalThis & {
  [KEY]?: ReturnType<typeof createRequestLimiter>
}
export const enforceRequestRateLimit = (shared[KEY] ??= createRequestLimiter())
