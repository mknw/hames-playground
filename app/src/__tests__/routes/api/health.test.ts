/**
 * GET /api/health — the container healthcheck's target (#197).
 *
 * The compose healthcheck reads the status code, so the assertions are about
 * the contract the probe depends on: 200, JSON, and no auth in the way.
 */

import { describe, it, expect } from 'vitest'

import { GET } from '../../../routes/api/health'

describe('GET /api/health', () => {
  it('answers 200 with a JSON liveness payload', async () => {
    const res = GET()

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    const body = (await res.json()) as { status: string; uptimeSeconds: number }
    expect(body.status).toBe('ok')
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0)
  })
})
