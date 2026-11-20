/**
 * Each box's own `/status`, read ONCE per container (#1057 review round 2).
 *
 * Every request to a box goes through Modal's proxy and resets its scaledown
 * window, so a read repeated on a panel's poll holds an up box awake for as long
 * as the page is open, and a read that lands just after a scale-to-zero starts a
 * fresh container. `restored`/`gpu` are properties of the container, so the
 * read is made once per container id and remembered — a failure included.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

import {
  readBoxStatus,
  resetBoxStatusCacheForTests,
} from '../../../lib/inference/box-status.server'

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubEnv('LARGE_LLM_BASE_URL', 'https://example.invalid/large/v1')
  vi.stubEnv('LARGE_LLM_API_KEY', 'large-key')
  vi.stubEnv('SMALL_LLM_BASE_URL', 'https://example.invalid/small/v1')
  vi.stubEnv('SMALL_LLM_API_KEY', 'small-key')
  resetBoxStatusCacheForTests()
  fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ restored: true, gpu: 'NVIDIA A10G' })),
  )
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  resetBoxStatusCacheForTests()
})

describe('readBoxStatus', () => {
  it('reads the box’s status file with the box’s own key, and reduces it', async () => {
    expect(await readBoxStatus('small', 'ct-1')).toMatchObject({
      restored: true,
      gpu: 'NVIDIA A10G',
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://example.invalid/small/status')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer small-key')
  })

  it('never asks twice for one container id — ten minutes of polling is one request', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-20T12:00:00Z'))
    for (let t = 0; t < 600; t += 3) {
      vi.setSystemTime(Date.now() + 3_000)
      await readBoxStatus('large', 'ct-1')
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight read between concurrent callers', async () => {
    const answers = await Promise.all([
      readBoxStatus('large', 'ct-1'),
      readBoxStatus('large', 'ct-1'),
      readBoxStatus('large', 'ct-1'),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(new Set(answers).size).toBe(1)
  })

  it('remembers a FAILED read for that container too — a 503 is not retried on a poll', async () => {
    fetchMock.mockImplementation(async () => new Response('starting', { status: 503 }))
    expect(await readBoxStatus('large', 'ct-1')).toBeNull()
    expect(await readBoxStatus('large', 'ct-1')).toBeNull()
    expect(await readBoxStatus('large', 'ct-1')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a NEW container id is a new read — once — and the boxes are independent', async () => {
    await readBoxStatus('large', 'ct-1')
    await readBoxStatus('large', 'ct-2')
    await readBoxStatus('large', 'ct-2')
    await readBoxStatus('small', 'ct-9')
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toEqual([
      'https://example.invalid/large/status',
      'https://example.invalid/large/status',
      'https://example.invalid/small/status',
    ])
  })

  it('never throws: an unreachable box and an unconfigured one are both null', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'))
    expect(await readBoxStatus('large', 'ct-1')).toBeNull()
    vi.stubEnv('SMALL_LLM_BASE_URL', '')
    expect(await readBoxStatus('small', 'ct-1')).toBeNull()
  })
})
