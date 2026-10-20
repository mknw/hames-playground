/**
 * The host's document source for the Decide step (#507 slice 10): where the tier
 * line is drawn, who may see which session, and what the decider is actually SENT.
 *
 * The invariant these pins hold: no uploaded-file name reaches the Anthropic
 * tier's decisions host. They check it at the decide request's `state` (the body
 * the transport posts), not at the function that builds it.
 *
 * Every pin names, in its comment, the mutation that turns it red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { withRunFrame, amendRunFrame } from '@hames-ai/harness-patterns/run-frame.server'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))
vi.mock('@hames-ai/harness-patterns/mcp-client.server', () => ({
  callTool: vi.fn(async () => ({ success: false, data: null, error: 'no gateway' })),
}))
vi.mock('../../../lib/stash/ownership.server', () => ({ userOwnsSession: vi.fn() }))

import { createDecisionDocuments } from '../../../lib/harness-client/decision-documents.server'
import { runWithUserId } from '../../../lib/harness-client/request-user.server'
import { userOwnsSession } from '../../../lib/stash/ownership.server'
import { runChain } from '@hames-ai/harness-patterns/patterns/chain.server'
import { createContext } from '@hames-ai/harness-patterns/context.server'
import { decisionLoop } from '@hames-ai/harness-patterns/patterns/decisionLoop.server'
import type {
  CallTool,
  StashDocumentSummary,
} from '@hames-ai/harness-patterns/stash/document-store.server'
import {
  registerStashTransport,
  resetStashTransport,
} from '@hames-ai/harness-patterns/stash-transport.server'
import { configurePattern } from '@hames-ai/harness-patterns/patterns/chain.server'
import type { DecideFn, WarningEventData } from '@hames-ai/harness-patterns/types'

const summary = (name: string, over: Partial<StashDocumentSummary> = {}): StashDocumentSummary => ({
  id: `id-${name}`,
  filename: name,
  mimeType: 'text/markdown',
  size: 2048,
  uploadedAt: 10,
  excluded: false,
  ingestStatus: 'indexed',
  ...over,
})

const NAMES = ['lantern-notes.md', 'lantern-sales.csv']
const ALL = [
  summary(NAMES[0], { uploadedAt: 2 }),
  summary(NAMES[1], { uploadedAt: 1, mimeType: 'text/csv' }),
]

/** The source under a run frame carrying `tier` (or none), as a user's turn. */
async function resolve(
  tier: string | undefined,
  docs: StashDocumentSummary[] = ALL,
  over: { owns?: boolean; userId?: string | null } = {},
) {
  const source = createDecisionDocuments('sess-1', {
    list: async () => docs,
    owns: async () => over.owns ?? true,
    userId: () => (over.userId === undefined ? 'user-1' : over.userId),
  })
  return withRunFrame(tier === undefined ? {} : { inference: { tier } }, () =>
    source(new AbortController().signal),
  )
}

beforeEach(() => {
  vi.mocked(userOwnsSession).mockReset()
  resetStashTransport()
})

describe('createDecisionDocuments — the tier line', () => {
  // Mutation: render the count only.
  it("a run whose raw tier slot is 'verda' gets every visible name, type facts and the total", async () => {
    const r = await resolve('verda')
    expect(r.total).toBe(2)
    expect(r.names?.map((n) => n.name)).toEqual(NAMES)
    expect(r.names?.[0]).toMatchObject({ searchable: true, mimeType: 'text/markdown', size: 2048 })
  })

  // Mutation: compare against 'private' (every run then gets a count, and the
  // positive pin above goes red); test `!== 'anthropic'` (the unrecognised and
  // frameless rows go red); render names whatever the tier.
  it.each([
    ['anthropic', 'anthropic'],
    ['an unrecognised value', 'Verda '],
    ['a spelling the code does not have', 'private'],
    ['a typo', 'verd'],
    ['an empty slot', ''],
  ])('%s gets the count and no name anywhere', async (_what, tier) => {
    const r = await resolve(tier)
    expect(r).toEqual({ total: 2 })
    expect(JSON.stringify(r)).not.toMatch(/lantern|\.md|\.csv/)
  })

  // Mutation: read `activeInferenceTier()` instead of the raw frame slot.
  it('a frame with no tier slot gets the count, even on a deployment whose default tier is verda', async () => {
    // The deployment default is the host's policy (`USE_VERDA_INFERENCE`), read
    // by `activeInferenceTier()`. The source must not ask it.
    const { configureInferencePolicy } = await import('@hames-ai/harness-baml/clients.server')
    configureInferencePolicy({ defaultTier: () => 'verda' })
    try {
      expect(await resolve(undefined)).toEqual({ total: 2 })
      // and a frame that carries other slots but no tier
      const source = createDecisionDocuments('s', {
        list: async () => ALL,
        owns: async () => true,
        userId: () => 'u',
      })
      const r = await withRunFrame({ hitl: { attended: false } }, () =>
        source(new AbortController().signal),
      )
      expect(r).toEqual({ total: 2 })
    } finally {
      configureInferencePolicy({ defaultTier: () => 'anthropic' })
    }
  })

  it('reads the tier when the source is CALLED, not when it is built (built patterns outlive the turn)', async () => {
    const source = createDecisionDocuments('s', {
      list: async () => ALL,
      owns: async () => true,
      userId: () => 'u',
    })
    const signal = new AbortController().signal
    expect(
      (await withRunFrame({ inference: { tier: 'anthropic' } }, () => source(signal))).names,
    ).toBeUndefined()
    expect(
      (await withRunFrame({ inference: { tier: 'verda' } }, () => source(signal))).names,
    ).toHaveLength(2)
    // A frame amended below the run still carries the run's tier.
    const amended = await withRunFrame({ inference: { tier: 'anthropic' } }, () =>
      amendRunFrame({ hitl: { attended: true } }, () => source(signal)),
    )
    expect(amended.names).toBeUndefined()
  })
})

describe('createDecisionDocuments — which documents', () => {
  // Mutation: include them; skip the flag check.
  it('hidden and archived documents are absent from the list AND the count, on both kinds of run', async () => {
    const docs = [
      ...ALL,
      summary('hidden-secret.md', { excluded: true }),
      summary('archived-secret.md', { excluded: true }),
    ]
    for (const tier of ['verda', 'anthropic', undefined]) {
      const r = await resolve(tier, docs)
      expect(r.total).toBe(2)
      expect(JSON.stringify(r)).not.toContain('secret')
    }
  })

  it("'searchable' is the indexed status and nothing else", async () => {
    const docs = (['indexed', 'pending', 'failed', 'not_indexed', undefined] as const).map((s, i) =>
      summary(`d${i}.md`, { ingestStatus: s, uploadedAt: i }),
    )
    const r = await resolve('verda', docs)
    expect(r.names?.map((n) => n.searchable)).toEqual([true, false, false, false, false])
  })
})

describe('createDecisionDocuments — whose session', () => {
  // Mutation: drop the owner scoping.
  it("another user's turn on this session id lists nothing and never reads the stash", async () => {
    const list = vi.fn(async () => ALL)
    const owns = vi.fn(async (_s: string, u: string) => u === 'owner')
    const source = createDecisionDocuments('sess-1', { list, owns, userId: () => 'intruder' })
    const r = await withRunFrame({ inference: { tier: 'verda' } }, () =>
      source(new AbortController().signal),
    )
    expect(r).toEqual({ total: 0 })
    expect(owns).toHaveBeenCalledWith('sess-1', 'intruder')
    expect(list).not.toHaveBeenCalled()
  })

  // Mutation: fall back to some user, or to listing without one.
  it('with no user in scope it refuses (the loop then says unknown)', async () => {
    await expect(resolve('verda', ALL, { userId: null })).rejects.toThrow(/ownership/)
  })

  it('takes the owner from the request scope when none is injected', async () => {
    vi.mocked(userOwnsSession).mockResolvedValue(true)
    const source = createDecisionDocuments('sess-9', { list: async () => ALL })
    const r = await runWithUserId('scoped-user', () =>
      withRunFrame({ inference: { tier: 'verda' } }, () => source(new AbortController().signal)),
    )
    expect(userOwnsSession).toHaveBeenCalledWith('sess-9', 'scoped-user')
    expect(r.total).toBe(2)
  })
})

// ============================================================================
// What the decider is SENT
// ============================================================================

function loopWith(source: ReturnType<typeof createDecisionDocuments>) {
  const states: string[] = []
  const decide = (async ({
    spec,
    state,
  }: {
    spec: { labels: readonly { id: string }[] }
    state: string
  }) => {
    states.push(state)
    return {
      probs: Object.fromEntries(spec.labels.map((l) => [l.id, l.id === 'answer' ? 1 : 0])),
      method: 'jev',
      calibrated: false,
    }
  }) as unknown as DecideFn
  Object.assign(decide, { supportedTypes: ['choice'], limits: () => ({ contextWindow: 131_072 }) })
  const route = configurePattern<Record<string, unknown>>('simpleLoop', async (s) => s, {
    patternId: 'info-p',
  })
  const loop = decisionLoop<Record<string, unknown>>(
    { info: { pattern: route as never, description: 'look it up' } },
    { decide, answer: 'Answer now', patternId: 'orchestrator', documents: source },
  )
  return { loop, states }
}

async function sent(tier: string | undefined, source: ReturnType<typeof createDecisionDocuments>) {
  const { loop, states } = loopWith(source)
  const ctx = createContext<Record<string, unknown>>('what do my notes say?')
  await withRunFrame(tier === undefined ? {} : { inference: { tier } }, () =>
    runChain(ctx, [loop as never]),
  )
  return { state: states[0], ctx }
}

describe('what the decide request carries', () => {
  const source = () =>
    createDecisionDocuments('sess-1', {
      list: async () => ALL,
      owns: async () => true,
      userId: () => 'user-1',
    })

  // Mutation: render names whatever the tier (the invariant, at the request body).
  it("on 'anthropic', and on a frameless run, the state holds the count and no uploaded file name", async () => {
    for (const tier of ['anthropic', undefined, 'private']) {
      const { state } = await sent(tier, source())
      expect(state).toContain('Uploaded documents in this conversation: 2 (names not shown)')
      for (const name of NAMES) expect(state).not.toContain(name)
      expect(state).not.toContain('lantern')
    }
  })

  it("on 'verda' the state lists the names the user did not type", async () => {
    const { state } = await sent('verda', source())
    expect(state).toContain('- "lantern-notes.md" (Markdown, 2.0 KB, searchable)')
    expect(state).toContain('- "lantern-sales.csv" (CSV, 2.0 KB, searchable)')
  })

  // Mutation: swap in `listDocuments` (an index failure then renders "none", a
  // document failure prunes a live entry); swallow the error into an empty list.
  it.each([
    ['a failed smembers', 'smembers'],
    ['a failed json_get for one document', 'json_get'],
  ])(
    '%s: the unknown line, one warning, zero srem calls, the turn proceeds',
    async (_what, failing) => {
      const ops: string[] = []
      const callTool: CallTool = async (name, args) => {
        ops.push(name)
        const failed =
          name === failing && (name === 'smembers' || String(args.name).endsWith(':d2'))
        if (failed) return { success: false, data: null, error: 'gateway timeout' }
        if (name === 'smembers') return { success: true, data: ['d1', 'd2'] }
        return { success: true, data: JSON.stringify(['a.md', 'text/plain', 1, 1]) }
      }
      registerStashTransport(() => callTool)
      const src = createDecisionDocuments('sess-1', {
        owns: async () => true,
        userId: () => 'user-1',
      })
      const { state, ctx } = await sent('verda', src)
      expect(state).toContain(
        'Uploaded documents in this conversation: unknown (could not be read)',
      )
      expect(state).not.toMatch(/\bnone\b/)
      expect(ops).toContain(failing) // the real read ran against the registered transport
      expect(ops).not.toContain('srem')
      const w = ctx.events
        .filter((e) => e.type === 'warning')
        .map((e) => e.data as WarningEventData)
      expect(w).toHaveLength(1)
      expect(w[0].task).toBe('decision_documents')
      expect(ctx.events.filter((e) => e.type === 'error')).toHaveLength(0)
      expect(ctx.status).toBe('running')
    },
  )

  it('an expired key found by a SUCCESSFUL empty read is the only prune, and does not fail the read', async () => {
    const ops: Array<[string, Record<string, unknown>]> = []
    const callTool: CallTool = async (name, args) => {
      ops.push([name, args])
      if (name === 'smembers') return { success: true, data: ['live', 'expired'] }
      if (name === 'srem') return { success: true, data: 1 }
      return String(args.name).endsWith(':expired')
        ? { success: true, data: null }
        : { success: true, data: JSON.stringify(['live.md', 'text/plain', 5, 1, 'indexed']) }
    }
    registerStashTransport(() => callTool)
    const src = createDecisionDocuments('sess-1', {
      owns: async () => true,
      userId: () => 'user-1',
    })
    const r = await withRunFrame({ inference: { tier: 'verda' } }, () =>
      src(new AbortController().signal),
    )
    expect(r.total).toBe(1)
    expect(ops.filter(([n]) => n === 'srem').map(([, a]) => a.value)).toEqual(['expired'])
  })
})
