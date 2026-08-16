/**
 * SandboxScheduler unit tests.
 *
 * Pure logic, no I/O. Covers immediate-grant, queue-on-cap, per-session
 * isolation, FIFO-with-skip drain order, idempotent release, and counters.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import { SandboxScheduler, type Slot } from '../../../lib/sandbox/scheduler.server'

describe('SandboxScheduler.allocate', () => {
  it('grants immediately when under both caps', async () => {
    const s = new SandboxScheduler({ globalCap: 4, perSessionCap: 2 })
    const slot = await s.allocate('s1')
    expect(slot).toBeDefined()
    expect(s.inflightCount()).toBe(1)
    expect(s.inflightCount('s1')).toBe(1)
  })

  it('waits when global cap is reached, resolves after release', async () => {
    const s = new SandboxScheduler({ globalCap: 1, perSessionCap: 4 })
    const first = await s.allocate('s1')
    let secondResolved = false
    const secondP = s.allocate('s2').then((slot) => {
      secondResolved = true
      return slot
    })
    // Allow microtasks to settle.
    await new Promise((r) => setImmediate(r))
    expect(secondResolved).toBe(false)
    expect(s.queueDepth()).toBe(1)

    first.release()
    const second = await secondP
    expect(secondResolved).toBe(true)
    expect(s.inflightCount()).toBe(1)
    expect(s.queueDepth()).toBe(0)
    second.release()
  })

  it('queues when per-session cap is reached even with global headroom', async () => {
    const s = new SandboxScheduler({ globalCap: 8, perSessionCap: 1 })
    const a = await s.allocate('s1')
    let bResolved = false
    const bP = s.allocate('s1').then((slot) => {
      bResolved = true
      return slot
    })
    await new Promise((r) => setImmediate(r))
    expect(bResolved).toBe(false)
    expect(s.inflightCount('s1')).toBe(1)
    expect(s.queueDepth('s1')).toBe(1)

    a.release()
    const b = await bP
    expect(bResolved).toBe(true)
    expect(s.inflightCount('s1')).toBe(1)
    b.release()
  })

  it('isolates per-session caps across different sessions', async () => {
    const s = new SandboxScheduler({ globalCap: 8, perSessionCap: 1 })
    const a = await s.allocate('s1')
    // s1 is at per-session cap, but s2 has its own cap.
    const c = await s.allocate('s2')
    expect(s.inflightCount()).toBe(2)
    expect(s.inflightCount('s1')).toBe(1)
    expect(s.inflightCount('s2')).toBe(1)
    a.release()
    c.release()
  })

  it('drains queue in FIFO order, skipping waiters still over per-session cap', async () => {
    // globalCap=2 with two slots filled forces both later allocates to queue.
    const s = new SandboxScheduler({ globalCap: 2, perSessionCap: 1 })
    const a1 = await s.allocate('s1') // s1: 1/1
    const b1 = await s.allocate('s2') // s2: 1/1, global: 2/2
    // Queue: another s1, then s3.
    const order: string[] = []
    const a2P = s.allocate('s1').then((slot) => {
      order.push('a2')
      return slot
    })
    const c1P = s.allocate('s3').then((slot) => {
      order.push('c1')
      return slot
    })
    await new Promise((r) => setImmediate(r))
    expect(order).toEqual([])
    expect(s.queueDepth()).toBe(2)

    // Release b1 (s2). Doesn't unblock head (a2/s1 still at cap), but c1/s3
    // can proceed since s3 has 0 inflight.
    b1.release()
    await new Promise((r) => setImmediate(r))
    expect(order).toEqual(['c1'])
    // a2 still waiting on s1.
    expect(s.queueDepth()).toBe(1)

    // Release a1 (s1). Now a2 can be admitted.
    a1.release()
    const [a2, c1] = await Promise.all([a2P, c1P])
    expect(order).toEqual(['c1', 'a2'])
    expect(s.queueDepth()).toBe(0)
    a2.release()
    c1.release()
  })

  it('wakes multiple waiters when a release frees enough global capacity', async () => {
    const s = new SandboxScheduler({ globalCap: 2, perSessionCap: 4 })
    const a = await s.allocate('s1')
    const b = await s.allocate('s2') // global at cap
    const cP = s.allocate('s3')
    const dP = s.allocate('s4')
    await new Promise((r) => setImmediate(r))
    expect(s.queueDepth()).toBe(2)

    a.release()
    // Frees one global slot — exactly one waiter wakes (c, the head).
    const c = await cP
    expect(s.inflightCount()).toBe(2)
    expect(s.queueDepth()).toBe(1)

    b.release()
    const d = await dP
    expect(s.queueDepth()).toBe(0)
    expect(s.inflightCount()).toBe(2)
    c.release()
    d.release()
  })
})

describe('SandboxScheduler release', () => {
  it('is idempotent — second release is a no-op', async () => {
    const s = new SandboxScheduler({ globalCap: 1, perSessionCap: 1 })
    const slot = await s.allocate('s1')
    slot.release()
    expect(s.inflightCount()).toBe(0)
    slot.release()
    expect(s.inflightCount()).toBe(0)
  })

  it('does not over-wake when called twice', async () => {
    const s = new SandboxScheduler({ globalCap: 1, perSessionCap: 1 })
    const a = await s.allocate('s1')
    const bP = s.allocate('s2')
    let cResolved = false
    const cP = s.allocate('s3').then((slot) => {
      cResolved = true
      return slot
    })
    await new Promise((r) => setImmediate(r))

    a.release()
    a.release() // double-release: must not wake c
    const b = await bP
    await new Promise((r) => setImmediate(r))
    expect(cResolved).toBe(false)
    expect(s.queueDepth()).toBe(1)

    b.release()
    const c = await cP
    expect(cResolved).toBe(true)
    c.release()
  })
})

describe('SandboxScheduler counters', () => {
  it('inflightCount tracks global and per-session', async () => {
    const s = new SandboxScheduler({ globalCap: 4, perSessionCap: 4 })
    const slots: Slot[] = []
    slots.push(await s.allocate('s1'))
    slots.push(await s.allocate('s1'))
    slots.push(await s.allocate('s2'))
    expect(s.inflightCount()).toBe(3)
    expect(s.inflightCount('s1')).toBe(2)
    expect(s.inflightCount('s2')).toBe(1)
    expect(s.inflightCount('s3')).toBe(0)
    for (const slot of slots) slot.release()
    expect(s.inflightCount()).toBe(0)
    expect(s.inflightCount('s1')).toBe(0)
  })

  it('queueDepth tracks pending waiters', async () => {
    const s = new SandboxScheduler({ globalCap: 1, perSessionCap: 1 })
    const a = await s.allocate('s1')
    const bP = s.allocate('s2')
    const cP = s.allocate('s2')
    await new Promise((r) => setImmediate(r))
    expect(s.queueDepth()).toBe(2)
    expect(s.queueDepth('s2')).toBe(2)
    expect(s.queueDepth('s1')).toBe(0)

    a.release()
    const b = await bP
    expect(s.queueDepth()).toBe(1)
    b.release()
    const c = await cP
    expect(s.queueDepth()).toBe(0)
    c.release()
  })
})
