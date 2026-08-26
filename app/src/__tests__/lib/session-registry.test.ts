/**
 * SessionRegistry — the per-conversation state the chat route keeps alive
 * across a sidebar switch (#226 B1).
 *
 * These are direct calls against the module. Before it existed the same rules
 * were exercised by mounting the whole route with three stubbed children and
 * driving callbacks through them, because the logic had no interface of its
 * own; the route's remaining test now only covers the wiring.
 *
 * What is pinned here is everything a bad refactor would quietly break: the
 * eight slots are addressed by session id and never leak into each other, the
 * prune rule spares a running conversation, disposal forgets *all* of it, and
 * the completion flash decays exactly once.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRoot } from 'solid-js'
import { createSessionRegistry, type SessionRegistry } from '~/lib/session-registry'
import { COMPLETION_FLASH_MS } from '~/lib/run-registry'
import type { Message } from '~/components/ark-ui/ChatMessages'
import type { ContextEvent, UnifiedContext } from '~/lib/harness-patterns'

const make = () => createRoot(() => createSessionRegistry())

const msg = (id: string): Message => ({
  id,
  role: 'user',
  content: id,
  timestamp: new Date(0),
})
const evt = (ts: number): ContextEvent =>
  ({ type: 'tool_call', patternId: 'p', ts, data: {} }) as ContextEvent

afterEach(() => {
  vi.useRealTimers()
})

describe('SessionRegistry — per-session slots', () => {
  it('starts every slot empty for a session it has never seen', () => {
    const r = make()
    expect(r.messages('unseen')).toEqual([])
    expect(r.events('unseen')).toEqual([])
    expect(r.graph('unseen')).toEqual([])
    expect(r.context('unseen')).toBeUndefined()
    expect(r.completion('unseen')).toBeUndefined()
    // An untouched session reads as idle rather than undefined.
    expect(r.runState('unseen')).toEqual({ isProcessing: false, runningTool: null, warming: null })
  })

  it('keeps two conversations’ buffers apart', () => {
    const r = make()
    r.setMessages('a', [msg('m1')])
    r.appendEvents('a', [evt(1)])
    r.mergeGraph('a', [{ data: { id: 'n1' } }])
    r.setContext('a', { events: [] } as unknown as UnifiedContext)

    expect(r.messages('b')).toEqual([])
    expect(r.events('b')).toEqual([])
    expect(r.graph('b')).toEqual([])
    expect(r.context('b')).toBeUndefined()
    expect(r.messages('a')).toHaveLength(1)
  })

  it('accepts an updater function as well as a plain array of messages', () => {
    const r = make()
    r.setMessages('a', [msg('m1')])
    r.setMessages('a', (prev) => [...prev, msg('m2')])
    r.appendMessage('a', msg('m3'))
    expect(r.messages('a').map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('appends events in arrival order and ignores an empty batch', () => {
    const r = make()
    r.appendEvents('a', [evt(1)])
    r.appendEvents('a', [])
    r.appendEvents('a', [evt(2), evt(3)])
    expect(r.events('a').map((e) => e.ts)).toEqual([1, 2, 3])
  })

  it('rewrites events in place for the stash flags', () => {
    const r = make()
    r.appendEvents('a', [
      { ...evt(1), id: 'e1' },
      { ...evt(2), id: 'e2' },
    ])
    r.mapEvents('a', (e) => (e.id === 'e1' ? { ...e, data: { hidden: true } } : e))
    expect(r.events('a')[0].data).toEqual({ hidden: true })
    expect(r.events('a')[1].data).toEqual({})
  })

  it('merges graph batches and reports the ids that just arrived', () => {
    const r = make()
    expect(r.mergeGraph('a', [{ data: { id: 'n1' } }])).toEqual(['n1'])
    // An element with no id contributes to the graph but is not reportable.
    const ids = r.mergeGraph('a', [{ data: { id: 'n2' } }, { data: { label: 'anon' } }])
    expect(ids).toEqual(['n2'])
    expect(r.graph('a').map((e) => e.data?.id)).toEqual(['n1', 'n2', undefined])
  })

  it('gives each conversation its own progress controller, stable across reads', () => {
    const r = make()
    const p = r.progress('a')
    expect(r.progress('a')).toBe(p)
    expect(r.progress('b')).not.toBe(p)
  })

  it('counts only the conversations with a stream open', () => {
    const r = make()
    expect(r.runningCount()).toBe(0)
    r.updateRunState('a', { isProcessing: true })
    r.updateRunState('b', { isProcessing: true, runningTool: 'read_neo4j_cypher' })
    expect(r.runningCount()).toBe(2)
    expect(r.runState('b')).toEqual({
      isProcessing: true,
      runningTool: 'read_neo4j_cypher',
      warming: null,
    })

    r.updateRunState('a', { isProcessing: false })
    expect(r.runningCount()).toBe(1)
  })
})

describe('SessionRegistry — clears', () => {
  it('clears one conversation’s graph without touching another’s', () => {
    const r = make()
    r.mergeGraph('a', [{ data: { id: 'n1' } }])
    r.mergeGraph('b', [{ data: { id: 'n2' } }])
    r.clearGraph('a')
    expect(r.graph('a')).toEqual([])
    expect(r.graph('b')).toHaveLength(1)
  })

  it('clears events and the unified context together', () => {
    const r = make()
    r.appendEvents('a', [evt(1)])
    r.setContext('a', { events: [] } as unknown as UnifiedContext)
    r.clearEvents('a')
    expect(r.events('a')).toEqual([])
    expect(r.context('a')).toBeUndefined()
  })

  it('clearPanels wipes graph, events and context but leaves the transcript', () => {
    const r = make()
    r.setMessages('a', [msg('m1')])
    r.appendEvents('a', [evt(1)])
    r.mergeGraph('a', [{ data: { id: 'n1' } }])
    r.setContext('a', { events: [] } as unknown as UnifiedContext)

    r.clearPanels('a')
    expect(r.events('a')).toEqual([])
    expect(r.graph('a')).toEqual([])
    expect(r.context('a')).toBeUndefined()
    // The messages are the chat view's to reload; clearing panels is not that.
    expect(r.messages('a')).toHaveLength(1)
  })
})

describe('SessionRegistry — completion marks', () => {
  it('flashes once, then decays to a mark that survives until the thread is opened', () => {
    vi.useFakeTimers()
    const r = make()
    r.markCompleted('a', 'done')
    expect(r.completion('a')).toEqual({ outcome: 'done', flashing: true })

    vi.advanceTimersByTime(COMPLETION_FLASH_MS)
    expect(r.completion('a')).toEqual({ outcome: 'done', flashing: false })

    r.clearCompletion('a')
    expect(r.completion('a')).toBeUndefined()
  })

  it('re-marking restarts the flash rather than leaving two timers behind', () => {
    vi.useFakeTimers()
    const r = make()
    r.markCompleted('a', 'done')
    vi.advanceTimersByTime(COMPLETION_FLASH_MS / 2)
    r.markCompleted('a', 'error')

    vi.advanceTimersByTime(COMPLETION_FLASH_MS / 2)
    // The first timer was cancelled — the second flash is still running.
    expect(r.completion('a')).toEqual({ outcome: 'error', flashing: true })
    vi.advanceTimersByTime(COMPLETION_FLASH_MS / 2)
    expect(r.completion('a')).toEqual({ outcome: 'error', flashing: false })
  })

  it('a pending flash cannot resurrect a mark that was already cleared', () => {
    vi.useFakeTimers()
    const r = make()
    r.markCompleted('a', 'done')
    r.clearCompletion('a')
    vi.advanceTimersByTime(COMPLETION_FLASH_MS)
    expect(r.completion('a')).toBeUndefined()
  })

  it('destroy() cancels every outstanding flash timer', () => {
    vi.useFakeTimers()
    const r = make()
    r.markCompleted('a', 'done')
    r.destroy()
    vi.advanceTimersByTime(COMPLETION_FLASH_MS)
    // Still flashing: the decay timer was cancelled with the owner.
    expect(r.completion('a')).toEqual({ outcome: 'done', flashing: true })
  })
})

describe('SessionRegistry — in-flight streams', () => {
  it('aborts one conversation’s stream and leaves the others open', () => {
    const r = make()
    const a = new AbortController()
    const b = new AbortController()
    r.registerAbort('a', a)
    r.registerAbort('b', b)

    r.abort('a')
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(false)
  })

  it('aborting an unregistered or already-unregistered session is a no-op', () => {
    const r = make()
    const a = new AbortController()
    r.registerAbort('a', a)
    r.unregisterAbort('a')
    expect(() => r.abort('a')).not.toThrow()
    expect(() => r.abort('never-seen')).not.toThrow()
    expect(a.signal.aborted).toBe(false)
  })

  it('abortAll() drops every open stream at once', () => {
    const r = make()
    const a = new AbortController()
    const b = new AbortController()
    r.registerAbort('a', a)
    r.registerAbort('b', b)
    r.abortAll()
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(true)
    // The map is emptied, so a second sweep has nothing to do.
    expect(() => r.abortAll()).not.toThrow()
  })
})

describe('SessionRegistry — lifecycle', () => {
  const fill = (r: SessionRegistry, sid: string) => {
    r.setMessages(sid, [msg(`${sid}-m`)])
    r.appendEvents(sid, [evt(1)])
    r.mergeGraph(sid, [{ data: { id: `${sid}-n` } }])
    r.setContext(sid, { events: [] } as unknown as UnifiedContext)
  }

  it('pruneIdle drops idle conversations but spares the one kept and any running one', () => {
    const r = make()
    fill(r, 'running')
    fill(r, 'idle')
    fill(r, 'keep')
    r.updateRunState('running', { isProcessing: true })

    r.pruneIdle('keep')

    expect(r.messages('running')).toHaveLength(1)
    expect(r.events('running')).toHaveLength(1)
    expect(r.messages('keep')).toHaveLength(1)
    // The idle one is disposable — the chat view reloads it from Postgres.
    expect(r.messages('idle')).toEqual([])
    expect(r.events('idle')).toEqual([])
    expect(r.graph('idle')).toEqual([])
    expect(r.context('idle')).toBeUndefined()
  })

  it('pruneIdle keeps the progress controller so a finished bar is not rebuilt from nothing', () => {
    const r = make()
    const p = r.progress('idle')
    fill(r, 'idle')
    r.pruneIdle('keep')
    expect(r.progress('idle')).toBe(p)
  })

  it('dispose forgets every slot of a deleted conversation, in one call', () => {
    vi.useFakeTimers()
    const r = make()
    fill(r, 'gone')
    const p = r.progress('gone')
    const ac = new AbortController()
    r.registerAbort('gone', ac)
    r.updateRunState('gone', { isProcessing: true })
    r.markCompleted('gone', 'error')

    r.dispose(['gone'])

    expect(r.messages('gone')).toEqual([])
    expect(r.events('gone')).toEqual([])
    expect(r.graph('gone')).toEqual([])
    expect(r.context('gone')).toBeUndefined()
    expect(r.completion('gone')).toBeUndefined()
    expect(r.runState('gone')).toEqual({ isProcessing: false, runningTool: null, warming: null })
    expect(r.runningCount()).toBe(0)
    expect(r.progress('gone')).not.toBe(p)
    // The controller is forgotten too, so a late abort cannot reach it.
    r.abort('gone')
    expect(ac.signal.aborted).toBe(false)
    // ...and its flash timer went with it.
    vi.advanceTimersByTime(COMPLETION_FLASH_MS)
    expect(r.completion('gone')).toBeUndefined()
  })

  it('dispose leaves the conversations it was not given alone', () => {
    const r = make()
    fill(r, 'a')
    fill(r, 'b')
    r.updateRunState('b', { isProcessing: true })
    r.dispose(['a'])
    expect(r.messages('b')).toHaveLength(1)
    expect(r.runningCount()).toBe(1)
  })

  it('disposing nothing is a no-op', () => {
    const r = make()
    fill(r, 'a')
    r.dispose([])
    expect(r.messages('a')).toHaveLength(1)
  })
})
