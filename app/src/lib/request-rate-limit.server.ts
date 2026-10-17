/**
 * Request admission behind stock Caddy (#432 G20 row 6). Verified session and
 * action-token owners share a 600/minute bucket (burst 120). Unresolved requests
 * alone use bounded per-address buckets (same rate/burst), then the anonymous
 * 6000/minute backstop (burst 1000). Refusals by one owner/address cannot drain
 * another's pool. No body reads, timers or response-stream work.
 *
 * Address trust requires Caddy's explicit X-Forwarded-For overwrite and the
 * app's loopback-only ingress. Missing/invalid/list values share one fallback.
 * An unavailable session store returns 503, never an anonymous fallback.
 * State resets on restart and is NOT shared across replicas or app clones.
 */
import { isIP } from 'node:net'
import type { FetchEvent } from '@solidjs/start/server'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { readCookie, SESSION_COOKIE } from './auth/cookies.server'
import { getSession } from './auth/session-store.server'
import { bearerSecret, resolveActionUser } from './auth/action-tokens.server'

assertServerOnImport()

const USER_BURST = 120
const USER_PER_SECOND = 10
const GLOBAL_BURST = 1000
const GLOBAL_PER_SECOND = 100
const MAX_USERS = 256
const MAX_ADDRESSES = 256

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

/** Reclaim only full buckets; evicting active keys would restore their burst. */
function takeKey(buckets: Map<string, Bucket>, key: string, max: number, time: number): number {
  let bucket = buckets.get(key)
  if (!bucket) {
    if (buckets.size >= max) {
      for (const [id, entry] of buckets) {
        refill(entry, USER_BURST, USER_PER_SECOND, time)
        if (entry.tokens === USER_BURST) buckets.delete(id)
      }
      if (buckets.size >= max) return 60
    }
    bucket = { tokens: USER_BURST, updated: time }
    buckets.set(key, bucket)
  }
  return take(bucket, USER_BURST, USER_PER_SECOND, time)
}

/** Fresh state for tests; the deployed hook below shares one instance across routers. */
export function createRequestLimiter(now: () => number = () => performance.now()) {
  const global: Bucket = { tokens: GLOBAL_BURST, updated: now() }
  const users = new Map<string, Bucket>()
  const addresses = new Map<string, Bucket>()
  return async (event: Pick<FetchEvent, 'request'>): Promise<Response | undefined> => {
    // Match the endpoint's credential, including dual-credential requests.
    // Admission resolves identity only; the route still authorizes the request.
    let pathname = new URL(event.request.url).pathname
    try {
      pathname = decodeURIComponent(pathname)
    } catch {
      // A malformed escape cannot name the action route; route handling decides it.
    }
    const action = event.request.method === 'POST' && /^\/api\/agents\/[^/]+\/?$/.test(pathname)
    let userId: string | null = null
    if (action) {
      userId = resolveActionUser(bearerSecret(event.request.headers.get('authorization')))
    } else {
      const sessionId = readCookie(event.request, SESSION_COOKIE)
      if (sessionId) {
        try {
          userId = (await getSession(sessionId))?.userId ?? null
        } catch {
          return refused(1, 503)
        }
      }
    }

    const time = now()
    if (userId) {
      const userRetry = takeKey(users, userId, MAX_USERS, time)
      return userRetry ? refused(userRetry) : undefined
    }

    // Only unresolved traffic shares the anonymous backstop. Check its address
    // first, so refusals from one address cannot spend the shared allowance.
    const forwarded = event.request.headers.get('x-forwarded-for') ?? ''
    const address = isIP(forwarded) ? forwarded : 'unknown'
    const addressRetry = takeKey(addresses, address, MAX_ADDRESSES, time)
    if (addressRetry) return refused(addressRetry)
    const retry = take(global, GLOBAL_BURST, GLOBAL_PER_SECOND, time)
    return retry ? refused(retry) : undefined
  }
}

// SolidStart builds middleware into both routers; module-local state would
// silently grant separate allowances. The symbol owns one limiter per process.
const KEY = Symbol.for('hames.request-rate-limit')
const shared = globalThis as typeof globalThis & {
  [KEY]?: ReturnType<typeof createRequestLimiter>
}
export const enforceRequestRateLimit = (shared[KEY] ??= createRequestLimiter())
