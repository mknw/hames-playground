/**
 * Jev decide transport — Server Only (#418, slice T4)
 *
 * The Anthropic tier's `decide` client: TypeSafe's Jev, reached directly at
 * `POST https://api.typesafe.ai/v1/systemone` (`jev-1.13.0`). OpenRouter's
 * Decisions API remains an explicitly configured fallback.
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
 *    when present. TypeSafe reports token counts without a cost: keep that
 *    unknown under this transport's provider-cost accounting. The reported
 *    USD converts once at the static `EUR_PER_USD`, like every other client.
 *
 * TypeSafe offers enterprise ZDR by agreement, not by request flag. No-training
 * is a separate commitment; default retention is not zero. See SD-10 in
 * docs/data-privacy/plan.md for the processor and retention terms.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { notifyLlmUsage } from '@hames-ai/harness-patterns/llm-usage-observer.server'
import {
  LLMCallError,
  type DecideAllFn,
  type AnyDecisionSpec,
  type MixedDecisionSet,
  type DecisionLabelsFor,
  type DecideFn,
  type DecideInput,
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
  onExplicitAnthropicTier,
} from './clients.server'

assertServerOnImport()

/** The BAML-less client the Anthropic tier's `decide` role resolves to. */
export const JEV_CLIENT_NAME = 'JevDecide'

export const JEV_MODEL = 'typesafe/jev-1.13'
export const TYPESAFE_JEV_MODEL = 'jev-1.13.0'

/** TypeSafe's direct endpoint, gated until the owner confirms the account's ZDR terms. */
export const JEV_DEFAULT_URL = 'https://api.typesafe.ai/v1/systemone'

/** Owner gate (#545 D): set true in its own PR once the account's ZDR terms are confirmed. */
const TYPESAFE_DEFAULT_CONFIRMED = false

/** The endpoint the transport uses: the configured URL, else the gated default ('' = none). Shared with the calibration fingerprint. */
export const configuredDecisionsUrl = (): string =>
  process.env.JEV_DECISIONS_URL || (TYPESAFE_DEFAULT_CONFIRMED ? JEV_DEFAULT_URL : '')

/** The model id a request to `hostname` carries; the transport and the calibration fingerprint share it. */
export const jevModelFor = (hostname: string): string =>
  hostname === 'api.typesafe.ai' ? TYPESAFE_JEV_MODEL : JEV_MODEL

/** OpenRouter's provider preferences for this traffic: route only to endpoints with
 *  a zero-data-retention policy, and to none that may collect data. Applied
 *  whenever the configured endpoint is OpenRouter (O1, #418). */
export const OPENROUTER_PRIVACY_PREFERENCES = { zdr: true, data_collection: 'deny' } as const

/** The decision transport's OWN key (O2): never the embedding provider's
 *  `OPENROUTER_API_KEY`, and no fallback to it — a silent fallback would couple
 *  spend limits and rotation across two purposes. */
export const JEV_KEY_ENV = 'JEV_DECISIONS_API_KEY'

/** Bounds one request. Not derived from a measurement: the docs publish no
 *  latency, and an unbounded `fetch` has no timeout at all. */
const JEV_TIMEOUT_MS = 30_000

/** How far a field's probabilities may sit from summing to 1 before the answer
 *  is refused (rounding is absorbed by the normalising division; a missing
 *  label or an out-of-range value is not rounding). */
const JEV_MASS_TOLERANCE = 0.01

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
  /** The preferences sent to an OpenRouter endpoint. Defaults to
   *  `OPENROUTER_PRIVACY_PREFERENCES`; the transport verifies the body it is about to
   *  send still carries zdr and a denied data collection and refuses otherwise. */
  readonly openRouterPreferences?: Record<string, unknown>
}

/** O4: only `https:` or a loopback host may receive the bearer key. Decided on the
 *  PARSED URL, never a string prefix, so `http://127.0.0.1.evil.example` (a public
 *  host) and `http://127.0.0.1@evil.example` (userinfo) are not mistaken for
 *  loopback. Credentials in the URL are refused outright. Returns the parsed URL,
 *  or the reason it was refused. */
export function parseDecisionsUrl(raw: string): URL | string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'it is not a valid URL'
  }
  if (url.username || url.password) return 'it carries credentials'
  // A trailing dot names the same host to DNS and TLS but not to a string
  // comparison: `openrouter.ai.` would otherwise skip the O1 preferences.
  if (url.hostname.endsWith('.')) return 'its host ends in a dot'
  if (url.protocol === 'https:') return url
  const host = url.hostname
  const loopback =
    url.protocol === 'http:' &&
    (host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host))
  return loopback ? url : 'it is neither https: nor a loopback host'
}

const isOpenRouterHost = (host: string) =>
  host === 'openrouter.ai' || host.endsWith('.openrouter.ai')

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
  const decideAll: DecideAllFn = async <S extends Record<string, AnyDecisionSpec>>(input: {
    readonly spec: MixedDecisionSet<S>
    readonly state: string
  }) => {
    const startTime = Date.now()
    const { state } = input
    for (const field of Object.values(input.spec.fields)) {
      if (field.type !== undefined && field.type !== 'choice') {
        throw new Error(`Unsupported decision type: ${String(field.type)}`)
      }
    }
    const spec = input.spec as DecisionSetSpec<Record<string, string>>
    const names = Object.keys(spec.fields) as Array<keyof S & string>
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

    // Unknown/future tiers must not inherit a public route from the default.
    if (!onExplicitAnthropicTier()) {
      throw jevFailure(
        'Refusing the Jev decide transport outside the Anthropic inference tier; no request was made.',
        variables,
        startTime,
      )
    }

    // O4 — before the key is read: the bearer token goes only over https: or loopback.
    const configured = configuredDecisionsUrl()
    if (!configured) {
      throw jevFailure(
        'The Jev decide transport needs JEV_DECISIONS_URL (there is no default endpoint); no request was made.',
        variables,
        startTime,
      )
    }
    const endpoint = parseDecisionsUrl(configured)
    if (typeof endpoint === 'string') {
      throw jevFailure(
        `Refusing JEV_DECISIONS_URL: ${endpoint}; no request was made.`,
        variables,
        startTime,
      )
    }

    const openRouter = isOpenRouterHost(endpoint.hostname)
    const typeSafe = endpoint.hostname === 'api.typesafe.ai'
    const provider = openRouter ? 'openrouter' : typeSafe ? 'typesafe' : undefined
    const body = {
      model: jevModelFor(endpoint.hostname),
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
      // O1: on an OpenRouter endpoint, zero data retention and data collection denied.
      ...(openRouter && {
        provider: options.openRouterPreferences ?? OPENROUTER_PRIVACY_PREFERENCES,
      }),
    }
    const rawInput = JSON.stringify(body)

    // FAIL CLOSED: read the preferences back off the exact bytes about to be sent.
    if (openRouter) {
      const sent = (JSON.parse(rawInput) as { provider?: Record<string, unknown> }).provider
      if (sent?.zdr !== true || sent?.data_collection !== 'deny') {
        throw jevFailure(
          "Refusing the Jev decide transport: OpenRouter's zero-retention provider preferences " +
            'could not be applied; no request was made.',
          variables,
          startTime,
          { rawInput, provider },
        )
      }
    }

    // O2 — its own key; the embedding provider's is never read here.
    const apiKey = process.env[JEV_KEY_ENV]
    if (!apiKey) {
      throw jevFailure(
        `The Jev decide transport needs ${JEV_KEY_ENV}; no request was made.`,
        variables,
        startTime,
        { rawInput, provider },
      )
    }

    let status: number
    let text: string
    try {
      const res = await (options.fetch ?? fetch)(endpoint.href, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: rawInput,
        signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
        redirect: 'error',
      })
      status = res.status
      // Response bodies and fetch errors are untrusted: never persist an echoed key.
      text = (await res.text()).split(apiKey).join('[redacted]')
    } catch (e) {
      throw jevFailure(
        `Jev request failed: ${(e instanceof Error ? e.message : String(e)).split(apiKey).join('[redacted]')}`,
        variables,
        startTime,
        { rawInput, provider },
      )
    }
    if (status < 200 || status >= 300) {
      throw jevFailure(`Jev answered HTTP ${status}: ${text.slice(0, 300)}`, variables, startTime, {
        rawInput,
        provider,
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
          provider,
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
      provider,
      clientName: JEV_CLIENT_NAME,
      hitOutputCap: false,
    }

    if (!answers) {
      throw new LLMCallError('Jev answered a body with no `answers`.', record)
    }
    const fields = {} as { [K in keyof S]: DecideResult<DecisionLabelsFor<S[K]>> }
    for (const n of names) {
      const a = answers[n] as JevAnswer | undefined
      const probsIn = isRecord(a) && isRecord(a.probabilities) ? a.probabilities : undefined
      if (!probsIn) {
        throw new LLMCallError(`Jev answered no probabilities for field "${n}".`, record)
      }
      const labels = spec.fields[n].labels
      if (Object.keys(probsIn).some((k) => !labels.some((l) => l.id === k))) {
        throw new LLMCallError(
          `Jev answered a label outside the asked set for field "${n}".`,
          record,
        )
      }
      let sum = 0
      const raw = {} as Record<string, number>
      for (const l of labels) {
        const p = probsIn[l.id]
        if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
          throw new LLMCallError(`Jev answered no valid probability for "${n}.${l.id}".`, record)
        }
        raw[l.id] = p
        sum += p
      }
      // Fail CLOSED: an answer that omits a label or whose mass is not ~1 must
      // not be renormalised into certainty — that would clear every cut.
      if (Math.abs(sum - 1) > JEV_MASS_TOLERANCE) {
        throw new LLMCallError(
          `Jev's probabilities for field "${n}" sum to ${sum} over its labels, not 1.`,
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
      } as DecideResult<DecisionLabelsFor<S[typeof n]>>
    }
    return { fields }
  }

  const decide: DecideFn = async <L extends string>(input: DecideInput<L>) => {
    // S1 widens the seam; S4 adds wire support. Nothing is built or sent here.
    if (input.spec.type !== undefined && input.spec.type !== 'choice') {
      throw new Error(`Unsupported decision type: ${String(input.spec.type)}`)
    }
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
