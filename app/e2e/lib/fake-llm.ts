/**
 * A fake OpenAI-compatible inference endpoint, with faults on demand.
 *
 * This is what makes the hermetic mode hermetic. It speaks the same wire
 * protocol as the self-hosted vLLM deployment (`POST /v1/chat/completions`,
 * `GET /v1/models`), so the app reaches it through the SHIPPED seam — the
 * `VerdaQwen` client's `base_url env.VERDA_INFERENCE_ENDPOINT` for the verda
 * tier, and a test-only `ClientRegistry` primary for the anthropic tier
 * (`baml-route.ts` explains why the two halves differ).
 *
 * ## What it answers with
 *
 * Nothing here grades or generates prose. Each BAML function gets the smallest
 * reply that PARSES into its declared output type, so a scenario's assertions
 * are about the app path — did a turn complete, did the row persist, did the
 * second turn see the first — and never about model quality. That is the
 * evals' division of labour (`app/evals/README.md`) held from the other side:
 * the evals point real workflows at a real client, this suite points the real
 * app at a client that cannot vary.
 *
 * Replies are computed from the request, not from stored per-conversation
 * state, which is what lets two conversations run CONCURRENTLY through one
 * fake without interfering (scenario 3). The controller's turn number is read
 * out of simpleLoop's own spine (`Turn N. Decide the next action.`), so the
 * loop terminates after exactly one tool call whatever order the requests
 * arrive in.
 *
 * ## Faults
 *
 * `arm({ … })` injects one of the failure shapes the preview cares about. They
 * are set per scenario and cleared by `reset()`:
 *
 * | shape        | what the socket sees                                          |
 * | ------------ | ------------------------------------------------------------- |
 * | `cold-start` | nothing at all for N ms, then a normal 200                    |
 * |              | (on the private tier the WAKE PING is what absorbs this)      |
 * | `status`     | an immediate 4xx/5xx with an OpenAI-shaped error body         |
 * | `mid-stream` | 200, headers, half the body, then the connection destroyed    |
 *
 * Three, and every one of them is armed by a scenario. A `trickle` shape (a
 * complete body delivered in small delayed chunks) was here and is gone: it
 * worked, nothing asserted on it, and a fault table advertising an affordance
 * no scenario uses reads as coverage that does not exist. `cold-start` already
 * covers "slow" and `mid-stream` covers "truncated"; add it back when an
 * assertion needs the difference.
 *
 * A fault carries an optional `model` filter so a scenario can make ONE tier
 * cold while the other stays warm — which is the only way to tell "the app
 * survived a cold start" apart from "the app was slow everywhere".
 *
 * ## One rule that is always enforced: vLLM's message ordering
 *
 * Requests for the self-hosted model are additionally held to the constraint
 * the real deployment enforces — `system` first, or `400 System message must
 * be at the beginning.` Requests for the anthropic-tier model are not, which
 * models the provider asymmetry exactly: Anthropic lifts the LEADING system
 * block into its own field and silently rewrites the rest to `user`, so an
 * illegal ordering is invisible for as long as a function only ever runs there.
 *
 * That asymmetry is not a curiosity, it is the shape of #263: `ActorController`
 * carried two late system blocks, its first attempt passed and every RETRY
 * 400'd, and actorCritic was dead on the self-hosted route with nothing red.
 * `prompt-role-order.test.ts` pins the thirteen TEMPLATES; this pins what a
 * running turn actually put on the wire, which is the half a template audit
 * cannot see.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  classifyPrompt,
  promptText,
  type BamlFunctionName,
  type ChatMessage,
} from './baml-functions'
import { VERDA_MODEL } from './mode'
// The wake ping's message text, imported rather than copied: this fake
// hard-fails on a prompt it cannot classify, so a drift between the constant and
// the literal here would turn every private-tier turn into a 400 from the fake
// and read like an app bug.
import { VERDA_WAKE_PROMPT } from '../../src/lib/inference/wake.server'

// ============================================================================
// Recorded traffic
// ============================================================================

/** One request the fake served, as scenarios read it back. */
export interface FakeCall {
  /** Wall-clock ms since the fake started, for ordering and latency reads. */
  at: number
  /** The `model` field on the request body — the ONLY reliable witness of
   *  which client (and therefore which tier) a call was routed through. */
  model: string
  /** The BAML function, recovered by `classifyPrompt`. */
  fn: BamlFunctionName | null
  /** The flattened prompt, so a scenario can assert on what the model saw
   *  (e.g. that turn 3 carried turn 1's answer in its history). */
  prompt: string
  /** How the fake answered: a normal reply, the wake ping, or the fault it
   *  injected. `wake` is its own outcome so a scenario can assert that the box
   *  was woken by the wake request rather than by a real call. */
  outcome: 'ok' | 'wake' | 'unrecognised' | 'status' | 'mid-stream' | 'bad-role-order'
  /** Milliseconds the fake deliberately withheld the response. */
  delayedMs: number
}

// ============================================================================
// Faults
// ============================================================================

export type Fault =
  /** Withhold the response for `ms`, then answer normally. Models the
   *  scale-to-zero endpoint's multi-minute first call. */
  | { kind: 'cold-start'; ms: number; model?: string; times?: number }
  /** Answer with an HTTP error. `400` is what vLLM returns for a malformed or
   *  unsupported request — the shape that killed `ActorController` retries on
   *  the real deployment before #263's system-message fix. */
  | { kind: 'status'; status: number; message?: string; model?: string; times?: number }
  /** Send headers and a truncated body, then destroy the socket. */
  | { kind: 'mid-stream'; model?: string; times?: number }

/** A fault applies to a request when the model matches (or no filter is set)
 *  and it has not already been spent `times` times. */
interface ArmedFault {
  fault: Fault
  remaining: number
}

// ============================================================================
// The server
// ============================================================================

export interface FakeLlm {
  /** `http://127.0.0.1:<port>/v1` — the OpenAI-compatible base. */
  readonly baseUrl: string
  readonly port: number
  /** Every request served, oldest first. */
  readonly calls: readonly FakeCall[]
  /** Arm a fault. Replaces any previously armed one. */
  arm(fault: Fault): void
  /** Disarm faults and clear recorded calls. Called between scenarios. */
  reset(): void
  /** Stop accepting connections entirely — the "endpoint is down" case, which
   *  a status code cannot model because a refused TCP connect fails in a
   *  different layer of the client than an HTTP error does. Also the only
   *  teardown there is: the fake is a process-wide singleton (see
   *  `app.ts#bootApp`), so nothing may close it for good while other scenario
   *  files are still to run, and process exit is what reclaims the port. */
  goDown(): Promise<void>
  /** Bring a downed endpoint back on the SAME port. */
  comeBack(): Promise<void>
}

export async function startFakeLlm(port = 0): Promise<FakeLlm> {
  const calls: FakeCall[] = []
  let armed: ArmedFault | null = null
  let server: http.Server | null = null
  let boundPort = port
  const startedAt = Date.now()

  const handler: http.RequestListener = (req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      // The Verda smoke script re-reads the served model id from here rather
      // than trusting the client declaration; the preflight does the same, so
      // the fake has to answer it.
      json(res, 200, {
        object: 'list',
        data: [{ id: 'Qwen/Qwen3.8-27B-FP8', object: 'model' }],
      })
      return
    }
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
      json(res, 404, { error: { message: `no fake route for ${req.method} ${req.url}` } })
      return
    }

    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      void serve(raw, res)
    })
  }

  async function serve(raw: string, res: http.ServerResponse): Promise<void> {
    let body: { model?: string; messages?: ChatMessage[]; max_tokens?: number }
    try {
      body = JSON.parse(raw || '{}') as {
        model?: string
        messages?: ChatMessage[]
        max_tokens?: number
      }
    } catch {
      json(res, 400, { error: { message: 'fake-llm: request body was not JSON' } })
      return
    }
    const model = body.model ?? '(no model)'
    const prompt = promptText(body.messages ?? [])
    const fn = classifyPrompt(prompt)

    const record = (outcome: FakeCall['outcome'], delayedMs: number): void => {
      calls.push({ at: Date.now() - startedAt, model, fn, prompt, outcome, delayedMs })
    }

    // THE WAKE PING is not a BAML call, so the two checks below do not apply to
    // it — it has no output type to satisfy and only one message. Everything
    // AFTER them does apply, deliberately and by falling through rather than by a
    // branch of its own: the wake is the request that pays the cold start on a
    // private-tier turn, so a scenario arming `cold-start` must see it land here,
    // and a scenario arming `status` or `mid-stream` must be able to break the
    // wake itself. A separate early-return branch was the first version of this
    // and it silently swallowed the mid-stream fault — the ping consumed the
    // armed fault and answered 200, so the fault never reached the call the
    // scenario meant to break, and nothing was red.
    const wake = isWakePing(prompt, body)

    // An unrecognised prompt is a HARD failure, never a guess. A canned reply
    // for the wrong output type would surface three layers away as a
    // BamlValidationError and read like an app bug.
    if (!wake && !fn) {
      record('unrecognised', 0)
      json(res, 400, {
        error: {
          message:
            'fake-llm: no BAML function matched this prompt. Either a prompt in baml_src/ ' +
            'moved its first system line, or a new function was added — update MARKERS in ' +
            'e2e/lib/baml-functions.ts. First 200 chars: ' +
            JSON.stringify(prompt.slice(0, 200)),
        },
      })
      return
    }

    // vLLM's ordering rule, enforced only for the self-hosted model — see the
    // header. Checked BEFORE any injected fault, so a scenario that also armed
    // a cold start still gets the 400 production would give it.
    if (!wake && model === VERDA_MODEL && hasLateSystemMessage(body.messages ?? [])) {
      record('bad-role-order', 0)
      json(res, 400, {
        object: 'error',
        message: 'System message must be at the beginning.',
        type: 'BadRequestError',
        code: 400,
      })
      return
    }

    const fault = takeFault(model)

    if (fault?.kind === 'status') {
      record('status', 0)
      json(res, fault.status, {
        error: {
          message: fault.message ?? `fake-llm: injected HTTP ${fault.status}`,
          type: 'invalid_request_error',
        },
      })
      return
    }

    let delayedMs = 0
    if (fault?.kind === 'cold-start') {
      delayedMs = fault.ms
      await sleep(fault.ms)
    }

    // `fn` is non-null for everything but the wake ping, which the `!wake` guard
    // above let through — it wants a token, not a parseable envelope.
    const payload = JSON.stringify(completion(model, wake ? 'ok' : replyFor(fn!, prompt)))

    if (fault?.kind === 'mid-stream') {
      record('mid-stream', delayedMs)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' })
      res.write(payload.slice(0, Math.max(1, Math.floor(payload.length / 2))))
      // No `end()`: tear the socket down so the client sees a truncated body
      // rather than a clean error. This is the shape a dropped GPU box gives.
      res.socket?.destroy()
      return
    }

    record(wake ? 'wake' : 'ok', delayedMs)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(payload)
  }

  function takeFault(model: string): Fault | null {
    if (!armed) return null
    if (armed.fault.model && armed.fault.model !== model) return null
    if (armed.remaining <= 0) return null
    armed.remaining -= 1
    return armed.fault
  }

  async function listen(): Promise<void> {
    server = http.createServer(handler)
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(boundPort, '127.0.0.1', () => resolve())
    })
    boundPort = (server!.address() as AddressInfo).port
  }

  await listen()

  return {
    get baseUrl() {
      return `http://127.0.0.1:${boundPort}/v1`
    },
    get port() {
      return boundPort
    },
    get calls() {
      return calls
    },
    arm(fault: Fault) {
      armed = { fault, remaining: fault.times ?? Number.MAX_SAFE_INTEGER }
    },
    reset() {
      armed = null
      calls.length = 0
    },
    async goDown() {
      if (!server) return
      const s = server
      server = null
      // Sockets first, THEN close. `close()` stops new connections and waits
      // for live ones to end on their own, so a keep-alive connection the BAML
      // client is holding would make this await until the client gave up —
      // which is the shape of an intermittent hang, not a fast "endpoint is
      // down".
      s.closeAllConnections?.()
      await new Promise<void>((resolve) => s.close(() => resolve()))
    },
    async comeBack() {
      if (server) return
      await listen()
    },
  }
}

// ============================================================================
// Canned replies
// ============================================================================

/** Marker every fake answer carries, so a scenario can prove an assistant
 *  message came from the fake rather than from a real provider. */
export const FAKE_ANSWER_MARK = 'E2E-FAKE-ANSWER'

/** The tool call the fake controller makes on turn 0, before returning. */
export const FAKE_TOOL_ARGS = '{"query":"MATCH (n) RETURN count(n) AS n"}'

/**
 * The reply body for one function — a JSON envelope for the class-returning
 * functions, bare text for the four that return `string`.
 *
 * The controller branch is the only stateful-looking one, and it is not
 * stateful: simpleLoop renders `Turn N. Decide the next action.` into every
 * prompt, so "call a tool on turn 0, Return on every later turn" is a pure
 * function of the request. That is what makes concurrent conversations safe.
 */
function replyFor(fn: BamlFunctionName, prompt: string): string {
  switch (fn) {
    case 'Router':
      return JSON.stringify({
        intent: 'e2e intent: count the nodes',
        needs_tool: true,
        route: pickRoute(prompt),
        response: 'Routing to the graph.',
      })

    case 'LoopController': {
      const turn = readTurn(prompt)
      if (turn > 0) {
        return JSON.stringify({
          reasoning: 'The tool already returned what was asked for.',
          tool_name: 'Return',
          tool_args: `${FAKE_ANSWER_MARK}: the graph reports 42 nodes.`,
          is_final: true,
        })
      }
      return JSON.stringify({
        reasoning: 'Query the graph for a node count.',
        tool_name: pickTool(prompt),
        tool_args: FAKE_TOOL_ARGS,
        status: 'Querying the graph',
        is_final: false,
      })
    }

    case 'ActorController':
      return JSON.stringify({
        reasoning: 'Propose the one call that answers the intent.',
        tool_name: pickTool(prompt),
        tool_args: FAKE_TOOL_ARGS,
        status: 'Querying the graph',
        is_final: true,
      })

    case 'Critic':
      return JSON.stringify({
        is_sufficient: true,
        explanation: 'The attempt answers the intent.',
      })

    case 'Planner':
      return JSON.stringify({
        reasoning: 'One lookup is enough.',
        plan: '1. Query the graph for a node count.',
        n_steps: 1,
      })

    case 'ReferenceSelector':
      // Deliberately selects nothing: attaching prior results is a behaviour
      // with its own tests, and a scenario about conversation flow should not
      // depend on it firing.
      return JSON.stringify({ reasoning: 'Nothing prior applies.', selected: [] })

    case 'ScreenUntrustedContent':
      return JSON.stringify({ injection_detected: false, reason: 'Clean.', spans: [] })

    case 'ResultDescribeBatch':
      return JSON.stringify({
        summaries: readBatchIds(prompt).map((id) => ({
          id,
          summary: 'The call returned a node count.',
        })),
      })

    case 'Synthesize':
      return `${FAKE_ANSWER_MARK}: the graph reports 42 nodes.`

    case 'ResultDescribe':
      return 'The call returned a node count.'

    case 'CompactIntent':
      return 'e2e intent: count the nodes'

    case 'RetrieveQuery':
      return 'node count'

    case 'GenerateConversationTitle':
      return 'E2E Fake Conversation'
  }
}

/** simpleLoop's own turn counter, or 0 when the spine is not present. */
function readTurn(prompt: string): number {
  const m = /Turn (\d+)\. Decide the next action\./.exec(prompt)
  return m ? Number.parseInt(m[1], 10) : 0
}

/** The first offered tool that is not the loop's synthetic `Return`. */
function pickTool(prompt: string): string {
  const names = [...prompt.matchAll(/^- ([A-Za-z0-9_-]+):/gm)].map((m) => m[1])
  return names.find((n) => n !== 'Return') ?? 'Return'
}

/** The route the router picks: `neo4j` when offered (the search agent's
 *  unguarded route, so a flow scenario is not also an injection-guard
 *  scenario), else whatever is first. */
function pickRoute(prompt: string): string {
  const block = prompt.slice(prompt.indexOf('AVAILABLE ROUTES:'))
  const names = [...block.matchAll(/^- ([A-Za-z0-9_-]+):/gm)].map((m) => m[1])
  return names.includes('neo4j') ? 'neo4j' : (names[0] ?? 'neo4j')
}

/** The caller-assigned ids in a describe batch — echoed back verbatim, which
 *  is the contract `compactBulkData` matches summaries on. */
function readBatchIds(prompt: string): string[] {
  return [...prompt.matchAll(/--- ITEM id=([^\s-]+) ---/g)].map((m) => m[1])
}

// ============================================================================
// Wire helpers
// ============================================================================

function completion(model: string, content: string): unknown {
  return {
    id: 'e2e-fake-completion',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

/**
 * True for the wake ping: one user message carrying the fixed literal, asking
 * for a single token.
 *
 * Matched on THREE fields rather than on the content alone. A scenario's own
 * prompt could contain the word by accident, and the ping's whole identity is
 * "a request that generates nothing" — so `max_tokens` and the single-message
 * shape are part of what it is, not incidental.
 */
function isWakePing(
  prompt: string,
  body: { max_tokens?: number; messages?: ChatMessage[] },
): boolean {
  return (
    body.max_tokens === 1 &&
    (body.messages ?? []).length === 1 &&
    prompt.trim() === VERDA_WAKE_PROMPT
  )
}

/** True when a `system` message follows a non-system one — the ordering vLLM
 *  rejects outright and Anthropic silently rewrites. */
function hasLateSystemMessage(messages: readonly ChatMessage[]): boolean {
  let seenNonSystem = false
  for (const message of messages) {
    if (message.role === 'system') {
      if (seenNonSystem) return true
    } else {
      seenNonSystem = true
    }
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
