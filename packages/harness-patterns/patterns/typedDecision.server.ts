/**
 * typedDecision — the decision policy layer (#418)
 *
 * T1 carries the PURE scoring half: the readout math the logprob transport
 * composes (letter-variant summing, log-space calibration, renormalisation),
 * the F2 threshold resolution, the F3 pre-call abstention, and the scorer
 * that turns one raw-seam outcome into a `Decision` plus its
 * `decision_made` event data. Everything here is deterministic and unit-pinned
 * (`__tests__/typed-decision.test.ts`); no LLM is called from this module.
 *
 * T2 (the second half of this file) adds the pattern half on top of these
 * exports: `evaluateDecision` (the awaited wrapper — ask the transport what it
 * will serve, call the raw seam, score), `decide` (the never-throwing
 * in-scope consumer entry) and `decideFields` (several typed fields over one
 * state), plus the `typedDecision` chain step and `decisionRouter`.
 *
 * The three layers of the seam (#418): the RAW seam (`DecideFn` →
 * `DecideResult`) is one call, one distribution, no policy — frozen against
 * the merged `classifierFromDecide` consumer, which must be handed the raw
 * seam and never a policy-applying wrapper (D7). THIS module is the policy
 * layer: it applies a `DecisionPolicy`, records `decision_made`, and never
 * throws. The transports behind the raw seam (logprob readout, Jev,
 * verbalized secondary) live in harness-baml and the app.
 */

import { assertServerOnImport } from '../assert.server'
import {
  DIRECT_RESPONSE_ROUTE,
  LLMCallError,
  MAX_DECISION_LABELS,
  MAX_SCORE_LEVELS,
} from '../types'
import type {
  AbstainReason,
  AnyDecision,
  AnyDecisionSpec,
  DecisionFor,
  DecisionType,
  ScoreSpec,
  NoulSpec,
  ScoreDecision,
  NoulDecision,
  ScorePolicy,
  NoulPolicy,
  AssistantMessageEventData,
  ConfiguredPattern,
  ContextEvent,
  DecideAllFn,
  DecideFn,
  DecideResult,
  Decision,
  DecisionCalibrationEntry,
  DecisionLabel,
  DecisionMadeEventData,
  DecisionMethod,
  DecisionPolicy,
  DecisionSetSpec,
  DecisionSpec,
  ErrorEventData,
  EventView,
  LLMCallRecord,
  PatternCapabilities,
  PatternConfig,
  PatternScope,
  TrackHistory,
  UserMessageEventData,
  ViewConfig,
} from '../types'
import { resolveConfig, trackEvent } from '../context.server'
import { getErrorHint } from '../error-hints'
import { currentRunFrame } from '../run-frame.server'
import { DEFAULT_RUNTIME_CONFIG } from '../runtime-config'
import { stripThinkBlocks } from '../content-transforms'
import { trimToFit } from '../token-budget.server'
import type { RouterData, Routes } from './router.server'

assertServerOnImport()

/** Declaration checks run where a developer writes the spec, never at inference. */
function assertOptions(owner: string, labels: readonly DecisionLabel[], cap: number): void {
  if (labels.length < 2 || labels.length > cap) {
    throw new Error(`${owner}: expected 2..${cap} options, got ${labels.length}`)
  }
  if (new Set(labels.map((l) => l.id)).size !== labels.length) {
    throw new Error(`${owner}: option ids must be unique`)
  }
}

export function defineChoice<const L extends string>(spec: DecisionSpec<L>): DecisionSpec<L> {
  assertOptions('defineChoice', spec.labels, MAX_DECISION_LABELS)
  return spec
}

export function defineScore<const L extends string>(
  spec: Omit<ScoreSpec<L>, 'type'>,
): ScoreSpec<L> {
  assertOptions('defineScore', spec.levels, MAX_SCORE_LEVELS)
  return { ...spec, type: 'score' }
}

export function defineNoul(spec: Omit<NoulSpec, 'type'>): NoulSpec {
  return { ...spec, type: 'noul' }
}

/** A declared spec fixes both the key and the type of a stored verdict.
 *  Missing type is a choice, including decisions read from older blobs. */
export function readDecision<S extends AnyDecisionSpec>(
  data: TypedDecisionData,
  spec: S,
): DecisionFor<S> | undefined {
  const d = data.decisions?.[spec.key]
  if (!d || (d.type ?? 'choice') !== (spec.type ?? 'choice')) return undefined
  return d as DecisionFor<S>
}

// ============================================================================
// Readout math — the logprob transport (T3) composes these; they are here
// because the `decision-math` pin owns them and they are pure.
// ============================================================================

/** One entry of an OpenAI-style `top_logprobs` array. */
export interface TopLogprob {
  readonly token: string
  readonly logprob: number
}

/** Characters stripped from the LEFT of a top-logprob token before matching a
 *  label id: whitespace, quotes and opening brackets — the variants the readout
 *  must treat as the same letter (`'B'`, `' B'`, `'(B'`). Trailing characters
 *  are handled by the prefix rule below, not stripped away. */
const TOKEN_LEAD = /[\s'"({[⟦]/

function trimTokenLeft(token: string): string {
  let start = 0
  while (start < token.length && TOKEN_LEAD.test(token[start])) start++
  return token.slice(start)
}

/** Does the trimmed token name exactly this label — the token itself, or the
 *  label followed by a non-word character (`'B.'`, `'B)'`), never a LONGER
 *  word that merely starts with it (`'Btool'`)? Keyed by the token's exact
 *  text: that is what the `decision-math` pin mutates ("key letters by exact
 *  text" — a token must not be attributed to a label it does not name). */
function tokenNamesLabel(token: string, label: string): boolean {
  if (token === label) return true
  if (!token.startsWith(label)) return false
  const next = token.charCodeAt(label.length)
  return !isWordChar(next)
}

function isWordChar(code: number | undefined): boolean {
  if (code === undefined) return false
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x5f // _
  )
}

/**
 * Sum the top-k logprobs per label, trimming every token to the letter it
 * names (`'B'`, `' B'`, `'(B'` all count for label `'B'`). Tokens are summed
 * as PROBABILITY MASS (logsumexp over a label's tokens — two variants of the
 * same letter add their mass, they do not multiply it), so the result is
 * unnormalized per-label mass ready for {@link calibrateLabelMass} and
 * {@link normalizeLabelMass}.
 *
 * `coverage` is the total mass the top-k window attributed to a label — the
 * share of the distribution the readout actually SAW. The leftover (tokens
 * matching no label, plus everything beyond top-k) is `1 − coverage`; a thin
 * window or a prompt that tempts other tokens shows up as low coverage and
 * `policy.minCoverage` abstains on it (reason `'low-coverage'`).
 */
export function sumLabelMass<L extends string>(
  top: readonly TopLogprob[],
  labels: readonly L[],
): { readonly mass: Partial<Record<L, number>>; readonly coverage: number } {
  const mass: Record<string, number> = {}
  let coverage = 0
  for (const entry of top ?? []) {
    if (!Number.isFinite(entry.logprob)) continue
    const token = trimTokenLeft(entry.token)
    // Longest label wins, so a two-character label is not shadowed by a
    // one-character prefix of it.
    const label = [...labels]
      .filter((l) => tokenNamesLabel(token, l))
      .reduce((best, l) => (l.length > best.length ? l : best), '' as L | '')
    if (!label) continue
    const p = Math.exp(entry.logprob)
    mass[label] = (mass[label] ?? 0) + p
    coverage += p
  }
  return { mass: mass as Partial<Record<L, number>>, coverage }
}

/**
 * Apply a fitted calibration entry in log space (D11): divide the per-label
 * log-mass by `temperature`, add `bias[label]`, and renormalise. `mass` may be
 * unnormalized (raw {@link sumLabelMass} output) — the softmax renormalises
 * regardless. An absent entry is the identity.
 *
 * Malformed entry values are IGNORED, never thrown: calibration is an
 * enhancement fitted by the host, and a malformed entry must degrade to the
 * uncalibrated readout rather than kill a decision (`evaluateDecision` never
 * throws, D8). Non-finite logprobs in `mass` are skipped for the same reason.
 */
export function calibrateLabelMass<L extends string>(
  mass: Partial<Record<L, number>>,
  entry?: DecisionCalibrationEntry,
): Partial<Record<L, number>> {
  if (!entry) return mass
  const temperature =
    typeof entry.temperature === 'number' &&
    Number.isFinite(entry.temperature) &&
    entry.temperature > 0
      ? entry.temperature
      : 1
  const bias = entry.bias ?? {}
  const logits: Array<{ label: L; z: number }> = []
  for (const [label, m] of Object.entries(mass) as Array<[L, number | undefined]>) {
    if (m === undefined || !Number.isFinite(m) || m <= 0) continue
    const b = bias[label as string]
    const biasValue = typeof b === 'number' && Number.isFinite(b) ? b : 0
    logits.push({ label, z: Math.log(m) / temperature + biasValue })
  }
  if (logits.length === 0) return {}
  // Softmax over the shifted logits, with the max subtracted for stability.
  const max = Math.max(...logits.map((e) => e.z))
  const weights = logits.map((e) => ({ label: e.label, w: Math.exp(e.z - max) }))
  const total = weights.reduce((s, e) => s + e.w, 0)
  const out: Record<string, number> = {}
  for (const e of weights) out[e.label as string] = e.w / total
  return out as Partial<Record<L, number>>
}

/**
 * Renormalise a per-label mass record into a distribution over the spec's
 * labels: every label present (unseen → 0), the record summing to 1. Returns
 * `total <= 0` for a record with no usable mass — the caller treats that as
 * an unusable distribution, not as a confident zero.
 */
export function normalizeLabelMass<L extends string>(
  mass: Partial<Record<L, number>>,
  labels: readonly L[],
): { readonly probs: Record<L, number>; readonly total: number } {
  const total = labels.reduce((s, l) => s + (Number.isFinite(mass[l]) ? (mass[l] as number) : 0), 0)
  if (!(total > 0)) return { probs: {} as Record<L, number>, total }
  const probs = {} as Record<L, number>
  for (const label of labels) {
    probs[label] = Number.isFinite(mass[label]) ? (mass[label] as number) / total : 0
  }
  return { probs, total }
}

// ============================================================================
// Policy math — F2 threshold resolution and F3 pre-call abstention
// ============================================================================

/** The confidence formula's floor: (K·p_max − 1)/(K − 1), undefined at K ≤ 1.
 *  A one-label spec is degenerate (specs carry 2..MAX_DECISION_LABELS labels);
 *  the scorer defends with p_max itself rather than dividing by zero. */
function confidenceFromMax(pMax: number, k: number): number {
  if (k <= 1) return pMax
  return (k * pMax - 1) / (k - 1)
}

/**
 * The F3 pre-call gate: everything knowable BEFORE the raw seam is called.
 * Returns the abstain reason when the call must not be made, `null` when it
 * may proceed.
 *
 *  - `'no-state'` — there is no state to decide over.
 *  - `'uncalibrated'` — the policy requires calibration and the resolved
 *    client's method is KNOWINGLY non-calibratable (a verbalized secondary).
 *    Jev and logprob clients are calibratable, so they are called (F3). An
 *    UNKNOWN method (`method` absent) never abstains here: the post-call
 *    `calibrated` check on the result is the honest gate, and a pre-call
 *    refusal on a guess would be a control that fires on the wrong evidence.
 *
 * The point of the gate is paid-for-but-discarded work: a `requireCalibrated`
 * set of four fields on a verbalized tier must not buy four full-price calls
 * whose results the policy drops (review F3). The zero-LLM-calls half of the
 * `decision-precall-abstain` pin is completed by `evaluateDecision` (T2),
 * which consults this before calling.
 */
export function preCallAbstain(input: {
  readonly policy: DecisionPolicy<string> | NoulPolicy
  readonly state?: string
  readonly method?: DecisionMethod
  readonly spec?: AnyDecisionSpec
  readonly supportedTypes?: readonly DecisionType[]
}): AbstainReason | null {
  if (typeof input.state !== 'string' || input.state.length === 0) return 'no-state'
  if (input.spec && !(input.supportedTypes ?? ['choice']).includes(input.spec.type ?? 'choice')) {
    return 'unsupported-type'
  }
  if (input.policy.requireCalibrated === true && input.method === 'verbalized') {
    return 'uncalibrated'
  }
  return null
}

/**
 * One threshold cut (minConfidence / minMargin), resolved per F2's order:
 * the applied calibration entry's own value WINS; otherwise the policy's
 * static value applies only when the serving method is the method the
 * thresholds were fitted on (`policy.thresholdMethod ?? 'logprob'`); otherwise
 * the cut cannot be resolved on-distribution.
 */
export type ResolvedCut = { readonly value: number | undefined } | { readonly mismatch: true }

function resolveCut(
  entryValue: number | undefined,
  policyValue: number | undefined,
  methodMatch: boolean,
): ResolvedCut {
  if (entryValue !== undefined) return { value: entryValue }
  if (policyValue === undefined) return { value: undefined }
  return methodMatch ? { value: policyValue } : { mismatch: true }
}

/**
 * The F2 threshold resolution (pure): resolve the effective confidence/margin
 * cuts for one decision, or abstain `'method-mismatch'`.
 *
 *  1. an applied calibration entry's own `minConfidence`/`minMargin` win —
 *     they are fitted on the very (client, spec.key) pair that serves the
 *     call, so they are on-distribution whatever `thresholdMethod` says;
 *  2. otherwise the policy's cuts apply only when the serving method EQUALS
 *     `policy.thresholdMethod ?? 'logprob'`;
 *  3. otherwise the cut is a mismatch → the decision abstains
 *     `'method-mismatch'` rather than applying a threshold tuned on another
 *     distribution (a logprob-fitted cut means nothing on a verbalized or Jev
 *     read — the defect the F2 review found in #419's recall gate).
 *
 * A cut the policy does not define and no entry carries resolves to
 * `undefined` — there is nothing to misapply, so no mismatch.
 */
export function resolveDecisionCuts(
  policy: DecisionPolicy<string>,
  calibration: DecisionCalibrationEntry | undefined,
  method: DecisionMethod | undefined,
): { readonly minConfidence: ResolvedCut; readonly minMargin: ResolvedCut } {
  const thresholdMethod = policy.thresholdMethod ?? 'logprob'
  const methodMatch = method === thresholdMethod
  return {
    minConfidence: resolveCut(calibration?.minConfidence, policy.minConfidence, methodMatch),
    minMargin: resolveCut(calibration?.minMargin, policy.minMargin, methodMatch),
  }
}

// ============================================================================
// The scorer — the pure half of evaluateDecision
// ============================================================================

/** Everything the scorer needs to turn one raw-seam outcome into a `Decision`
 *  and its `decision_made` event. The caller (T2's `evaluateDecision`) owns
 *  the await: it resolves the client, consults {@link preCallAbstain}, calls
 *  the raw seam or catches its throw, and hands the outcome here. */
export interface DecisionScoring<L extends string = string> {
  readonly spec: DecisionSpec<L>
  readonly policy: DecisionPolicy<L>
  /** The state the decision was asked over. Its LENGTH is recorded
   *  (`stateChars`); the text itself never enters the event or the decision —
   *  it survives only in the transport's `llmCall.variables`. */
  readonly state?: string
  /** The raw seam's outcome. Absent when the call threw (carry `error`) or
   *  when the decision abstained before the call. */
  readonly result?: DecideResult<L>
  /** The call's failure, when the raw seam threw. */
  readonly error?: ErrorEventData
  /** The calibration entry applied for (servingClient, spec.key), when one
   *  was. Its cuts win over the policy's static thresholds (F2). */
  readonly calibration?: DecisionCalibrationEntry
  /** The method the resolved client serves — known BEFORE the call (the F3
   *  gate reads it) and the fallback for the F2 comparison when the result
   *  carries none. */
  readonly method?: DecisionMethod
  /** Set by a shadow-mode caller: recorded on the event, changes no verdict. */
  readonly shadow?: true
  /** Refusal established by the caller before invoking the raw seam. */
  readonly unsupportedType?: true
}

/** What the scorer returns: the decision plus the event data the caller
 *  commits as `decision_made`. `decision.eventId` is stamped by the CALLER
 *  after the commit (T2) — the scorer never touches a context. */
export interface ScoredDecision<L extends string = string> {
  readonly decision: Decision<L>
  readonly event: DecisionMadeEventData
}

/**
 * The pure scoring half of `evaluateDecision`: apply the policy to one
 * raw-seam outcome.
 *
 * Abstain order (first reason wins): `no-state` → `unsupported-type` → `error` → `uncalibrated` →
 * `low-coverage` → `method-mismatch` → `low-confidence` → `low-margin`. On
 * every abstain or error the `label` is `policy.fallback` (REQUIRED on every
 * policy, D8 — the seam never throws and never returns without a verdict);
 * `top` stays the argmax of whatever distribution exists, and is `null` only
 * when there is none at all.
 *
 * Distribution handling: the result's probs are restricted to the spec's
 * labels (an unseen label is 0), renormalised to sum to 1 (±1e-6 tolerance is
 * the caller's assert; the arithmetic here divides by the exact total), and
 * `top` breaks ties by the spec's array order — display order IS priority.
 * A result with no usable mass (empty, non-finite, or summing to 0) is an
 * unusable readout and abstains `'error'`, like a throw.
 */
function scoreCategoricalDecision<L extends string>(
  input: DecisionScoring<L>,
  confidenceOf?: (probs: Record<L, number>, labels: readonly L[], top: L) => number,
): ScoredDecision<L> {
  const { spec, policy } = input
  const labels = spec.labels.map((l) => l.id)
  const k = labels.length

  // --- the distribution, if one exists ------------------------------------
  let probs: Record<L, number> = {} as Record<L, number>
  let usable = false
  if (input.result) {
    const mass: Partial<Record<L, number>> = {}
    // A corrupt entry (present but not a finite non-negative number) makes the
    // WHOLE readout unusable: skipping it and renormalising over the rest would
    // invent certainty from a distribution that is demonstrably broken.
    let corrupt = false
    for (const label of labels) {
      const p = (input.result.probs as Record<string, unknown>)[label as string]
      if (p === undefined) continue
      if (typeof p !== 'number' || !Number.isFinite(p) || p < 0) corrupt = true
      else if (p > 0) mass[label] = p
    }
    const normalized = normalizeLabelMass(mass, labels)
    if (!corrupt && normalized.total > 0) {
      probs = normalized.probs
      usable = true
    }
  }

  // --- argmax / margin (array order breaks ties) --------------------------
  const sorted = labels.map((label) => ({ label, p: probs[label] ?? 0 })).sort((a, b) => b.p - a.p)
  const top = usable ? sorted[0].label : null
  const pMax = usable ? sorted[0].p : 0
  const pSecond = usable && sorted.length > 1 ? sorted[1].p : 0
  const margin = pMax - pSecond
  const confidence = confidenceOf
    ? usable
      ? confidenceOf(probs, labels, top as L)
      : 0
    : confidenceFromMax(pMax, k)

  // --- abstain, in order --------------------------------------------------
  const method = input.result?.method ?? input.method
  let abstained: boolean
  let reason: AbstainReason | undefined
  if (typeof input.state !== 'string' || input.state.length === 0) {
    // 1. no-state — there was nothing to decide over. Checked first: the
    //    pre-call gate refuses before the call, so no error can race it.
    abstained = true
    reason = 'no-state'
  } else if (input.unsupportedType === true) {
    abstained = true
    reason = 'unsupported-type'
  } else if (input.error || (input.result && !usable)) {
    // 2. error — the call threw, or came back with no usable distribution
    //    (empty, non-finite, or summing to zero): an unusable readout is the
    //    same fact as a failed one, and neither invented a distribution.
    abstained = true
    reason = 'error'
  } else if (!input.result) {
    // 3. pre-call abstention (F3): no call was made and none threw — the
    //    caller refused it. preCallAbstain already answered; a direct scorer
    //    call that reaches here with a state but neither outcome nor refusal
    //    is an unusable input, not a verdict.
    const pre = preCallAbstain({
      policy: policy as DecisionPolicy<string>,
      state: input.state,
      method: input.method,
    })
    abstained = true
    reason = pre ?? 'error'
  } else if (policy.requireCalibrated === true && input.result.calibrated !== true) {
    // 4. uncalibrated, post-call.
    abstained = true
    reason = 'uncalibrated'
  } else if (
    policy.minCoverage !== undefined &&
    !(
      Number.isFinite(input.result.coverage) &&
      (input.result.coverage as number) >= policy.minCoverage
    )
  ) {
    // 5. low-coverage. An absent coverage fails the floor: unknown beats
    //    silently wrong.
    abstained = true
    reason = 'low-coverage'
  } else {
    // 6.–8. method-mismatch → low-confidence → low-margin (F2).
    const cuts = resolveDecisionCuts(policy as DecisionPolicy<string>, input.calibration, method)
    if ('mismatch' in cuts.minConfidence || 'mismatch' in cuts.minMargin) {
      abstained = true
      reason = 'method-mismatch'
    } else if (cuts.minConfidence.value !== undefined && confidence < cuts.minConfidence.value) {
      abstained = true
      reason = 'low-confidence'
    } else if (cuts.minMargin.value !== undefined && margin < cuts.minMargin.value) {
      abstained = true
      reason = 'low-margin'
    } else {
      abstained = false
    }
  }

  const decision: Decision<L> = {
    key: spec.key,
    label: abstained ? policy.fallback : (top as L),
    top,
    probs,
    margin,
    confidence,
    abstained,
    ...(reason !== undefined && { reason }),
    ...(method !== undefined && { method }),
    calibrated: input.result?.calibrated === true,
    ...(input.result?.coverage !== undefined && { coverage: input.result.coverage }),
  }

  const event: DecisionMadeEventData = {
    key: spec.key,
    question: spec.question,
    labels: spec.labels.map((l) => ({ id: l.id, description: l.description })),
    probs: { ...probs } as Record<string, number>,
    label: decision.label,
    top,
    margin,
    confidence,
    abstained,
    ...(reason !== undefined && { reason }),
    policy: {
      fallback: policy.fallback,
      ...(policy.minConfidence !== undefined && { minConfidence: policy.minConfidence }),
      ...(policy.minMargin !== undefined && { minMargin: policy.minMargin }),
      ...(policy.thresholdMethod !== undefined && { thresholdMethod: policy.thresholdMethod }),
      ...(policy.requireCalibrated !== undefined && {
        requireCalibrated: policy.requireCalibrated,
      }),
      ...(policy.minCoverage !== undefined && { minCoverage: policy.minCoverage }),
    },
    ...(method !== undefined && { method }),
    calibrated: decision.calibrated,
    ...(input.result?.coverage !== undefined && { coverage: input.result.coverage }),
    stateChars: input.state?.length ?? 0,
    ...(input.shadow === true && { shadow: true }),
  }

  return { decision, event }
}

/** Choice math and event bytes retain their pre-addendum shape. */
export function scoreDecision<L extends string>(input: DecisionScoring<L>): ScoredDecision<L> {
  return scoreCategoricalDecision(input)
}

export interface ScoreScoring<L extends string = string> extends Omit<
  DecisionScoring<L>,
  'spec' | 'policy'
> {
  readonly spec: ScoreSpec<L>
  readonly policy: ScorePolicy<L>
}
export interface NoulScoring extends Omit<DecisionScoring<'true' | 'false'>, 'spec' | 'policy'> {
  readonly spec: NoulSpec
  readonly policy: NoulPolicy
}

/** TypeSafe's ordinal concentration, centred on the mode, not the mean.
 *  https://docs.typesafe.ai/confidence — uniform MAD is about the scale midpoint. */
function ordinalConfidence<L extends string>(
  probs: Record<L, number>,
  labels: readonly L[],
  top: L,
): number {
  const mode = labels.indexOf(top)
  const midpoint = (labels.length - 1) / 2
  const uniformMad = labels.reduce((s, _, i) => s + Math.abs(i - midpoint), 0) / labels.length
  const mad = labels.reduce((s, l, i) => s + probs[l] * Math.abs(i - mode), 0)
  return Math.max(0, 1 - mad / uniformMad)
}

/** A score acts on its mode; expected remains the policy-free mean. */
export function scoreScoreDecision<L extends string>(
  input: ScoreScoring<L>,
): {
  readonly decision: ScoreDecision<L>
  readonly event: DecisionMadeEventData
} {
  const scored = scoreCategoricalDecision(
    {
      ...input,
      spec: { key: input.spec.key, question: input.spec.question, labels: input.spec.levels },
      // Neither static nor fitted margin cuts apply to an ordinal concentration.
      calibration: input.calibration && { ...input.calibration, minMargin: undefined },
    },
    ordinalConfidence,
  )
  const { label, margin: _margin, ...common } = scored.decision
  const expected =
    common.top === null
      ? null
      : input.spec.levels.reduce((s, l, i) => s + i * (common.probs[l.id] ?? 0), 0)
  const value = input.spec.levels.findIndex((l) => l.id === label)
  return {
    decision: { ...common, type: 'score', level: label, value, expected },
    event: { ...scored.event, type: 'score', value, expected },
  }
}

/** A noul is P(true), with a symmetric confidence band around 0.5. */
export function scoreNoulDecision(input: NoulScoring): {
  readonly decision: NoulDecision
  readonly event: DecisionMadeEventData
} {
  const scored = scoreCategoricalDecision(
    {
      ...input,
      spec: {
        key: input.spec.key,
        question: input.spec.question,
        labels: [
          { id: 'true', description: input.spec.criteria?.true ?? 'Yes — the statement holds' },
          {
            id: 'false',
            description: input.spec.criteria?.false ?? 'No — the statement does not hold',
          },
        ],
      },
      policy: { ...input.policy, fallback: input.policy.fallback ? 'true' : 'false' },
      calibration: input.calibration && { ...input.calibration, minMargin: undefined },
    },
    (probs) => Math.abs(2 * probs.true - 1),
  )
  const { label, top: _top, margin: _margin, ...common } = scored.decision
  const pTrue = scored.decision.top === null ? null : (common.probs.true ?? 0)
  return {
    decision: { ...common, type: 'noul', holds: label === 'true', pTrue },
    event: { ...scored.event, type: 'noul', pTrue },
  }
}

// ============================================================================
// The awaited wrapper — evaluateDecision / decide / decideFields (T2)
// ============================================================================

/** One raw-seam call to evaluate: the transport, the question, the state, the
 *  consumer's policy. */
export interface DecisionCall<L extends string = string> {
  readonly decide: DecideFn
  readonly spec: DecisionSpec<L>
  /** The text the decision is asked over. Only its LENGTH is recorded. */
  readonly state: string
  readonly policy: DecisionPolicy<L>
  /** A shadow-mode caller: recorded on the event, changes no verdict. */
  readonly shadow?: true
}

/** What {@link evaluateDecision} hands back: the verdict, the event data to
 *  record, and — when something failed — the error to record beside it. */
export interface EvaluatedDecision<L extends string = string> {
  readonly decision: Decision<L>
  readonly event: DecisionMadeEventData
  /** The transport's call record. Rides on the `error` event when `error.kind`
   *  is `'llm_call'` (the call threw), otherwise on `decision_made`: the record
   *  is attached to exactly ONE event, so its cost is counted once. */
  readonly llmCall?: LLMCallRecord
  /** Present when the seam threw OR returned no usable distribution. */
  readonly error?: ErrorEventData
}

/** Options for the in-scope entries. */
export interface DecideOptions {
  /** Which event types the scope records. Default `'decision_made'`. `error`
   *  is always recorded, whatever this says. */
  readonly trackHistory?: TrackHistory
  /** Stamped on the `error` event a failed decision records. Default
   *  `'recoverable'`: a failed decision always has a verdict (the fallback),
   *  so it is the CONSUMER that knows whether the turn can proceed on it. */
  readonly errorSeverity?: 'recoverable' | 'irrecoverable'
}

type Serving = ReturnType<NonNullable<DecideFn['serving']>>

/** What the transport says it will serve. A throwing or absent `serving` is
 *  `{}`: it removes only the pre-call shortcut, never a post-call check. */
function readServing(src: { serving?: DecideFn['serving'] } | undefined, key: string): Serving {
  try {
    return src?.serving?.(key) ?? {}
  } catch {
    return {}
  }
}

function readContextWindow(fn: { limits?: DecideFn['limits'] } | undefined): number {
  try {
    const w = fn?.limits?.().contextWindow
    return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : DEFAULT_CONTEXT_WINDOW
  } catch {
    return DEFAULT_CONTEXT_WINDOW
  }
}

/** The state window when the transport reports none — the router's own default. */
const DEFAULT_CONTEXT_WINDOW = 16_384

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Longest transport message an `error` event carries. */
const MAX_ERROR_CHARS = 500

/** A thrown value → the error event data, carrying the call record when the
 *  adapter attached one (`LLMCallError`). The message is REDACTED of the call's
 *  `state` and capped: a transport that echoes its request (an HTTP client, a
 *  BAML validation error with the prompt) would otherwise copy the state —
 *  which can hold sanitized mail or tool results — into an event that is
 *  JSON-dumped into LLM-facing views (SD-3). The state survives only in
 *  `llmCall.variables`. */
function errorFrom(e: unknown, state?: string): { error: ErrorEventData; llmCall?: LLMCallRecord } {
  const llmCall = e instanceof LLMCallError ? e.llmCall : undefined
  let message = e instanceof Error ? e.message : String(e)
  if (state) message = message.split(state).join('[state]')
  if (message.length > MAX_ERROR_CHARS) message = `${message.slice(0, MAX_ERROR_CHARS)}…`
  return {
    error: { error: message, ...(llmCall ? { kind: 'llm_call' as const } : {}) },
    ...(llmCall ? { llmCall } : {}),
  }
}

/** A raw-seam return the scorer can read: junk (not an object, no `probs`)
 *  becomes an empty distribution, which the scorer reports as an unusable
 *  readout — an error, never a throw. */
function sanitizeResult<L extends string>(raw: unknown, serving: Serving): DecideResult<L> {
  if (!isRecord(raw)) {
    return { probs: {}, method: serving.method ?? 'logprob', calibrated: false } as DecideResult<L>
  }
  return { ...raw, probs: isRecord(raw.probs) ? raw.probs : {} } as unknown as DecideResult<L>
}

interface Outcome<L extends string> {
  readonly result?: DecideResult<L>
  readonly error?: ErrorEventData
  readonly llmCall?: LLMCallRecord
}

/** Score one outcome and assemble the {@link EvaluatedDecision}. */
function settle<L extends string>(
  call: Pick<DecisionCall<L>, 'spec' | 'policy' | 'state' | 'shadow'>,
  serving: Serving,
  outcome: Outcome<L>,
): EvaluatedDecision<L> {
  const { decision, event } = scoreDecision({
    spec: call.spec,
    policy: call.policy,
    state: call.state,
    result: outcome.result,
    error: outcome.error,
    calibration: serving.calibration,
    method: serving.method,
    shadow: call.shadow,
  })
  // `reason: 'error'` covers a throw AND an unusable readout; both must leave
  // an `error` event so a consumer gating on severity has something to read.
  const error =
    outcome.error ??
    (decision.reason === 'error'
      ? { error: `Decision '${call.spec.key}' returned no usable distribution` }
      : undefined)
  const llmCall = outcome.llmCall ?? outcome.result?.llmCall
  return { decision, event, ...(llmCall && { llmCall }), ...(error && { error }) }
}

/** The floor under "never throws": a defect in the scorer itself (a malformed
 *  spec or policy) still yields a verdict. */
function lastResort<L extends string>(call: DecisionCall<L>, e: unknown): EvaluatedDecision<L> {
  const fallback = (call.policy as { fallback: L }).fallback
  const message = e instanceof Error ? e.message : String(e)
  const key = call.spec?.key ?? ''
  return {
    decision: {
      key,
      label: fallback,
      top: null,
      probs: {} as Decision<L>['probs'],
      margin: 0,
      confidence: 0,
      abstained: true,
      reason: 'error',
      calibrated: false,
    },
    event: {
      key,
      question: call.spec?.question ?? '',
      labels: [],
      probs: {},
      label: fallback,
      top: null,
      margin: 0,
      confidence: 0,
      abstained: true,
      reason: 'error',
      policy: { fallback },
      calibrated: false,
      stateChars: typeof call.state === 'string' ? call.state.length : 0,
    },
    error: { error: `Decision '${key}' could not be scored: ${message}` },
  }
}

/**
 * Scope-free: ask the transport what it will serve, call the raw seam, apply
 * the policy, hand back what to record. NEVER throws — the seam throwing, the
 * seam returning junk and a pre-call refusal are all an abstained decision
 * whose `label` is `policy.fallback`. For work that holds a context but no
 * pattern scope (the post-response position); inside a pattern call
 * {@link decide}.
 *
 * The F3 gate runs first: a `requireCalibrated` policy on a client the
 * transport KNOWS is non-calibratable (`decide.serving(key).method ===
 * 'verbalized'`) abstains `'uncalibrated'` without making the call at all.
 */
export async function evaluateDecision<L extends string>(
  call: DecisionCall<L>,
): Promise<EvaluatedDecision<L>> {
  try {
    const serving = readServing(call.decide, call.spec.key)
    if (preCallAbstain({ policy: call.policy, state: call.state, method: serving.method })) {
      return settle(call, serving, {})
    }
    let raw: unknown
    try {
      raw = await call.decide({ spec: call.spec, state: call.state })
    } catch (e) {
      const { error, llmCall } = errorFrom(e, call.state)
      return settle(call, serving, { error, llmCall })
    }
    return settle(call, serving, { result: sanitizeResult<L>(raw, serving) })
  } catch (e) {
    return lastResort(call, e)
  }
}

/** Record one evaluated decision on the scope: exactly ONE `decision_made`,
 *  and — when it failed — ONE `error`. Returns the decision stamped with the
 *  recorded event's id (absent when `trackHistory` filtered the event out). */
function record<L extends string>(
  scope: PatternScope<unknown>,
  evaluated: EvaluatedDecision<L>,
  opts: DecideOptions,
  recordError = true,
): Decision<L> {
  const errorOwnsCall = evaluated.error?.kind === 'llm_call'
  const before = scope.events.length
  trackEvent(
    scope,
    'decision_made',
    evaluated.event,
    opts.trackHistory ?? 'decision_made',
    errorOwnsCall ? undefined : evaluated.llmCall,
  )
  const recorded = scope.events[before]
  const eventId = recorded?.type === 'decision_made' ? recorded.id : undefined
  if (evaluated.error && recordError) {
    trackEvent(
      scope,
      'error',
      {
        ...evaluated.error,
        severity: opts.errorSeverity ?? 'recoverable',
        hint: getErrorHint(evaluated.error.error),
      } as ErrorEventData,
      true,
      errorOwnsCall ? evaluated.llmCall : undefined,
    )
  }
  return eventId ? { ...evaluated.decision, eventId } : evaluated.decision
}

/**
 * In-scope: {@link evaluateDecision} + record exactly ONE `decision_made`
 * (carrying the call record) and, on failure, ONE `error` event (`kind:
 * 'llm_call'` when the throw carried a record). Never throws on a failed
 * decision — the caller always gets a verdict to act on. This is what a
 * wrapper such as `withMemory` calls.
 */
export async function decide<L extends string>(
  scope: PatternScope<unknown>,
  call: DecisionCall<L>,
  opts: DecideOptions = {},
): Promise<Decision<L>> {
  return record(scope, await evaluateDecision(call), opts)
}

// --- decideFields ---------------------------------------------------------

/** Several typed fields over ONE state. */
export interface DecideFieldsCall<F extends Record<string, string>> {
  readonly decide: DecideFn
  /** A one-call provider: the whole set is one request in fields mode.
   *  Jev also uses per-field questions in joint mode (G8). */
  readonly decideAll?: DecideAllFn
  readonly set: DecisionSetSpec<F>
  readonly state: string
  readonly policy: { readonly [K in keyof F]: DecisionPolicy<F[K]> }
}

/** The joint product's size: the number of label combinations. */
function jointProduct(set: DecisionSetSpec<Record<string, string>>): number {
  return Object.values(set.fields).reduce((n, spec) => n * spec.labels.length, 1)
}

/**
 * Refuse a set that cannot be served as declared — a programmer error, so it
 * THROWS (unlike a decision, which never does), and does so before any call:
 * `mode: 'joint'` scores the label PRODUCT in one pass from the same top-k
 * window a single spec reads, so a product above {@link MAX_DECISION_LABELS}
 * cannot be read out faithfully. Call it where the set is declared to fail at
 * construction. This standalone guard has no serving report and also refuses
 * wide Jev joint sets; `decideFields` resolves Jev to fields before calling it.
 */
export function assertDecisionSetSpec(set: DecisionSetSpec<Record<string, string>>): void {
  if (set.mode !== 'joint') return
  const product = jointProduct(set)
  if (product > MAX_DECISION_LABELS) {
    throw new Error(
      `DecisionSetSpec '${set.key}': mode 'joint' scores the ${product}-label product in one ` +
        `pass, above MAX_DECISION_LABELS (${MAX_DECISION_LABELS}) — use mode 'fields'.`,
    )
  }
}

/** Separator of a joint label id (`'a | b | c'`). */
const JOINT_SEP = ' | '

/** The product spec a joint pass scores, and the tuple behind each product id. */
function buildJointSpec(
  set: DecisionSetSpec<Record<string, string>>,
  keys: readonly string[],
): { spec: DecisionSpec<string>; tuples: Map<string, Record<string, string>> } {
  let combos: Array<Record<string, DecisionLabel>> = [{}]
  for (const k of keys) {
    combos = combos.flatMap((c) => set.fields[k].labels.map((l) => ({ ...c, [k]: l })))
  }
  const tuples = new Map<string, Record<string, string>>()
  const labels: DecisionLabel[] = combos.map((c) => {
    const id = keys.map((k) => c[k].id).join(JOINT_SEP)
    if (tuples.has(id)) {
      throw new Error(`DecisionSetSpec '${set.key}': joint label id '${id}' is ambiguous`)
    }
    tuples.set(id, Object.fromEntries(keys.map((k) => [k, c[k].id])))
    return { id, description: keys.map((k) => `${k}: ${c[k].description}`).join('; ') }
  })
  return {
    spec: {
      key: set.key,
      question: `Answer every question, as one combined choice: ${keys
        .map((k, i) => `(${i + 1}) ${set.fields[k].question}`)
        .join(' ')}`,
      labels,
    },
    tuples,
  }
}

/** Marginalise a joint distribution to one field's: sum the combinations that
 *  agree on the field's label. */
function marginalise(
  probs: Readonly<Record<string, number>>,
  tuples: Map<string, Record<string, string>>,
  field: string,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [id, tuple] of tuples) {
    const p = probs[id]
    if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) continue
    out[tuple[field]] = (out[tuple[field]] ?? 0) + p
  }
  return out
}

async function evaluateFields<F extends Record<string, string>>(
  call: DecideFieldsCall<F>,
): Promise<{ readonly [K in keyof F]: EvaluatedDecision<F[K]> }> {
  const { set, state } = call
  const keys = Object.keys(set.fields) as Array<keyof F & string>
  const joint = set.mode === 'joint'
  const src = !joint && call.decideAll ? call.decideAll : call.decide
  const setServing = joint ? readServing(call.decide, set.key) : {}
  const servingOf = (k: string): Serving => {
    const own = readServing(src, set.fields[k as keyof F].key)
    return { method: own.method ?? setServing.method, calibration: own.calibration }
  }
  const callOf = (k: keyof F & string) => ({
    spec: set.fields[k],
    policy: call.policy[k],
    state,
  })

  const out: Record<string, EvaluatedDecision<string>> = {}
  const live: Array<keyof F & string> = []
  for (const k of keys) {
    const serving = servingOf(k)
    if (preCallAbstain({ policy: call.policy[k], state, method: serving.method })) {
      out[k] = settle(callOf(k), serving, {})
    } else live.push(k)
  }

  /** Every live field failed the same way. */
  const failAll = (e: unknown) => {
    const { error, llmCall } = errorFrom(e, state)
    for (const k of live) out[k] = settle(callOf(k), servingOf(k), { error, llmCall })
  }

  if (live.length > 0) {
    try {
      if (joint) {
        const { spec, tuples } = buildJointSpec(set, live)
        let raw: unknown
        let failed = false
        try {
          raw = await call.decide({ spec, state })
        } catch (e) {
          failAll(e)
          failed = true
        }
        if (!failed) {
          const r = sanitizeResult<string>(raw, setServing)
          for (const k of live) {
            out[k] = settle(callOf(k), servingOf(k), {
              result: { ...r, probs: marginalise(r.probs, tuples, k) } as DecideResult<string>,
            })
          }
        }
      } else if (call.decideAll) {
        const subset = {
          key: set.key,
          fields: Object.fromEntries(live.map((k) => [k, set.fields[k]])),
        } as DecisionSetSpec<Record<string, string>>
        const raw: unknown = await call.decideAll({ spec: subset, state })
        const fields = isRecord(raw) && isRecord(raw.fields) ? raw.fields : {}
        for (const k of live) {
          out[k] = settle(callOf(k), servingOf(k), {
            result: sanitizeResult(fields[k], servingOf(k)),
          })
        }
      } else {
        // One pass per field, SEQUENTIAL: the state prefix is byte-identical,
        // so the first pass warms the backend's prefix cache for the rest.
        for (const k of live) {
          let raw: unknown
          try {
            raw = await call.decide({ spec: set.fields[k], state })
          } catch (e) {
            const { error, llmCall } = errorFrom(e, state)
            out[k] = settle(callOf(k), servingOf(k), { error, llmCall })
            continue
          }
          out[k] = settle(callOf(k), servingOf(k), { result: sanitizeResult(raw, servingOf(k)) })
        }
      }
    } catch (e) {
      // A set-wide failure (the one-call provider threw, the joint spec was
      // ambiguous): every field takes it.
      failAll(e)
    }
  }
  return out as { readonly [K in keyof F]: EvaluatedDecision<F[K]> }
}

/**
 * Decide several typed fields over one state — the owner's "ONE call, SEVERAL
 * typed fields". The PROVIDER decides how the set is served:
 *
 *  - `decideAll` present (fields mode, or Jev in any mode): one request, every field
 *    its own typed question;
 *  - `mode: 'joint'` on other transports: the label product scored in ONE `decide` pass and
 *    marginalised back to each field (refused above
 *    {@link MAX_DECISION_LABELS}, see {@link assertDecisionSetSpec});
 *  - otherwise one `decide` pass per field with a byte-identical state.
 *
 * Records ONE `decision_made` PER FIELD — each has its own key, policy and
 * calibration and must be independently attributable — and, when a call
 * failed, one `error` for the set. `decision_made` is excluded from the
 * progress bar's step count, so a four-field set does not add four steps.
 * Throws only for a set refused by {@link assertDecisionSetSpec}.
 */
export async function decideFields<F extends Record<string, string>>(
  scope: PatternScope<unknown>,
  call: DecideFieldsCall<F>,
  opts: DecideOptions = {},
): Promise<{ [K in keyof F]: Decision<F[K]> }> {
  // G8: Jev serves each field as a question, even when joint was requested.
  // Resolve the mode before the product-size guard as no product is sent.
  if (call.set.mode === 'joint' && readServing(call.decide, call.set.key).method === 'jev') {
    call = { ...call, set: { ...call.set, mode: 'fields' } }
  }
  assertDecisionSetSpec(call.set)
  const evaluated = await evaluateFields(call)
  const out: Record<string, Decision<string>> = {}
  let errorRecorded = false
  const seenCalls = new Set<LLMCallRecord>()
  for (const k of Object.keys(call.set.fields)) {
    const ev = evaluated[k as keyof F]
    // A set-wide call record is shared by reference: attach it once.
    const dup = ev.llmCall !== undefined && seenCalls.has(ev.llmCall)
    if (ev.llmCall) seenCalls.add(ev.llmCall)
    // A set-wide failure carries the same message for every field: record one.
    const dupError = ev.error !== undefined && errorRecorded
    if (ev.error) errorRecorded = true
    out[k] = record(scope, dup ? { ...ev, llmCall: undefined } : ev, opts, !dupError)
  }
  return out as { [K in keyof F]: Decision<F[K]> }
}

// ============================================================================
// The patterns — typedDecision and decisionRouter (T2)
// ============================================================================

/** What `typedDecision` writes: the verdict per spec key. Overwritten every
 *  turn, including failures — `scope.data` survives the turn boundary, so a
 *  decision left in place would be last turn's. */
export interface TypedDecisionData {
  decisions?: Record<string, AnyDecision>
}

/** The default decision state: the window's user messages plus FINAL
 *  assistant messages (the router's intermediate status lines are not part of
 *  the conversation), think-blocks stripped, oldest dropped to fit the
 *  transport's window. Tool results are opt-in — pass your own `state`: an
 *  assistant reply can echo untrusted tool content, and what a steered
 *  decision reads is the consumer's call, not a default's. */
function renderDefaultState(view: EventView, fn: DecideFn): string {
  const turns = view
    .get()
    .map((e): ContextEvent => stripThinkBlocks(e))
    .flatMap((e) => {
      if (e.type === 'user_message') {
        return [`User: ${(e.data as UserMessageEventData).content}`]
      }
      if (e.type === 'assistant_message' && (e.data as AssistantMessageEventData).final === true) {
        return [`Assistant: ${(e.data as AssistantMessageEventData).content}`]
      }
      return []
    })
  return trimToFit(turns, (t) => t.join('\n\n'), 300, readContextWindow(fn)).join('\n\n')
}

/** The default window: the router's — recent user/assistant messages across
 *  turns. Soft read of the run frame for the same reason `router()` reads it:
 *  this runs at CONSTRUCTION, which is not a run. */
function defaultDecisionView(customState: boolean): ViewConfig {
  return {
    fromLast: false,
    fromLastNTurns: (currentRunFrame()?.config ?? DEFAULT_RUNTIME_CONFIG).routerTurnWindow,
    // A caller-supplied `state` reads the view itself, so the window must not
    // pre-narrow it to messages — otherwise tool results (opt-in) are invisible
    // to the very builder that asked for them.
    ...(customState ? {} : { eventTypes: ['user_message', 'assistant_message'] as const }),
    contentTransforms: [stripThinkBlocks],
  }
}

function assertFallbackIsALabel(owner: string, spec: DecisionSpec, fallback: string): void {
  if (!spec.labels.some((l) => l.id === fallback)) {
    throw new Error(
      `${owner}: policy.fallback '${fallback}' is not one of the labels of '${spec.key}'`,
    )
  }
}

/** What a deciding pattern declares: its key, and — when its policy requires
 *  calibration — that key again under `calibratedDecisionKeys`, so a host probe
 *  can tell a control that is merely uncalibrated from one that can never
 *  pass (G4). Absent rather than `[]` when the policy does not require it. */
function decisionCapabilities(key: string, policy: DecisionPolicy<string>): PatternCapabilities {
  return {
    decisionKeys: [key],
    ...(policy.requireCalibrated === true && { calibratedDecisionKeys: [key] }),
  }
}

export interface TypedDecisionConfig<L extends string = string> extends PatternConfig {
  /** REQUIRED: the raw decision seam (`bamlPatterns().decide`, or your own). */
  readonly decide: DecideFn
  readonly spec: DecisionSpec<L>
  readonly policy: DecisionPolicy<L>
  /** Render the state the decision is asked over. Default: see
   *  {@link renderDefaultState} — messages only. */
  readonly state?: (view: EventView, data: Readonly<Record<string, unknown>>) => string
}

/**
 * A chain step that asks one closed question and writes the verdict to
 * `scope.data.decisions[spec.key]`. It generates no text and never throws: a
 * failed decision is an abstain onto `policy.fallback`, with an `error` event
 * (recoverable unless configured otherwise) beside the `decision_made`.
 *
 * `data.decisions[spec.key]` is overwritten on EVERY exit.
 *
 * @example
 * typedDecision({ decide: baml.decide, spec: RETRIEVE, policy: { fallback: 'skip', minConfidence: 0.6 } })
 */
export function typedDecision<T extends TypedDecisionData, L extends string>(
  config: TypedDecisionConfig<L>,
): ConfiguredPattern<T> {
  const { decide: decideFn, spec, policy, state: stateFn, ...patternConfig } = config
  assertFallbackIsALabel('typedDecision', spec, policy.fallback)
  const resolved = resolveConfig('typedDecision', {
    viewConfig: defaultDecisionView(stateFn !== undefined),
    ...patternConfig,
  })

  const fn = async (scope: PatternScope<T>, view: EventView): Promise<PatternScope<T>> => {
    let state = ''
    let stateError: ErrorEventData | undefined
    try {
      state = stateFn
        ? stateFn(view, scope.data as unknown as Readonly<Record<string, unknown>>)
        : renderDefaultState(view, decideFn)
    } catch (e) {
      stateError = { error: `typedDecision state builder failed: ${errorFrom(e).error.error}` }
    }
    const decision = await decide(
      scope,
      { decide: decideFn, spec, state, policy },
      { trackHistory: resolved.trackHistory, errorSeverity: resolved.errorSeverity },
    )
    if (stateError) {
      trackEvent(scope, 'error', { ...stateError, severity: resolved.errorSeverity }, true)
    }
    scope.data = { ...scope.data, decisions: { ...scope.data.decisions, [spec.key]: decision } }
    return scope
  }

  return {
    name: 'typedDecision',
    fn,
    config: resolved,
    estimateTurns: () => 1,
    capabilities: decisionCapabilities(spec.key, policy),
  }
}

/** The key `decisionRouter` decides under — what calibration and thresholds
 *  are fitted against. */
export const DECISION_ROUTER_KEY = 'route'

export interface DecisionRouterConfig extends PatternConfig {
  /** REQUIRED: the raw decision seam. */
  readonly decide: DecideFn
  /** `fallback` names the ROUTE taken when the decision abstains or fails. */
  readonly policy: DecisionPolicy<string>
  /** "No tool — just answer": an ORDINARY route key `routes()` dispatches to a
   *  pass-through. Never `DIRECT_RESPONSE_ROUTE`: a decision has no reply text
   *  to pass through, so that sentinel would end the turn empty. */
  readonly conversationalRoute?: { readonly name: string; readonly description: string }
  /** Leave `data.intent` alone (compose after `compactIntent`, which rewrites
   *  it every turn). Default false: clear it, so a conversation migrated from
   *  `router()` cannot carry the old router's intent into the next loop. */
  readonly preserveIntent?: boolean
  /** Record the decision and set NOTHING — run beside `router()` to measure
   *  agreement. A shadow failure is always recoverable. */
  readonly shadow?: boolean
}

/**
 * The decision-typed sibling of `router()`: classifies the latest message
 * into one of `routeDescriptions` (plus `conversationalRoute`) by a
 * probability-typed decision, and sets `data.route`. Pair with `routes()`.
 *
 * What it does NOT produce: the reply text and the rewritten `intent` — compose
 * `compactIntent` first (with `preserveIntent`), and dispatch the
 * conversational route to a pass-through that `compactExecution` answers.
 *
 * Failure parity with `router`: the pattern defaults to `irrecoverable` — a
 * failed decision clears `data.route` (and `routes()` would throw on it) and
 * the turn ends where it happened. `errorSeverity: 'recoverable'` continues on
 * `policy.fallback` instead. An abstain that is not a failure (low confidence)
 * always continues on the fallback.
 */
export function decisionRouter<T extends RouterData & TypedDecisionData>(
  routeDescriptions: Routes,
  config: DecisionRouterConfig,
): ConfiguredPattern<T> {
  const { decide: decideFn, policy, conversationalRoute, preserveIntent, shadow, ...rest } = config
  const labels: DecisionLabel[] = [
    ...Object.entries(routeDescriptions).map(([id, description]) => ({ id, description })),
    ...(conversationalRoute
      ? [{ id: conversationalRoute.name, description: conversationalRoute.description }]
      : []),
  ]
  const ids = labels.map((l) => l.id)
  if (new Set(ids).size !== ids.length) {
    throw new Error('decisionRouter: route names must be unique (check conversationalRoute)')
  }
  if (ids.includes(DIRECT_RESPONSE_ROUTE)) {
    throw new Error(
      `decisionRouter: a route may not be named '${DIRECT_RESPONSE_ROUTE}' — that is the direct-response sentinel, and a decision has no reply to pass through`,
    )
  }
  const spec: DecisionSpec = {
    key: DECISION_ROUTER_KEY,
    question: "Which route should handle the user's latest message?",
    labels,
  }
  assertFallbackIsALabel('decisionRouter', spec, policy.fallback)
  const resolved = resolveConfig('decisionRouter', {
    viewConfig: defaultDecisionView(false),
    ...rest,
  })

  /** Drop the routing carried over from an earlier turn — same rule, same
   *  reason as `router`'s `clearRouting`. */
  const clearRouting = (scope: PatternScope<T>): void => {
    scope.data = { ...scope.data, route: undefined, intent: undefined }
  }

  const fn = async (scope: PatternScope<T>, view: EventView): Promise<PatternScope<T>> => {
    let state = ''
    let stateError: ErrorEventData | undefined
    try {
      state = renderDefaultState(view, decideFn)
    } catch (e) {
      stateError = { error: `decisionRouter state build failed: ${errorFrom(e).error.error}` }
    }
    const decision = await decide(
      scope,
      { decide: decideFn, spec, state, policy, ...(shadow && { shadow: true as const }) },
      {
        trackHistory: resolved.trackHistory,
        errorSeverity: shadow ? 'recoverable' : resolved.errorSeverity,
      },
    )
    if (stateError) {
      trackEvent(
        scope,
        'error',
        { ...stateError, severity: shadow ? 'recoverable' : resolved.errorSeverity },
        true,
      )
    }
    if (shadow) return scope

    // A state that could not be built is a failure like any other: it must not
    // leave last turn's routing in `scope.data` (which survives the turn).
    const failedFatally =
      (decision.reason === 'error' || stateError !== undefined) &&
      resolved.errorSeverity === 'irrecoverable'
    if (failedFatally) {
      clearRouting(scope)
    } else {
      scope.data = {
        ...scope.data,
        route: decision.label,
        ...(preserveIntent ? {} : { intent: undefined }),
      }
    }
    scope.data = { ...scope.data, decisions: { ...scope.data.decisions, [spec.key]: decision } }
    return scope
  }

  return {
    name: 'decisionRouter',
    fn,
    config: resolved,
    estimateTurns: () => 1,
    capabilities: decisionCapabilities(spec.key, policy),
  }
}
