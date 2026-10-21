import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  ensurePrivateTierAwake,
  resetSmallWake,
  resetLargeWake,
} from '../../../lib/inference/wake.server'
import { wakeFailureReason } from '../../../lib/eval-support/wake-failure'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

const SMALL = 'https://example.invalid/small/health'
const bodyOf = (text: string, status: number) => new Response(text, { status })

beforeEach(() => {
  resetSmallWake()
  resetLargeWake()
  vi.stubEnv('SMALL_LLM_BASE_URL', 'https://example.invalid/small/v1')
  vi.stubEnv('SMALL_LLM_API_KEY', 'synthetic-key')
  vi.stubEnv('LARGE_LLM_BASE_URL', 'https://example.invalid/large/v1')
  vi.stubEnv('LARGE_LLM_API_KEY', 'synthetic-large-key')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  resetSmallWake()
  resetLargeWake()
})

const stalled = (init: RequestInit) =>
  new Promise<Response>((_res, reject) =>
    init.signal!.addEventListener(
      'abort',
      () => reject(new DOMException('Aborted', 'AbortError')),
      {
        once: true,
      },
    ),
  )

async function reasonWhen(
  respond: (url: string, init: RequestInit) => Promise<Response>,
  env: Record<string, string> = {},
) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => respond(url, init)),
  )
  const err = await ensurePrivateTierAwake().then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err).toBeDefined()
  return wakeFailureReason(err)
}

it('names the small box when its refusal ends the wake', async () => {
  expect(
    await reasonWhen(async (url, init) => (url === SMALL ? bodyOf('bad key', 401) : stalled(init))),
  ).toBe('SMALL_LLM_WAKE_FAILED')
})

it('names the 27B when its refusal body mentions the small box', async () => {
  expect(
    await reasonWhen(async (url, init) =>
      url === SMALL ? stalled(init) : bodyOf('upstream: small model box unreachable', 401),
    ),
  ).toBe('LARGE_LLM_WAKE_FAILED')
})

it('names the small box when its poll budget runs out', async () => {
  expect(
    await reasonWhen(async (url) => (url === SMALL ? bodyOf('starting', 503) : bodyOf('{}', 200)), {
      SMALL_LLM_WAKE_TIMEOUT_MS: '20',
      SMALL_LLM_WAKE_POLL_INTERVAL_MS: '5',
    }),
  ).toBe('SMALL_LLM_WAKE_FAILED')
})

it('does not guess a box for an error that is not a wake failure', () => {
  expect(wakeFailureReason(new Error('the 27B small model box'))).toBe('PRIVATE_TIER_WAKE_FAILED')
  expect(wakeFailureReason('the 27B')).toBe('PRIVATE_TIER_WAKE_FAILED')
})
