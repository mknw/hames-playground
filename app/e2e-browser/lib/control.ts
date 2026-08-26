/**
 * The worker side of the control plane — how a scenario drives the fakes.
 *
 * The fakes live in the runner's process (`backend.ts`); tests run in worker
 * processes. So every `fake.arm(...)` that `app/e2e/` writes as a method call
 * is an HTTP call here. Same vocabulary, same `FakeCall` records — deliberately
 * so, because a scenario in one layer should read like the same claim in the
 * other.
 */
import { readFileSync } from 'node:fs'
import { expect } from '@playwright/test'
import { HANDLES_FILE } from './env'
import type { FakeCall, Fault, HeldRequest } from '../../e2e/lib/fake-llm'
import type { FakeToolCall } from '../../e2e/lib/fake-gateway'

export type { FakeCall, Fault, HeldRequest }

/** What global setup parked for the workers. */
export interface Handles {
  appUrl: string
  controlUrl: string
}

export function readHandles(): Handles {
  try {
    return JSON.parse(readFileSync(HANDLES_FILE, 'utf8')) as Handles
  } catch (err) {
    throw new Error(
      `e2e-browser: could not read ${HANDLES_FILE} — global setup did not complete. ` +
        `Run the suite through \`pnpm test:e2e:browser\`. (${
          err instanceof Error ? err.message : String(err)
        })`,
    )
  }
}

export class FakeBackend {
  constructor(private readonly controlUrl: string) {}

  /** Every request the fake endpoint served since the last reset, oldest
   *  first. The `model` field is the ONLY reliable witness of which tier a
   *  call took — a scenario never asserts on the preference it just set. */
  async calls(): Promise<FakeCall[]> {
    return (await this.get<{ calls: FakeCall[] }>('/calls')).calls
  }

  /** Every MCP tool call the fake gateway served. */
  async toolCalls(): Promise<FakeToolCall[]> {
    return (await this.get<{ calls: FakeToolCall[] }>('/tool-calls')).calls
  }

  /** Disarm faults and clear recorded calls. Every scenario starts here. */
  async reset(): Promise<void> {
    await this.post('/reset')
  }

  /** Arm one fault shape (`cold-start`, `hold`, `status`, `mid-stream`).
   *  Replaces any previously armed one; see `e2e/lib/fake-llm.ts` for the
   *  table. */
  async arm(fault: Fault): Promise<void> {
    await this.post('/arm', fault)
  }

  /**
   * Requests currently PARKED by a `hold` fault, oldest first.
   *
   * The evidence a browser scenario wants when its claim is "the turn is still
   * running": a parked request has arrived AND has not been answered, so the turn
   * demonstrably cannot advance past it. `calls()` cannot say that — a call is
   * recorded only once the fake has answered it, so by the time it appears the
   * turn has already moved on. That difference is what both #280 browser flakes
   * were made of.
   */
  async held(): Promise<HeldRequest[]> {
    return (await this.get<{ held: HeldRequest[] }>('/held')).held
  }

  /** Stop applying the armed fault to NEW requests, keeping recorded calls and
   *  anything already parked. `reset()` would also throw the calls away, which a
   *  scenario mid-assertion usually still needs. */
  async disarm(): Promise<void> {
    await this.post('/disarm')
  }

  /** Let parked requests answer, oldest first; `count` omitted releases all.
   *  Returns how many were released. */
  async release(count?: number): Promise<number> {
    const response = await fetch(`${this.controlUrl}/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(count === undefined ? {} : { count }),
    })
    if (!response.ok) throw new Error(`control /release: HTTP ${response.status}`)
    return ((await response.json()) as { released: number }).released
  }

  /** Stop accepting connections entirely — the "endpoint is down" case, which
   *  a status code cannot model because a refused TCP connect fails in a
   *  different layer of the client than an HTTP error does. */
  async down(): Promise<void> {
    await this.post('/down')
  }

  /** Bring a downed endpoint back on the same port. ALWAYS pair this with
   *  `down()` in a `finally`: the fake is shared by the whole run, so a
   *  scenario that left it down would take every later one with it. */
  async up(): Promise<void> {
    await this.post('/up')
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.controlUrl}${path}`)
    if (!response.ok) throw new Error(`control ${path}: HTTP ${response.status}`)
    return (await response.json()) as T
  }

  private async post(path: string, body?: unknown): Promise<void> {
    const response = await fetch(`${this.controlUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    if (!response.ok) throw new Error(`control ${path}: HTTP ${response.status}`)
  }
}

/**
 * Wait until the PARKED requests satisfy `predicate`, then hand them back.
 *
 * The synchronisation primitive the browser layer was missing (#280). Two things
 * make it different from polling `calls()`:
 *
 *  - a parked request proves the turn REACHED this call and has not got past it,
 *    where a recorded call proves only that the turn has already moved on;
 *  - once the predicate holds, every assertion that follows is about a turn that
 *    cannot advance — so "the notice retracted while the turn was still running"
 *    and "the reopened thread holds one reply" stop being races against a
 *    duration and become facts the test established.
 *
 * `expect.poll` rather than a hand-rolled loop: it inherits the project's expect
 * timeout and puts `message` in the failure, which is where a scenario says what
 * the app failed to do rather than "timed out".
 */
export async function expectHeld(
  backend: FakeBackend,
  predicate: (held: HeldRequest[]) => boolean,
  message: string,
): Promise<HeldRequest[]> {
  await expect.poll(async () => predicate(await backend.held()), { message }).toBe(true)
  return backend.held()
}
