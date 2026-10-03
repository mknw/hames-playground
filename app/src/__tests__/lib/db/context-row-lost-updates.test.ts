// The composition root registers the harness client seam (tier policy, model
// tables); the turn runner asserts its tier through it.
import '../../../lib/inference/config.server'
/**
 * Lost updates on the conversation's `context` row (#458), reproduced through
 * the real turn runner against a real Postgres.
 *
 * Everything that decides what lands in the row is real: `runTurnAndPersist`,
 * the session layer, the repository, the harness and `compactBulkData`. Only
 * what would leave the process is faked — the agent's patterns (one pattern
 * that "calls a tool" and answers), the describe-tier summarizer, the title
 * agent and the tier lookup. Each fake can be held at a gate, which is how a
 * test puts two writers in flight at once in a known order.
 *
 * The invariant every case asserts is the same, and it is stated from the
 * user's side rather than the code's: **a write that reported success is in
 * the row at the end.** A turn that resolved is a turn the user was shown; a
 * flag flip that returned true is one the user was told about. Losing either
 * silently is the defect. Refusing one visibly is not.
 *
 * DB-backed: skips locally without a database, and runs in CI's
 * `test · postgres`, which fails on a skip.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { skipWithoutDatabase } from '../../test-database'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import {
  configurePattern,
  createEvent,
  deserializeContext,
  enrichToolResult,
  serializeContext,
  type ConfiguredPattern,
  type ContextEvent,
  type DescribeBatchItem,
  type ToolResultEventData,
} from '@hames-ai/harness-patterns'

// ── Gates: hold a fake at a known point until the test lets it go ───────────

interface Gate {
  /** Resolves once the gated call has started. */
  entered: Promise<void>
  /** Lets the gated call continue. */
  release: () => void
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

function makeGate(): Gate & { enter: () => void; wait: Promise<void> } {
  const entered = deferred()
  const released = deferred()
  return {
    entered: entered.promise,
    enter: entered.resolve,
    release: released.resolve,
    wait: released.promise,
  }
}

/** Turn gates, keyed by the message the turn was sent. */
const turnGates = new Map<string, ReturnType<typeof makeGate>>()
/** Summary gates, keyed by the raw tool result being summarized. */
const summaryGates = new Map<string, ReturnType<typeof makeGate>>()

function gateTurn(message: string): Gate {
  const gate = makeGate()
  turnGates.set(message, gate)
  return gate
}

function gateSummary(message: string): Gate {
  const gate = makeGate()
  summaryGates.set(rawResult(message), gate)
  return gate
}

const rawResult = (message: string) => `raw:${message}`

// ── The fake agent: one pattern that calls a "tool" and answers ─────────────

type Data = Record<string, unknown>

const fakeTurn: ConfiguredPattern<Data> = configurePattern<Data>(
  'fake-turn',
  async (scope, view) => {
    const messages = view.fromAll().ofType('user_message').get()
    const message = String((messages.at(-1)?.data as { content?: string }).content)
    const gate = turnGates.get(message)
    if (gate) {
      gate.enter()
      await gate.wait
    }
    scope.events.push(
      createEvent('tool_result', scope.id, {
        callId: `call-${message}`,
        tool: 'lookup',
        result: rawResult(message),
        success: true,
      } satisfies ToolResultEventData),
      createEvent('assistant_message', scope.id, { content: `answer:${message}` }),
    )
    return scope
  },
  { patternId: 'fake-turn' },
)

vi.mock('../../../lib/harness-client/registry.server', () => ({
  canonicalAgentId: (id: string) => id,
  getAgent: () => ({ id: 'fake', createPatterns: async () => [fakeTurn] }),
}))

// ── The summarizer: returns a summary, unless its gate holds it ─────────────

async function fakeDescribe(
  _tool: string,
  _args: string,
  _reasoning: string,
  result: string,
): Promise<string> {
  const gate = summaryGates.get(result)
  if (gate) {
    gate.enter()
    await gate.wait
  }
  return `summary of ${result}`
}

vi.mock('@hames-ai/harness-baml', () => ({
  bamlPatterns: () => ({
    describe: fakeDescribe,
    describeBatch: async (batch: DescribeBatchItem[]) => {
      const out = new Map<string, string>()
      for (const item of batch) out.set(item.id, await fakeDescribe('', '', '', item.result))
      return out
    },
  }),
}))

vi.mock('../../../lib/inference/tier.server', () => ({
  resolveConversationTier: async () => 'anthropic',
}))
vi.mock('../../../lib/metrics/usage-recorder.server', () => ({ recordTurn: () => {} }))
vi.mock('@hames-ai/agents/agents/title-generator.server', () => ({
  runFirstTurnTitleGen: async () => null,
}))

const { runTurnAndPersist } = await import('../../../lib/harness-client/turn.server')
const { seedActionRow, runAgentInBackground } =
  await import('../../../lib/harness-client/action-runner.server')
const { loadConversation, updateConversationContextIfUnchanged } =
  await import('../../../lib/db/conversations.server')
const { closePool, query } = await import('../../../lib/db/client.server')

const USER = `lost-upd-${Math.random().toString(36).slice(2, 10)}`
const newId = () => `lost-upd-${Math.random().toString(36).slice(2, 12)}`

let dbAvailable = true

beforeAll(async () => {
  try {
    await query('SELECT 1')
  } catch (err) {
    dbAvailable = false
    console.warn('[context-row-lost-updates.test] Postgres unreachable, skipping:', err)
  }
})

afterAll(async () => {
  if (!dbAvailable) return
  await query('DELETE FROM conversations WHERE user_id = $1', [USER])
  await closePool()
})

beforeEach((ctx) => {
  skipWithoutDatabase(ctx, dbAvailable)
  turnGates.clear()
  summaryGates.clear()
})

// ── Reading the row ─────────────────────────────────────────────────────────

async function rowEvents(id: string): Promise<ContextEvent[]> {
  const row = await loadConversation(id, USER)
  if (!row) throw new Error(`no row for ${id}`)
  return deserializeContext(row.serializedContext).events
}

const userMessages = (events: ContextEvent[]) =>
  events
    .filter((e) => e.type === 'user_message')
    .map((e) => (e.data as { content: string }).content)

function toolResultFor(events: ContextEvent[], message: string): ToolResultEventData | undefined {
  return events
    .filter((e) => e.type === 'tool_result')
    .map((e) => e.data as ToolResultEventData)
    .find((d) => d.result === rawResult(message))
}

/** A fuse, not a deadline: every condition polled here is one the code under
 *  test reaches in milliseconds when it works. */
async function waitFor(what: string, check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Block until a turn's detached summary pass has persisted its summary. */
const summaryLanded = (id: string, message: string) =>
  waitFor(`the summary of "${message}" in ${id}`, async () => {
    return !!toolResultFor(await rowEvents(id), message)?.summary
  })

function turn(sessionId: string, message: string) {
  return runTurnAndPersist({
    mode: 'interactive',
    sessionId,
    userId: USER,
    agentId: 'fake',
    message,
  })
}

/** A settled outcome, so a rejected turn is data rather than a test failure. */
const settle = <T>(p: Promise<T>) =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  )

// ════════════════════════════════════════════════════════════════════════════

describe('the summary pass and the next turn', () => {
  // Claim 1+2 of #458: `compactAndSave` is detached and writes the whole blob
  // it summarized. When it outlasts the next turn, that write replaces the
  // next turn's events with the context of the turn before.
  it('a slow summary pass does not overwrite the turn that came after it', async () => {
    const id = newId()
    const slowSummary = gateSummary('first')

    await turn(id, 'first')
    // Turn 1 has answered, and its detached summary pass is now in flight.
    await slowSummary.entered

    // Turn 2 runs start to finish while that pass is still out.
    await turn(id, 'second')
    await summaryLanded(id, 'second')

    // Now the slow pass finishes.
    slowSummary.release()
    await summaryLanded(id, 'first')

    const events = await rowEvents(id)
    // The turn the user was shown is still there…
    expect(userMessages(events)).toEqual(['first', 'second'])
    expect(toolResultFor(events, 'second')).toBeDefined()
    // …and the slow pass still delivered what it was for, onto the newer row.
    expect(toolResultFor(events, 'first')?.summary).toBe(`summary of ${rawResult('first')}`)
    expect(toolResultFor(events, 'second')?.summary).toBe(`summary of ${rawResult('second')}`)
  })
})

describe('two turns on one conversation at once', () => {
  // Claim 3 of #458: nothing stops a second turn (a second tab, a double
  // submit) from running on a conversation while one is in flight, and the
  // end-of-turn save is last-writer-wins — so only the later save survives.
  it('keeps every turn that reported success, and refuses the second visibly', async () => {
    const id = newId()
    await turn(id, 'seed')
    await summaryLanded(id, 'seed')

    const gateA = gateTurn('A')
    const turnA = settle(turn(id, 'A'))
    await gateA.entered

    // Turn B arrives while A is mid-flight, and is allowed to finish first.
    const outcomeB = await settle(turn(id, 'B'))

    gateA.release()
    const outcomeA = await turnA
    expect(outcomeA.ok).toBe(true)
    await summaryLanded(id, 'A')

    const persisted = userMessages(await rowEvents(id))
    // The lost update: every turn that resolved must be in the row.
    expect(persisted).toContain('A')
    if (outcomeB.ok) expect(persisted).toContain('B')

    // The coordinator's call: the second turn is refused, and says why.
    expect(outcomeB.ok).toBe(false)
    expect(String((outcomeB as { error: unknown }).error)).toMatch(
      /turn is still running in this conversation/,
    )
  })

  // Triggered runs (routines, POST /api/agents/:id) write the same row: a user
  // who opens a running action and sends a message is a second turn on it.
  it('refuses a chat turn on an action row while its triggered run is in flight', async () => {
    const runId = newId()
    const trigger = { transcribedCommand: 'T', shortDescription: 'a triggered run' }
    const claim = await seedActionRow(runId, USER, 'fake', trigger)

    const gateT = gateTurn('T')
    const background = runAgentInBackground(runId, USER, 'T', 'fake', trigger, claim)
    await gateT.entered

    const chat = await settle(turn(runId, 'I'))

    gateT.release()
    await background
    await summaryLanded(runId, 'T')

    const persisted = userMessages(await rowEvents(runId))
    expect(persisted).toContain('T')
    if (chat.ok) expect(persisted).toContain('I')

    expect(chat.ok).toBe(false)
    expect(String((chat as { error: unknown }).error)).toMatch(
      /turn is still running in this conversation/,
    )
  })
})

describe('a flag flip while a turn runs', () => {
  // The research comment's row 1: the stash route's version check protects
  // the FLAG's writer, but a turn already running when the flag lands saves
  // over it — and the user was told the flip succeeded.
  it('is never reported as saved and then silently overwritten by the turn', async () => {
    const id = newId()
    await turn(id, 'seed')
    await summaryLanded(id, 'seed')
    const seedResult = (await rowEvents(id)).find(
      (e) =>
        e.type === 'tool_result' && (e.data as ToolResultEventData).result === rawResult('seed'),
    )!

    const gateA = gateTurn('A')
    const turnA = turn(id, 'A')
    await gateA.entered

    // Exactly what `/api/stash` does: read, flip one flag, write at that read.
    const read = (await loadConversation(id, USER))!
    const ctx = deserializeContext(read.serializedContext)
    enrichToolResult(ctx, seedResult.id!, { hidden: true })
    const flipped = await updateConversationContextIfUnchanged(
      id,
      USER,
      serializeContext(ctx),
      read.version,
    )

    gateA.release()
    await turnA
    await summaryLanded(id, 'A')

    const events = await rowEvents(id)
    if (flipped) expect(toolResultFor(events, 'seed')?.hidden).toBe(true)
    // While a turn holds the conversation, it is the only writer.
    expect(flipped).toBe(false)
    expect(userMessages(events)).toEqual(['seed', 'A'])
  })
})
