/**
 * Helpers shared by the sandbox smoke scripts (`scripts/_shared.ts`).
 *
 * These run from a `tsx` CLI, so their contract is what gets printed and how a
 * missing rootfs image is surfaced. `console.log` is captured and `docker image
 * inspect` is spawned through a mocked `node:child_process`, so nothing here
 * needs a Docker engine.
 *
 * The two smoke entrypoints beside this helper (`smoke-scripted.ts`,
 * `smoke-llm.ts`) are deliberately not imported: each calls `main()` at module
 * scope against a live container (and, for smoke-llm, a live Anthropic key),
 * and exits the process on failure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PatternScope } from '../../../../lib/harness-patterns/types'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn, default: { spawn } }))

import { printEventSummary, checkRootfsImage } from '../../../../lib/sandbox/scripts/_shared'

/** Everything printed by the call under test, joined into one string. */
let printed: string[]

beforeEach(() => {
  printed = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(' '))
  })
  spawn.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

const out = () => printed.join('\n')

/** A pattern scope carrying a hand-built event log. */
const scopeWith = (events: unknown[]) => ({ events }) as unknown as PatternScope<unknown>

const TS = Date.UTC(2026, 7, 16, 12, 34, 56, 789)

describe('printEventSummary', () => {
  it('says so explicitly when nothing was tracked', () => {
    printEventSummary(scopeWith([]))
    expect(out()).toContain('(no events tracked)')
  })

  it('tolerates a scope with no event log at all', () => {
    printEventSummary({} as PatternScope<unknown>)
    expect(out()).toContain('(no events tracked)')
  })

  it('summarizes a controller action with its turn, tool and args', () => {
    printEventSummary(
      scopeWith([
        {
          type: 'controller_action',
          ts: TS,
          data: { turn: 2, action: { tool_name: 'sandbox_bash', tool_args: '{"command":"ls"}' } },
        },
      ]),
    )

    expect(out()).toContain('turn 2 actor → sandbox_bash({"command":"ls"})')
    expect(out()).toContain('12:34:56.789') // time-of-day, ms precision
  })

  it('truncates long tool args instead of flooding the terminal', () => {
    printEventSummary(
      scopeWith([
        {
          type: 'controller_action',
          ts: TS,
          data: { turn: 1, action: { tool_name: 't', tool_args: 'x'.repeat(500) } },
        },
      ]),
    )

    const line = printed.find((l) => l.includes('actor →'))!
    expect(line).toContain('…')
    expect(line.length).toBeLessThan(200)
  })

  it('marks a successful tool result and JSON-encodes its payload', () => {
    printEventSummary(
      scopeWith([
        {
          type: 'tool_result',
          ts: TS,
          data: { tool: 'sandbox_write', success: true, result: { ok: 1 } },
        },
      ]),
    )

    expect(out()).toContain('✓ sandbox_write → {"ok":1}')
  })

  it('prints a string result as-is rather than re-quoting it', () => {
    printEventSummary(
      scopeWith([
        {
          type: 'tool_result',
          ts: TS,
          data: { tool: 'sandbox_bash', success: true, result: '9\n' },
        },
      ]),
    )

    expect(out()).toContain('✓ sandbox_bash → 9')
    expect(out()).not.toContain('"9')
  })

  it('falls back to String() for a result JSON cannot encode', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    printEventSummary(
      scopeWith([
        { type: 'tool_result', ts: TS, data: { tool: 't', success: true, result: cyclic } },
      ]),
    )

    expect(out()).toContain('✓ t → [object Object]')
  })

  it('shows the error message for a failed tool result', () => {
    printEventSummary(
      scopeWith([
        {
          type: 'tool_result',
          ts: TS,
          data: { tool: 'sandbox_bash', success: false, error: 'exit 127' },
        },
      ]),
    )

    expect(out()).toContain('✗ sandbox_bash → exit 127')
  })

  it('falls back to a generic label for a failure with no message', () => {
    printEventSummary(
      scopeWith([{ type: 'tool_result', ts: TS, data: { tool: 't', success: false } }]),
    )

    expect(out()).toContain('✗ t → error')
  })

  it('renders the critic verdict, preferring the explanation over the suggestion', () => {
    printEventSummary(
      scopeWith([
        {
          type: 'critic_result',
          ts: TS,
          data: { result: { is_sufficient: true, explanation: 'got it' } },
        },
        {
          type: 'critic_result',
          ts: TS,
          data: { result: { is_sufficient: false, suggested_approach: 'run it' } },
        },
        { type: 'critic_result', ts: TS, data: { result: { is_sufficient: false } } },
      ]),
    )

    expect(out()).toContain('critic: OK — got it')
    expect(out()).toContain('critic: reject — run it')
    expect(out()).toContain('critic: reject — ')
  })

  it('surfaces error events', () => {
    printEventSummary(scopeWith([{ type: 'error', ts: TS, data: { error: 'boom' } }]))
    expect(out()).toContain('✗ ERROR: boom')
  })

  it('ignores event types outside the smoke scripts’ interest', () => {
    printEventSummary(
      scopeWith([
        { type: 'user_message', ts: TS, data: { content: 'hello' } },
        { type: 'pattern_enter', ts: TS, data: {} },
      ]),
    )

    expect(out()).not.toContain('hello')
    expect(out()).not.toContain('(no events tracked)') // the log was non-empty
  })
})

describe('checkRootfsImage', () => {
  /** Fake child process whose 'close'/'error' handler fires on the next tick. */
  function fakeChild(fire: (handlers: Record<string, (arg?: unknown) => void>) => void) {
    const handlers: Record<string, (arg?: unknown) => void> = {}
    queueMicrotask(() => fire(handlers))
    return { on: (ev: string, cb: (arg?: unknown) => void) => (handlers[ev] = cb) }
  }

  it('resolves when `docker image inspect` finds the base image', async () => {
    spawn.mockImplementation(() => fakeChild((h) => h.close?.(0)))

    await expect(checkRootfsImage()).resolves.toBeUndefined()
    expect(spawn).toHaveBeenCalledWith('docker', ['image', 'inspect', 'kg-sandbox:base'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
  })

  it('rejects with build instructions when the image is missing', async () => {
    spawn.mockImplementation(() => fakeChild((h) => h.close?.(1)))

    await expect(checkRootfsImage()).rejects.toThrow(/kg-sandbox:base image not found/)
    await expect(checkRootfsImage()).rejects.toThrow(/docker build -t kg-sandbox:base/)
  })

  it('propagates a spawn failure (docker CLI absent)', async () => {
    spawn.mockImplementation(() => fakeChild((h) => h.error?.(new Error('ENOENT docker'))))

    await expect(checkRootfsImage()).rejects.toThrow('ENOENT docker')
  })
})
