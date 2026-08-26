/**
 * The fake backend, and the control plane that lets a test in another process
 * drive it.
 *
 * ## What is reused, and why none of it is copied
 *
 * The two fakes are `app/e2e/lib/fake-llm.ts` and `app/e2e/lib/fake-gateway.ts`
 * verbatim — the same OpenAI-compatible endpoint that answers each BAML
 * function with the smallest reply that parses into its declared output type,
 * and the same minimal MCP streamable-HTTP server. A second implementation of
 * either would be a second thing to keep in step with `baml_src/`, and the
 * first time the two drifted the browser layer would be testing a protocol the
 * app-path layer had already moved off.
 *
 * That import is the one direction this suite takes on `app/e2e/`, and it is
 * deliberately narrow: the fakes only. Nothing here imports `e2e/lib/app.ts`
 * (which boots app modules in-process — the opposite of what this layer is
 * for) or `e2e/lib/baml-route.ts` (whose registry cannot reach another
 * process; `src/lib/inference/dev-fake-inference.server.ts` is this layer's
 * equivalent, and its header says why it has to live in `src/`).
 *
 * ## Why a control plane
 *
 * Playwright runs tests in worker processes. The fakes live here, in the
 * runner's process, because the DEV SERVER has to be able to reach one fixed
 * address for the whole run. So `fake.arm()` — a plain method call in
 * `app/e2e/` — becomes an HTTP call from the worker. The surface is small on
 * purpose: arm a fault, take the endpoint down, bring it back, read what was
 * served, reset. Anything a scenario wants to assert about the wire it asserts
 * on `/calls`, which is the same `FakeCall` records the app-path suite reads.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { startFakeLlm, type FakeCall, type FakeLlm, type Fault } from '../../e2e/lib/fake-llm'
import { startFakeGateway, type FakeGateway } from '../../e2e/lib/fake-gateway'
import { FAKE_ANTHROPIC_TIER_MODEL } from './env'
import { setStoredTier } from './db'

export interface Backend {
  readonly llm: FakeLlm
  readonly gateway: FakeGateway
  /** `http://127.0.0.1:<port>` — what a worker drives the fakes through. */
  readonly controlUrl: string
  stop(): Promise<void>
}

export async function startBackend(): Promise<Backend> {
  const gateway = await startFakeGateway()
  const llm = await startFakeLlm()

  const control = http.createServer((req, res) => {
    void handle(req, res)
  })

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://control.invalid')
    const body = req.method === 'POST' ? await readJson(req) : {}

    switch (`${req.method} ${url.pathname}`) {
      case 'GET /calls':
        return json(res, 200, { calls: llm.calls })
      case 'GET /tool-calls':
        return json(res, 200, { calls: gateway.toolCalls })
      case 'POST /reset':
        llm.reset()
        gateway.reset()
        return json(res, 200, { ok: true })
      case 'POST /arm':
        llm.arm(body as unknown as Fault)
        return json(res, 200, { ok: true })
      case 'POST /down':
        await llm.goDown()
        return json(res, 200, { ok: true })
      case 'POST /up':
        await llm.comeBack()
        return json(res, 200, { ok: true })
      case 'POST /tool-error': {
        const { tool, message } = body as { tool?: string; message?: string }
        if (!tool) return json(res, 400, { error: 'tool is required' })
        gateway.setError(tool, message ?? 'e2e-browser: injected tool failure')
        return json(res, 200, { ok: true })
      }
      default:
        return json(res, 404, { error: `no control route for ${req.method} ${url.pathname}` })
    }
  }

  await new Promise<void>((resolve, reject) => {
    control.once('error', reject)
    control.listen(0, '127.0.0.1', () => resolve())
  })
  const controlPort = (control.address() as AddressInfo).port

  return {
    llm,
    gateway,
    controlUrl: `http://127.0.0.1:${controlPort}`,
    async stop() {
      control.closeAllConnections?.()
      await new Promise<void>((resolve) => control.close(() => resolve()))
      // The fakes have no `close()` by design (see their headers): they are
      // process-wide singletons and process exit is their teardown. Global
      // teardown ends this process, so that is what reclaims their ports.
    },
  }
}

/**
 * Prove the redirect took, before a single scenario runs.
 *
 * By OBSERVATION — a real turn's worth of BAML calls has to arrive at the fake
 * — rather than by trusting that the server logged something. A silent no-op in
 * `dev-fake-inference.server.ts` is the one failure that would turn this suite
 * into a source of real, billed, prompt-leaking calls, and the poisoned
 * `ANTHROPIC_API_KEY` only makes that failure loud, not impossible: a turn
 * would 401 and the suite would report a broken app rather than a broken fake.
 *
 * The probe is a real HTTP request to the real server — `/api/events`, the
 * route the browser posts to — because that is the only thing that proves the
 * redirect reached the process actually serving the app.
 *
 * ## Why it takes TWO turns since 2026-08-26
 *
 * It used to be one, and it asserted "at least one call arrived on a model
 * that is not `VerdaQwen`" — the side roles (`router` / `describe` / `screen` /
 * `planner` / title) were held on Anthropic in both switch positions, so any
 * turn at all witnessed the redirect. The owner's tier widening put EVERY role
 * on the self-hosted deployment for a private-tier run, and the private tier is
 * also the default when `VERDA_INFERENCE_ENDPOINT` is configured — which global
 * setup configures. So a default-tier turn now makes no Anthropic-chain call
 * whatsoever, and the old assertion would have failed for the right reason
 * about the wrong thing: nothing was leaking, there was simply nothing left to
 * observe on that turn.
 *
 * The two claims are therefore now one turn each, and neither can stand in for
 * the other:
 *
 *  1. **The self-hosted seam.** A default-tier turn reaches the fake at all.
 *     This is the shipped `VERDA_INFERENCE_ENDPOINT` route, and it is also what
 *     creates the schema the tier row below is written into.
 *  2. **The Anthropic redirect.** A turn forced onto the anthropic tier has to
 *     produce at least one call carrying `FAKE_ANTHROPIC_TIER_MODEL`. That is
 *     the only tier from which the redirect is reachable now, so it is the only
 *     place the fail-closed check can live.
 */
export async function assertHermetic(backend: Backend, appUrl: string): Promise<void> {
  const onDefaultTier = await probeTurn(backend, appUrl, 'default')
  if (onDefaultTier.length === 0) {
    throw new Error(
      'e2e-browser preflight: a whole turn completed WITHOUT one call reaching the fake ' +
        'endpoint. Neither seam is carrying the run — check that E2E_FAKE_INFERENCE_URL and ' +
        'VERDA_INFERENCE_ENDPOINT reached the dev server, and that src/middleware.ts still ' +
        'calls installDevFakeInference(). Refusing to run: every scenario would otherwise ' +
        'issue real provider calls with whatever key the environment holds.',
    )
  }

  // The row `resolveInferenceTier()` reads, written the way the header switch
  // writes it. Only reachable now that the turn above has run `ensureSchema()`.
  await setStoredTier('anthropic')
  const onAnthropicTier = await probeTurn(backend, appUrl, 'anthropic')
  if (!onAnthropicTier.some((call) => call.model === FAKE_ANTHROPIC_TIER_MODEL)) {
    throw new Error(
      'e2e-browser preflight: a turn forced onto the ANTHROPIC tier produced no call ' +
        `carrying \`${FAKE_ANTHROPIC_TIER_MODEL}\` (${onAnthropicTier.length} call(s) served: ` +
        `${[...new Set(onAnthropicTier.map((call) => call.model))].join(', ') || 'none'}). The ` +
        'Anthropic-chain redirect is NOT installed, so those calls are going to the real ' +
        'provider. See src/lib/inference/dev-fake-inference.server.ts.',
    )
  }
}

/** One real turn against the real server; the calls the fake served for it. */
async function probeTurn(backend: Backend, appUrl: string, label: string): Promise<FakeCall[]> {
  const before = backend.llm.calls.length
  const response = await fetch(`${appUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: `e2e-browser-preflight-${label}-${Date.now()}`,
      message: 'preflight',
      agentId: 'search',
    }),
  })
  // Drain the stream; the turn itself is not what is being asserted.
  await response.text()
  return backend.llm.calls.slice(before)
}

// ============================================================================
// Wire helpers
// ============================================================================

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {})
      } catch {
        resolve({})
      }
    })
  })
}
