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
import { HANDLES_FILE } from './env'
import type { FakeCall, Fault } from '../../e2e/lib/fake-llm'
import type { FakeToolCall } from '../../e2e/lib/fake-gateway'

export type { FakeCall, Fault }

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

  /** Arm one fault shape (`cold-start`, `status`, `mid-stream`). Replaces any
   *  previously armed one; see `e2e/lib/fake-llm.ts` for the table. */
  async arm(fault: Fault): Promise<void> {
    await this.post('/arm', fault)
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
