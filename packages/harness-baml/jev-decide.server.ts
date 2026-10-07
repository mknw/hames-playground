/**
 * Jev decide transport — Server Only (#418, slice T4)
 *
 * The Anthropic tier's `decide` client: TypeSafe's Jev, reached through
 * OpenRouter's Decisions API (`POST /api/alpha/decisions`, `typesafe/jev-1.13`).
 * It is a REST adapter and not a BAML leaf, because that endpoint is not
 * chat-completions and no BAML client can speak it — which is also why it has
 * no collector: it builds its own `LLMCallRecord` and reports through
 * `notifyLlmUsage`.
 *
 * ONE request carries every field of a decision set, each as its own typed
 * `choice` question; the answer carries a probability per option and a
 * confidence. No text is generated, so there is no output cap to hit.
 *
 * THREE RULES, each pinned:
 *
 *  - THE TIER LOCK (`jev-tier-lock`). Jev is a PUBLIC provider and may never
 *    take a call made under the private tier. `createDecideAdapter` refuses
 *    before it gets here; this module refuses again, because a posture
 *    invariant must not rest on one caller remembering to check.
 *  - FAIL CLOSED (`jev-fallback`). A connection error, a non-2xx or a
 *    malformed answer throws an `LLMCallError`; `decide()` turns that into an
 *    abstain with the policy's fallback. Nothing is retried elsewhere — no
 *    other provider, no local 4B.
 *  - PRICE IS WHAT THE PROVIDER REPORTED (`jev-cost-eur`). `usage.cost` is USD
 *    and output tokens are free; the docs state no per-input list price, so an
 *    invented per-MTok rate would render as a confident figure. The reported
 *    USD converts once at the static `EUR_PER_USD`, like every other client.
 *
 * Open, not inferred: the Jev documentation states no latency, no retention and
 * no region. OpenRouter and TypeSafe are processors beside Anthropic.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { notifyLlmUsage } from '@hames-ai/harness-patterns/llm-usage-observer.server'
import {
  LLMCallError,
  type DecideAllFn,
  type DecideFn,
  type DecideResult,
  type DecisionSetSpec,
  type EventMetrics,
  type LLMCallRecord,
} from '@hames-ai/harness-patterns/types'
import {
  activeCostPricing,
  activeCostRates,
  activeInferenceTier,
  limitsFor,
} from './clients.server'

assertServerOnImport()

/** The BAML-less client the Anthropic tier's `decide` role resolves to. */
export const JEV_CLIENT_NAME = 'JevDecide'

export const JEV_MODEL = 'typesafe/jev-1.13'

/** The Decisions API. Overridable (`JEV_DECISIONS_URL`) so the layer-2 fake can
 *  stand in for it; read per call, like every other host-set endpoint. */
export const JEV_DEFAULT_URL = 'https://openrouter.ai/api/alpha/decisions'

/** Bounds one request. Not derived from a measurement: the docs publish no
 *  latency, and an unbounded `fetch` has no timeout at all. */
const JEV_TIMEOUT_MS = 30_000

interface JevAnswer {
  readonly choice?: unknown
  readonly confidence?: unknown
  readonly probabilities?: unknown
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export interface JevTransportOptions {
  /** Injection seam for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch
}

function jevFailure(
  message: string,
  variables: Record<string, unknown>,
  startTime: number,
  extra?: Partial<LLMCallRecord>,
  cause?: unknown,
): LLMCallError {
  return new LLMCallError(
    message,
    {
      functionName: 'Decide',
      variables,
      clientName: JEV_CLIENT_NAME,
      provider: 'openrouter',
      durationMs: Date.now() - startTime,
      // Jev generates no text: there is no cap to have hit.
      hitOutputCap: false,
      ...extra,
    },
    cause,
  )
}

/** Step accounting for one response. `costEur` is the provider-reported USD
 *  converted at the static rate; absent when the provider reported none, which
 *  renders as unknown rather than free. */
function metricsFor(
  usage: { input_tokens: number; output_tokens: number; cost?: number } | undefined,
): EventMetrics | undefined {
  if (!usage) return undefined
  const tokens = {
    inputUncachedTokens: usage.input_tokens,
    inputCacheReadTokens: 0,
    inputCacheWriteTokens: 0,
    outputTokens: usage.output_tokens,
  }
  const est = activeCostPricing().estimate(tokens, JEV_CLIENT_NAME, {
    providerCostUsd: usage.cost,
    eurPerUsd: activeCostRates().eurPerUsd(),
  })
  return {
    ...tokens,
    attempts: 1,
    ...(est ? { costEur: est.costEur, noCacheEur: est.noCacheEur, basis: est.basis } : {}),
  }
}

/**
 * The Jev transport. `decideAll` is the one-request entry; `decide` is the
 * same thing for a single spec.
 */
export function createJevTransport(options: JevTransportOptions = {}): {
  decideAll: DecideAllFn
  decide: DecideFn
} {
  const decideAll: DecideAllFn = async <F extends Record<string, string>>(input: {
    readonly spec: DecisionSetSpec<F>
    readonly state: string
  }) => {
    const startTime = Date.now()
    const { spec, state } = input
    const names = Object.keys(spec.fields) as Array<keyof F & string>
    const variables = {
      state,
      key: spec.key,
      fields: Object.fromEntries(
        names.map((n) => [n, { question: spec.fields[n].question, labels: spec.fields[n].labels }]),
      ),
    }

    // THE TIER LOCK — before any request, and without reading the key.
    if (activeInferenceTier() === 'verda') {
      throw jevFailure(
        'Refusing the Jev decide transport under the private inference tier: Jev is a public ' +
          'provider, and nothing was sent to any provider.',
        variables,
        startTime,
      )
    }

    const body = {
      model: JEV_MODEL,
      state,
      questions: Object.fromEntries(
        names.map((n) => [
          n,
          {
            type: 'choice',
            instructions: spec.fields[n].question,
            criteria: Object.fromEntries(spec.fields[n].labels.map((l) => [l.id, l.description])),
          },
        ]),
      ),
    }
    const rawInput = JSON.stringify(body)

    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) {
      throw jevFailure(
        'The Jev decide transport needs OPENROUTER_API_KEY; no request was made.',
        variables,
        startTime,
        { rawInput },
      )
    }

    let status: number
    let text: string
    try {
      const res = await (options.fetch ?? fetch)(process.env.JEV_DECISIONS_URL || JEV_DEFAULT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: rawInput,
        signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
      })
      status = res.status
      text = await res.text()
    } catch (e) {
      throw jevFailure(
        `Jev request failed: ${e instanceof Error ? e.message : String(e)}`,
        variables,
        startTime,
        { rawInput },
        e,
      )
    }
    if (status < 200 || status >= 300) {
      throw jevFailure(`Jev answered HTTP ${status}: ${text.slice(0, 300)}`, variables, startTime, {
        rawInput,
        rawOutput: text,
      })
    }

    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (e) {
      throw jevFailure(
        'Jev answered a body that is not JSON.',
        variables,
        startTime,
        {
          rawInput,
          rawOutput: text,
        },
        e,
      )
    }
    const answers = isRecord(json) && isRecord(json.answers) ? json.answers : undefined
    const u = isRecord(json) && isRecord(json.usage) ? json.usage : undefined
    const usage =
      u && typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number'
        ? {
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
            ...(typeof u.cost === 'number' && Number.isFinite(u.cost) && u.cost >= 0
              ? { cost: u.cost }
              : {}),
          }
        : undefined
    const metrics = metricsFor(usage)
    const durationMs = Date.now() - startTime
    // The request WAS answered and billed: account it even when the answer then
    // fails to parse, the same rule the BAML failure path follows.
    notifyLlmUsage({ functionName: 'Decide', clientName: JEV_CLIENT_NAME, metrics, durationMs })

    const record: LLMCallRecord = {
      functionName: 'Decide',
      variables,
      rawInput,
      rawOutput: text,
      parsedOutput: answers,
      ...(usage && {
        usage: {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cachedInputTokens: 0,
          totalTokens: usage.input_tokens + usage.output_tokens,
        },
      }),
      ...(metrics && { metrics }),
      durationMs,
      provider: 'openrouter',
      clientName: JEV_CLIENT_NAME,
      hitOutputCap: false,
    }

    if (!answers) {
      throw new LLMCallError('Jev answered a body with no `answers`.', record)
    }
    const fields = {} as { [K in keyof F]: DecideResult<F[K]> }
    for (const n of names) {
      const a = answers[n] as JevAnswer | undefined
      const probsIn = isRecord(a) && isRecord(a.probabilities) ? a.probabilities : undefined
      if (!probsIn) {
        throw new LLMCallError(`Jev answered no probabilities for field "${n}".`, record)
      }
      const labels = spec.fields[n].labels
      let sum = 0
      const raw = {} as Record<string, number>
      for (const l of labels) {
        const p = probsIn[l.id]
        if (p !== undefined && (typeof p !== 'number' || !Number.isFinite(p) || p < 0)) {
          throw new LLMCallError(`Jev answered an invalid probability for "${n}.${l.id}".`, record)
        }
        raw[l.id] = p ?? 0
        sum += raw[l.id]
      }
      if (!(sum > 0)) {
        throw new LLMCallError(
          `Jev's probabilities for field "${n}" name none of its labels.`,
          record,
        )
      }
      const probs = {} as Record<string, number>
      for (const l of labels) probs[l.id] = raw[l.id] / sum
      fields[n] = {
        probs,
        method: 'jev',
        // The response carries a confidence value: Jev's own calibration claim.
        // T8 verifies it for our questions (ECE).
        calibrated: typeof (a as JevAnswer).confidence === 'number',
        llmCall: record,
      } as DecideResult<F[typeof n]>
    }
    return { fields }
  }

  const decide: DecideFn = async <L extends string>(input: {
    readonly spec: {
      key: string
      question: string
      labels: readonly { id: L; description: string }[]
    }
    readonly state: string
  }) => {
    const r = await decideAll({
      spec: { key: input.spec.key, fields: { [input.spec.key]: input.spec } },
      state: input.state,
    })
    return r.fields[input.spec.key] as unknown as DecideResult<L>
  }

  // The state cap of the model behind the resolved client (Jev's documented
  // 32k tokens, in `MODEL_CONTEXT_WINDOWS`), read per call like every role.
  decideAll.limits = () => limitsFor('decide')
  decide.limits = () => limitsFor('decide')
  return { decideAll, decide }
}
