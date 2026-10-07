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
 * T2 adds the pattern half on top of these exports: `evaluateDecision` (the
 * awaited wrapper — resolve the client, call the raw seam, score), `decide`
 * (the never-throwing consumer entry) and `decideFields`, plus the
 * `typedDecision` chain step and `decisionRouter`.
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
import type {
  AbstainReason,
  Decision,
  DecisionCalibrationEntry,
  DecisionMadeEventData,
  DecisionMethod,
  DecisionPolicy,
  DecisionSpec,
  DecideResult,
  ErrorEventData,
  LLMCallRecord,
} from '../types'

assertServerOnImport()

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
const TOKEN_LEAD = /[\s'"({\[⟦]/

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
  readonly policy: DecisionPolicy<string>
  readonly state?: string
  readonly method?: DecisionMethod
}): AbstainReason | null {
  if (typeof input.state !== 'string' || input.state.length === 0) return 'no-state'
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
  readonly llmCall?: LLMCallRecord
  /** Set by a shadow-mode caller: recorded on the event, changes no verdict. */
  readonly shadow?: true
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
 * Abstain order (first reason wins): `no-state` → `error` → `uncalibrated` →
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
export function scoreDecision<L extends string>(input: DecisionScoring<L>): ScoredDecision<L> {
  const { spec, policy } = input
  const labels = spec.labels.map((l) => l.id)
  const k = labels.length

  // --- the distribution, if one exists ------------------------------------
  let probs: Record<L, number> = {} as Record<L, number>
  let usable = false
  if (input.result) {
    const mass: Partial<Record<L, number>> = {}
    for (const label of labels) {
      const p = (input.result.probs as Record<string, number | undefined>)[label as string]
      if (typeof p === 'number' && Number.isFinite(p) && p > 0) mass[label] = p
    }
    const normalized = normalizeLabelMass(mass, labels)
    if (normalized.total > 0) {
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
  const confidence = confidenceFromMax(pMax, k)

  // --- abstain, in order --------------------------------------------------
  const method = input.result?.method ?? input.method
  let abstained: boolean
  let reason: AbstainReason | undefined
  if (typeof input.state !== 'string' || input.state.length === 0) {
    // 1. no-state — there was nothing to decide over. Checked first: the
    //    pre-call gate refuses before the call, so no error can race it.
    abstained = true
    reason = 'no-state'
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
