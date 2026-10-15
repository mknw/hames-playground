/**
 * #507 N4 — `withSandbox` re-hydrates `/work/in` after a tool call in its scope
 * stored a stash document.
 *
 * The write is REAL: the fake app tool calls core's own `storeDocument` (over a
 * fake Redis), so the observer seam under test is the one production writes
 * through. Only `hydrateWorkspace` is replaced — by a model that copies the
 * session's stored documents into an in-memory `/work/in` and logs which
 * session it was asked for. The mutation each pin answers to is named on it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

type Doc = { sessionId: string; filename: string }
const world = vi.hoisted(() => ({
  stored: [] as Array<{ sessionId: string; filename: string }>,
  workIn: new Set<string>(),
  hydrateSessions: [] as string[],
  hydrate: null as null | ((sessionId: string) => Promise<{ skipped: unknown[] }>),
}))

const artifacts = vi.hoisted(() => ({
  hydrateWorkspace: vi.fn(async (_t: unknown, sessionId: string) => {
    world.hydrateSessions.push(sessionId)
    if (world.hydrate) return { written: 0, ...(await world.hydrate(sessionId)) }
    let written = 0
    for (const d of world.stored) {
      if (d.sessionId !== sessionId || world.workIn.has(d.filename)) continue
      world.workIn.add(d.filename)
      written++
    }
    return { written, skipped: [] as Array<{ filename: string; error: string }> }
  }),
  snapshotOutputs: vi.fn(async () => new Map<string, string>()),
  promoteOutputs: vi.fn(async () => ({ promoted: [] as string[], skipped: [] })),
}))
vi.mock('../work-artifacts.server', () => artifacts)

import { withSandbox } from '../with-sandbox.server'
import { WarmPool } from '../warm-pool.server'
import { SandboxScheduler } from '../scheduler.server'
import { AttachmentTable } from '../attachment-table.server'
import { callTool } from '@hames-ai/harness-patterns/mcp-client.server'
import {
  storeDocument,
  type CallTool,
} from '@hames-ai/harness-patterns/stash/document-store.server'
import type { ToolTransport } from '@hames-ai/harness-patterns/tool-transport.server'
import type { ComputeBackend, McpTransport, VMHandle } from '../types'
import type {
  ConfiguredPattern,
  PatternScope,
  EventView,
  ToolCallResult,
} from '@hames-ai/harness-patterns/types'

const SESSION = 'sess-1'

function fakeBackend(): ComputeBackend {
  const handle: VMHandle = {
    id: 'sbx-test',
    backend: 'docker',
    rootfs: 'base',
    bootedAt: Date.now(),
    native: { containerId: 'cid-test', runtime: {} },
  }
  const transport: McpTransport = {
    vmId: handle.id,
    toolNames: async () => ['sandbox_bash'],
    listTools: async () => [],
    ownsTool: (name: string) => name.startsWith('sandbox_'),
    callTool: async () => ({ success: true, data: 'in-vm' }),
    close: async () => {},
  }
  return {
    kind: 'docker',
    async boot() {
      return handle
    },
    async destroy() {},
    reset: vi.fn(async () => {}),
    async connectMcp() {
      return transport
    },
    async health() {
      return { state: 'healthy' as const }
    },
    async reapOrphans() {
      return 0
    },
  }
}

function kit() {
  const backend = fakeBackend()
  const pool = new WarmPool(backend, { caps: { base: 1 }, idleEvictMs: 60_000 })
  const scheduler = new SandboxScheduler({ globalCap: 4, perSessionCap: 4 })
  const attachments = new AttachmentTable(backend, pool, { idleMs: 60_000 })
  return { backend, pool, scheduler, attachments }
}

/** A fake Redis that records which document each `json_set` persisted. */
const fakeRedis: CallTool = async (name, args) => {
  if (name === 'json_set') {
    const doc = JSON.parse(String(args.value)) as Doc
    world.stored.push({ sessionId: doc.sessionId, filename: doc.filename })
  }
  return { success: true, data: 'OK' }
}

/** The app-side tools, as a scoped transport the way production's sit behind
 *  `callTool`: `ingest` stores into the sandbox's session, `ingest_other` into
 *  somebody else's, `lookup` stores nothing. */
const appTransport: ToolTransport = {
  id: 'app-test',
  ownsTool: (n) => ['ingest', 'ingest_other', 'lookup'].includes(n),
  listTools: async () => [],
  callTool: async (name) => {
    if (name === 'ingest') {
      await storeDocument(
        { sessionId: SESSION, filename: 'report.csv', mimeType: 'text/csv', content: 'a,b' },
        fakeRedis,
      )
      return { success: true, data: { documentId: 'd1' } }
    }
    if (name === 'ingest_other') {
      await storeDocument(
        { sessionId: 'sess-OTHER', filename: 'theirs.csv', mimeType: 'text/csv', content: 'x' },
        fakeRedis,
      )
      return { success: true, data: { documentId: 'd2' } }
    }
    return { success: true, data: { rows: 3 } }
  },
}

function pattern(body: () => Promise<unknown>): ConfiguredPattern<Record<string, unknown>> {
  return {
    name: 'inner',
    fn: async (scope) => {
      await body()
      return scope
    },
    config: { patternId: 'inner', trackHistory: true, errorSeverity: 'irrecoverable' },
    estimateTurns: () => 3,
  }
}

const scope = (): PatternScope<Record<string, unknown>> => ({
  id: 'inner',
  events: [],
  data: {},
  startTime: Date.now(),
})

function run(
  body: () => Promise<unknown>,
  opts: { syncWorkspace?: boolean } = { syncWorkspace: true },
  s = scope(),
) {
  const wrap = withSandbox({ ...kit(), id: SESSION, sessionId: SESSION, ...opts })(pattern(body))
  return withRunFrame({ transports: [appTransport] }, () => wrap.fn(s, {} as unknown as EventView))
}

beforeEach(() => {
  world.stored.length = 0
  world.workIn.clear()
  world.hydrateSessions.length = 0
  world.hydrate = null
  artifacts.hydrateWorkspace.mockClear()
})

describe('withSandbox re-hydrates after a stash-storing tool call (#507 N4)', () => {
  // Mutation: run the after-call hooks BEFORE dispatching the call — hydrate
  // then runs ahead of the write, the file is absent and this reddens.
  it('puts the stored document in /work/in by the time the storing call returns', async () => {
    let onDiskAtReturn: boolean | undefined
    let onDiskBefore: boolean | undefined
    await run(async () => {
      onDiskBefore = world.workIn.has('report.csv')
      const r = await callTool('ingest', {})
      expect(r.success).toBe(true)
      onDiskAtReturn = world.workIn.has('report.csv')
    })
    expect(onDiskBefore).toBe(false)
    expect(onDiskAtReturn).toBe(true)
    // Entry hydrate + exactly one re-hydrate for the one storing call.
    expect(world.hydrateSessions).toEqual([SESSION, SESSION])
  })

  // Mutation: drop the `dirty` check — every call hydrates and this reddens.
  it('does NOT re-hydrate after a call that stored nothing, nor after in-VM calls', async () => {
    await run(async () => {
      await callTool('lookup', {})
      await callTool('sandbox_bash', { command: 'ls' })
    })
    expect(world.hydrateSessions).toEqual([SESSION]) // the entry hydrate only
  })

  // Mutation: drop the `write.sessionId === sessionId` filter.
  it('ignores a document stored under another conversation, and only ever hydrates its own', async () => {
    await run(async () => {
      await callTool('ingest_other', {})
      await callTool('ingest', {})
    })
    expect(new Set(world.hydrateSessions)).toEqual(new Set([SESSION]))
    expect(world.hydrateSessions).toHaveLength(2) // entry + the one own-session ingest
    expect(world.workIn.has('theirs.csv')).toBe(false)
  })

  it('a write to another conversation alone triggers no re-hydrate', async () => {
    await run(async () => {
      await callTool('ingest_other', {})
    })
    expect(world.hydrateSessions).toEqual([SESSION])
  })

  // Mutation: return nothing on failure (fail-open) — the actor is told the
  // file is there and this reddens.
  it('FAILS CLOSED when the re-hydrate throws: the call reports failure, and the event is recorded', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = scope()
    let seen: ToolCallResult | undefined
    // Entry hydrate succeeds; the re-hydrate is the one that fails.
    world.hydrate = async () => {
      if (world.hydrateSessions.length > 1) throw new Error('gateway down')
      return { skipped: [] }
    }
    await run(
      async () => {
        seen = await callTool('ingest', {})
      },
      { syncWorkspace: true },
      s,
    )
    expect(seen?.success).toBe(false)
    expect(seen?.error).toContain('NOT available')
    expect(seen?.error).toContain('gateway down')
    expect(seen?.error).toContain('Do not repeat the call')
    const events = s.events.filter((e) => e.type === 'error')
    expect(events).toHaveLength(1)
    expect((events[0].data as { error: string }).error).toContain('hydrate failed')
    err.mockRestore()
  })

  it('FAILS CLOSED when a file is skipped, naming it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    let seen: ToolCallResult | undefined
    world.hydrate = async () =>
      world.hydrateSessions.length > 1
        ? { skipped: [{ filename: 'report.csv', error: 'disk full' }] }
        : { skipped: [] }
    await run(async () => {
      seen = await callTool('ingest', {})
    })
    expect(seen?.success).toBe(false)
    expect(seen?.error).toContain('report.csv (disk full)')
    err.mockRestore()
  })

  it('a later call that stores nothing is unaffected by an earlier failed restore', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    let later: ToolCallResult | undefined
    world.hydrate = async () => {
      if (world.hydrateSessions.length > 1) throw new Error('gateway down')
      return { skipped: [] }
    }
    await run(async () => {
      await callTool('ingest', {})
      later = await callTool('lookup', {})
    })
    expect(later).toEqual({ success: true, data: { rows: 3 } })
    err.mockRestore()
  })

  it('does nothing when syncWorkspace is off', async () => {
    await run(
      async () => {
        await callTool('ingest', {})
      },
      { syncWorkspace: false },
    )
    expect(artifacts.hydrateWorkspace).not.toHaveBeenCalled()
  })

  it('stops observing when the scope ends: a later write outside it does not hydrate', async () => {
    await run(async () => {})
    await withRunFrame({ transports: [appTransport] }, async () => {
      await callTool('ingest', {})
    })
    expect(world.hydrateSessions).toEqual([SESSION]) // the entry hydrate only
  })
})
