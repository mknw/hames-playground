"""Run from app/: python3 scripts/check-decision-calibration-mutations.py.

Each listed source mutation must turn its named hermetic pin red. Source is
restored in finally, including on interruption. No database/provider setup.
"""
from pathlib import Path
import subprocess
import sys

MATH = 'src/lib/inference/decision-calibration-math.ts'
FEED = 'src/lib/inference/decision-calibration.server.ts'
SMOKE = 'src/lib/inference/scripts/smoke-verda.ts'
REPORT = 'src/lib/inference/decision-calibration-report.ts'
TESTS = 'src/__tests__/lib/inference/'
CASES = [
    ('metrics', MATH, 'brier: brier / samples.length', 'brier: 0', 'math', 'metrics:'),
    ('accuracy', MATH, 'accuracy: correct / samples.length', 'accuracy: 0', 'math', 'metrics:'),
    ('ece', MATH, ': bins.reduce((sum, b) => sum + Math.abs(b.correct - b.p), 0) / samples.length', ': 0', 'math', 'metrics:'),
    ('coverage', MATH, 'coverage.reduce((a, b) => a + b, 0) / coverage.length', '0', 'math', 'metrics:'),
    ('validation', MATH, "throw new Error('Invalid calibration distribution')", 'return { top: "a", p: 1, correct: true, confidence: 1, margin: 1 }', 'math', 'validation:'),
    ('cuts', MATH, 'kept.filter((r) => (type === \'score\' ? r.withinOneCorrect : r.correct)).length /\n          kept.length >=\n          targetAccuracy', 'true', 'math', 'cuts:'),
    ('order-swap', MATH, 'ranked(a).top === ranked(b).top', 'true', 'math', 'order-swap:'),
    ('transform', MATH, 'Math.log(s.probs[label]) / (entry.temperature ?? 1)', 'Math.log(s.probs[label])', 'math', 'transform:'),
    ('bias', MATH, '(entry.bias?.[String.fromCharCode(65 + i)] ?? 0)', '0', 'math', 'transform:'),
    ('fitter', MATH, 'if (!jev) {', 'if (true) {', 'math', 'fitter:'),
    ('valid-feed', FEED, 'configureDecisionCalibration(table)', 'configureDecisionCalibration({})', 'feed', 'valid:'),
    ('missing-feed', FEED, 'export function feedDecisionCalibration(value: unknown): void {', 'export function feedDecisionCalibration(value: unknown): void { if (value === undefined) return;', 'feed', 'missing:'),
    ('contract-metadata', 'src/lib/inference/decision-calibration-contract.json', 'Which capability should handle this request?', 'A stale route question', 'structure', 'contract drift:'),
    ('contract-version', FEED, 'calibrationContract.revision !== CALIBRATION_REVISION ||', 'false ||', 'feed', 'contract revision:'),
    ('fingerprint', FEED, 'specs: CALIBRATION_SPECS,', 'specs: [],', 'feed', 'fingerprint:'),
    ('mismatched-feed', FEED, 'record.fingerprint !== calibrationFingerprint(client) ||', 'false ||', 'feed', 'mismatched:'),
    ('values-feed', FEED, 'cut < 0 || cut > 1', 'cut < -100 || cut > 100', 'feed', 'values:'),
    ('schema-version', FEED, 'value.schemaVersion !== 1 ||', 'false ||', 'feed', 'mismatched:'),
    ('contract-revision', FEED, 'value.contractRevision !== CALIBRATION_REVISION ||', 'false ||', 'feed', 'mismatched:'),
    ('unmeasured-with-values', FEED, 'if (clients.length) refuse()', 'if (false) refuse()', 'feed', 'mismatched:'),
    ('empty-measured', FEED, "value.status !== 'measured' || !clients.length", "value.status !== 'measured'", 'feed', 'mismatched:'),
    ('unknown-entry', FEED, "!['temperature', 'bias', 'minConfidence', 'minMargin', 'n', 'fittedAt'].includes(k)", 'false', 'feed', 'values:'),
    ('sample-count', FEED, '!Number.isInteger(entry.n) ||', 'false ||', 'feed', 'values:'),
    ('timestamp', FEED, '!Number.isFinite(Date.parse(entry.fittedAt))', 'false', 'feed', 'values:'),
    ('temperature-range', FEED, 'entry.temperature <= 0 ||', 'false ||', 'feed', 'values:'),
    ('bias-finite', FEED, '!Number.isFinite((entry.bias as Record<string, number>)[l])', 'false', 'feed', 'values:'),
    ('extra-key', FEED, 'Object.keys(record.entries).length !== keys.length ||', 'false ||', 'feed', 'mismatched:'),
    ('policy-confidence', MATH, ': (labels.length * p - 1) / (labels.length - 1)', ': p', 'math', 'cuts:'),
    ('policy-margin', MATH, 'margin: p - labels[1][1]', 'margin: p', 'math', 'cuts:'),
    ('heldout-fit', REPORT, 'fitCalibration(fit, labels, jev, criteria.accuracyFloor)', 'fitCalibration(holdout, labels, jev, criteria.accuracyFloor)', 'report', 'holdout:'),
    ('g7-verdict', REPORT, 'REOPEN G7(a): Jev measured ECE=', 'PASS: Jev ECE=', 'report', 'verdict:'),
    ('jev-refusal', '../packages/harness-baml/clients.server.ts', 'JEV_CLIENTS.has(client) &&\n                (entry.temperature', 'false &&\n                (entry.temperature', 'feed', 'Jev:'),
    ('corpus-structure', 'evals/decision-calibration-fixtures.json', '"key": "memory.merge"', '"key": "uncovered"', 'structure', 'corpus:'),
    ('scenario-structure', 'evals/run.ts', '  decisionCalibrationScenario,', '', 'structure', 'scenario:'),
    ('host-structure', 'src/lib/inference/config.server.ts', 'feedDecisionCalibration(decisionCalibrationArtifact)', 'void decisionCalibrationArtifact', 'structure', 'host:'),
    ('smoke-structure', SMOKE, '  await smokeDecide()', '', 'structure', 'smoke:'),
    ('smoke-evidence', SMOKE, "result.llmCall?.clientName !== expected || result.method !== 'logprob'", 'false', 'smoke', 'smoke evidence:'),
    ('smoke-distribution', SMOKE, 'probabilities.length !== 2 ||', 'false && probabilities.length !== 2 ||', 'smoke', 'smoke distribution:'),
    ('F1-reopen-false', REPORT, 'jev && measured.ece > criteria.eceCeiling', 'jev && false', 'report', 'verdict:'),
    ('F1-reopen-one', REPORT, 'jev && measured.ece > criteria.eceCeiling', 'jev && measured.ece > 1', 'report', 'verdict:'),
    ('F1-accuracy-default', REPORT, 'accuracyFloor: 0.95', 'accuracyFloor: 0.5', 'report', 'defaults:'),
    ('F1-ece-default', REPORT, 'eceCeiling: 0.05', 'eceCeiling: 0.9', 'report', 'defaults:'),
    ('F1-holdout-leak', REPORT, 'holdout.map((s) => applyFit(s, labels, entry))', 'fit.map((s) => applyFit(s, labels, entry))', 'report', 'holdout:'),
    ('F1-infeasible-entry', REPORT, 'entry: cutFit.retained > 0 ? entry : null', 'entry: entry', 'report', 'artifact:'),
    ('F1-one-key-complete', REPORT, 'Object.keys(entries).length === specs.length', 'Object.keys(entries).length >= 1', 'report', 'artifact:'),
    ('F1-tier-swap', REPORT, "jev ? 'anthropic' : 'verda'", "jev ? 'verda' : 'anthropic'", 'report', 'defaults:'),
    ('F1-split-swap', REPORT, "item.split === 'fit'", "item.split === 'holdout'", 'report', 'holdout:'),
    ('F1-method-ignore', REPORT, "read.method !== (jev ? 'jev' : 'logprob')", 'false', 'report', 'serving:'),
    ('F2-key-env', '../packages/harness-baml/jev-decide.server.ts', "JEV_KEY_ENV = 'JEV_DECISIONS_API_KEY'", "JEV_KEY_ENV = 'RENAMED_DECISION_KEY'", 'structure', 'runbook:'),
    ('F2-old-key-doc', '../docs/testing/decision-calibration.md', 'JEV_DECISIONS_API_KEY', 'OPENROUTER_API_KEY', 'structure', 'runbook:'),
    ('F3-feed-atomic', FEED, '  }\n  configureDecisionCalibration(table)', '    configureDecisionCalibration(table)\n  }', 'feed', 'atomic:'),
    ('F4-model', FEED, 'model: jevRouteModel(),', '', 'feed', 'fingerprint inputs:'),
    ('F4-prompt-files', FEED, "prompt: files['decide.baml'], client: files['local-client.baml']", "prompt: '', client: ''", 'feed', 'fingerprint inputs:'),
    ('F4-revision', FEED, '        revision,', '', 'feed', 'fingerprint inputs:'),
    ('F4-client', FEED, '        client,', '', 'feed', 'fingerprint inputs:'),
    ('F5-pooled-verdict', REPORT, 'REOPEN G7(a): Jev pooled measured ECE=', 'PASS: Jev pooled measured ECE=', 'report', 'pooled:'),
    ('F5-pooled-threshold', REPORT, 'jev && measured.ece > criteria.eceCeiling', 'jev && measured.ece > 1', 'report', 'pooled:'),
    ('F6-blank-zero', REPORT, "raw === undefined || raw.trim() === ''", 'raw === undefined', 'report', 'defaults:'),
    ('F7-bins-five', MATH, 'Math.floor(r.p * 10)', 'Math.floor(r.p * 5)', 'math', 'bins:'),
    ('F7-skip-bias', MATH, "['temperature', ...Object.keys(bias).slice(1)]", "['temperature']", 'math', 'bias-only:'),
    ('F7-temperature-clamp', MATH, 'candidate.temperature < 0.05 || candidate.temperature > 20', 'false', 'math', 'temperature bounds:'),
    ('F7-cut-tiebreak', MATH, 'kept.length > best.retained', 'kept.length >= best.retained', 'math', 'tie-break:'),
    ('F7-reject-all-values', MATH, 'minConfidence: 1, minMargin: 1, retained: 0', 'minConfidence: 0, minMargin: 0, retained: 0', 'math', 'cuts:'),
    ('F8-bias-count', FEED, 'Object.keys(entry.bias).length !== letters.length ||', 'false ||', 'feed', 'values:'),
    ('F1-reopen-boundary', REPORT, 'jev && measured.ece > criteria.eceCeiling', 'jev && measured.ece >= criteria.eceCeiling', 'report', 'verdict boundary:'),
    ('F4-prompt-only', FEED, "prompt: files['decide.baml']", "prompt: ''", 'feed', 'fingerprint inputs:'),
    ('F4-declaration-only', FEED, "client: files['local-client.baml']", "client: ''", 'feed', 'fingerprint inputs:'),
    ('F8-raw-label', REPORT, 'orderSwapAgreementRaw:', 'orderSwapAgreement:', 'report', 'holdout:'),
    ('F8-harness-adapter-calls', 'evals/harness.ts', 'adapterCalls.push(call)', 'void call', 'harness', 'adapter calls:'),

    ('F1-scenario-infeasible-write', 'evals/scenarios/decision-calibration.ts', 'if (report.entry) entries[spec.key] = report.entry', 'entries[spec.key] = report.entry!', 'scenario', 'scenario artifact:'),
    ('F1-scenario-one-key-write', 'evals/scenarios/decision-calibration.ts', 'completeEntries(entries, CALIBRATION_SPECS)', 'Object.keys(entries).length >= 1', 'scenario', 'scenario artifact:'),
    ('F1-scenario-tier-swap', 'evals/scenarios/decision-calibration.ts', 'tier: calibrationTier(jev)', "tier: jev ? 'verda' : 'anthropic'", 'scenario', 'scenario artifact:'),
    ('F5-scenario-pooled-remove', 'evals/scenarios/decision-calibration.ts', 'observations.push(...pool.observations)', 'void pool.observations', 'scenario', 'scenario artifact:'),
    ('F8-scenario-call-remove', 'evals/scenarios/decision-calibration.ts', 'ctx.recordCall(read.llmCall)', 'void read.llmCall', 'scenario', 'scenario artifact:'),

]

# Delta-review-1 residuals only: --round2 selects these independently of the
# completed earlier findings. Every case requires a real assertion failure.
ROUND2_CASES = [
    ('R1-heldout-check-true', REPORT, 'measured.ece <= criteria.eceCeiling,', 'true,', 'report', 'checks:'),
    ('R1-retained-check-true', REPORT, 'retainedAccuracy >= criteria.accuracyFloor', 'true', 'report', 'checks:'),
    ('R1-pooled-check-removed', 'evals/scenarios/decision-calibration.ts', 'checks.push(...pool.checks)', '', 'scenario', 'scenario pooled check:'),
    ('R1-retained-exact-floor', REPORT, 'retainedAccuracy >= criteria.accuracyFloor', 'retainedAccuracy > criteria.accuracyFloor', 'report', 'checks:'),
    ('R1-heldout-exact-ceiling', REPORT, 'measured.ece <= criteria.eceCeiling,', 'measured.ece < criteria.eceCeiling,', 'report', 'verdict boundary:'),
    ('R2-per-key-reopen-half', REPORT, 'jev && measured.ece > criteria.eceCeiling', 'jev && measured.ece > 0.5', 'report', 'moderate ECE:'),
    ('R2-pooled-reopen-half', REPORT, 'jev && measured.ece > criteria.eceCeiling', 'jev && measured.ece > 0.5', 'report', 'moderate ECE:'),
    ('R3-pooled-raw-holdout', REPORT, 'holdout: transformed,', 'holdout: holdout,', 'report', 'pooled fitted holdout:'),
    ('R4-default-revision-x', FEED, 'revision = CALIBRATION_REVISION', 'revision = "x"', 'feed', 'fingerprint default revision:'),
    ('R4-smoke-header-seven', SMOKE, '7. `smokeDecide()` — actual serving client, logprob method, normalized', '7. anything', 'structure', 'smoke:'),
    ('R4-scenario-call-count', 'evals/scenarios/decision-calibration.ts', 'calls++', '', 'scenario', 'scenario artifact:'),
    ('R1-added-nonempty-check-false', REPORT, 'fit.length > 0 && holdout.length > 0', 'false', 'report', 'checks:'),
    ('R1-added-feasible-check-false', REPORT, 'cutFit.retained > 0,', 'false,', 'report', 'checks:'),
]

S5_CASES = [
    ('score-verdict-normal-branch', REPORT, "${scoreAccuracy ?? `retained ${accuracyKind}=${retainedAccuracy ?? 'N/A (none retained)'}`}", "retained ${accuracyKind}=${retainedAccuracy ?? 'N/A (none retained)'}", 'types', 'score-verdict-normal-branch:'),
    ('noul-fit-zero-mass', MATH, 'Math.max(LOG_LOSS_FIT_FLOOR, s.probs[s.truth])', 's.probs[s.truth]', 'types', 'noul-fit-zero-mass:'),
    ('score-mae-sign', MATH, 'mae += Math.abs(', 'mae += (', 'types', 'rps-math:'),
    ('typed-cut-margin', MATH, 'const margins = type ? [0] : [0, ...rows.map((r) => r.margin)]', 'const margins = [0, ...rows.map((r) => r.margin)]', 'types', 'type-cuts:'),
    ('score-rubric-pool', MATH, "(type === 'score' && JSON.stringify(s.levels) !== JSON.stringify(samples[0].levels))", 'false', 'types', 'cumulative-ece:'),
    ('score-brier-divisor', MATH, "(type === 'noul' ? 2 : 1)", '(type ? 2 : 1)', 'types', 'rps-math:'),
    ('choice-pool-label', REPORT, 'const group = `ALL (${type})`', "const group = type === 'choice' ? 'ALL' : `ALL (${type})`", 'types', 'type-pool-gates:'),
    ('score-verdict-exact', REPORT, "; exact accuracy=${retained.metrics?.exactAccuracy ?? 'N/A (none retained)'}", '', 'types', 'score-retained-within-one:'),
    ('type-closed-distribution', MATH, 'ordered.length !== Object.keys(sample.probs).length ||', 'false ||', 'types', 'type-validation:'),
    ('type-truth-validation', MATH, '!labels.some(([label]) => label === sample.truth) ||', 'false ||', 'types', 'type-validation:'),
    ('rps-math', MATH, 'rps: rps / samples.length', 'rps: brier / samples.length', 'types', 'rps-math:'),
    ('score-mae', MATH, 'mae: mae / samples.length', 'mae: 0', 'types', 'rps-math:'),
    ('noul-binary-brier', MATH, "(type === 'noul' ? 2 : 1)", '1', 'types', 'noul-binary-ece:'),
    ('noul-log-loss', MATH, 'logLoss: logLoss / samples.length', 'logLoss: 0', 'types', 'noul-binary-ece:'),
    ('noul-binary-ece', MATH, '? binaryEce(binaryRows)', '? bins.reduce((sum, b) => sum + Math.abs(b.correct - b.p), 0) / samples.length', 'types', 'noul-binary-ece:'),
    ('cumulative-ece', MATH, '? cumulativeRows.reduce((sum, rows) => sum + binaryEce(rows), 0) / cumulativeRows.length', '? binaryEce(samples.map((s) => [ranked(s).confidence, Number(ranked(s).correct)]))', 'types', 'cumulative-ece:'),
    ('score-concentration', MATH, '? ordinalConfidence', '? (labels.length * p - 1) / (labels.length - 1)', 'types', 'type-confidence:'),
    ('score-within-one-cut', MATH, "type === 'score' ? r.withinOneCorrect : r.correct", 'r.correct', 'types', 'type-cuts:'),
    ('score-fitting-loss', MATH, "samples[0].type === 'score' ? m.rps!", "samples[0].type === 'score' ? m.brier", 'types', 'type-fitting-loss:'),
    ('noul-fitting-loss', MATH, "if (samples[0].type === 'noul')", "if (false)", 'types', 'type-fitting-loss:'),
    ('feed-refuses-margin-on-score-noul', FEED, "if (spec.type !== 'choice' && Object.hasOwn(entry, 'minMargin')) refuse()", "if (false) refuse()", 'feed', 'feed-refuses-margin-on-score-noul:'),
    ('feed-type-bias', FEED, 'Object.keys(entry.bias).length !== letters.length ||', 'false ||', 'feed', 'feed-type-bias:'),
    ('fingerprint-includes-type', FEED, 'specs: CALIBRATION_SPECS,', 'specs: CALIBRATION_SPECS.map(({ type: _type, ...spec }) => spec),', 'feed', 'fingerprint-includes-type:'),
    ('fingerprint-level-criteria', FEED, 'specs: CALIBRATION_SPECS,', 'specs: CALIBRATION_SPECS.map(({ key, question, type }) => ({ key, question, type })),', 'feed', 'fingerprint-type-details:'),
    ('noul-counted-as-agreeing', REPORT, "? 'N/A (native noul has no option order)'", '? 1', 'types', 'noul counted as agreeing:'),
    ('empty-pool-passes', REPORT, "false, 'no data'", "true, 'no data'", 'types', 'empty pool passes:'),
    ('type-pool-gate', REPORT, 'measured.ece <= criteria.eceCeiling,', 'true,', 'types', 'type-pool-gates:'),
    ('score-retained-exact', REPORT, "? retained.metrics?.withinOneAccuracy", '? retained.metrics?.accuracy', 'types', 'score-retained-within-one:'),
    ('score-swap-remove', REPORT, 'levels: [...spec.levels].reverse()', 'levels: spec.levels', 'types', 'score swap:'),
    ('logloss-json-null', REPORT, "? String(v)", '? null', 'types', 'infinite-log-loss-report:'),
    ('scenario-type-pool-removed', 'evals/scenarios/decision-calibration.ts', "['choice', 'score', 'noul'] as const", "['choice'] as const", 'scenario', 'scenario artifact:'),
]

# The distribution mutation disables the whole shape guard, rather than only
# its first clause. Extract it using its stable error line.
def mutation(path, old, new, name):
    source = path.read_text()
    if name == 'smoke-distribution':
        start = source.index('  if (\n    probabilities.length')
        end = source.index("    throw new Error('Decide returned", start)
        return source, source[:start] + '  if (false) {\n' + source[end:]
    if old not in source:
        raise RuntimeError(f'{name}: mutation anchor missing')
    if name in ['F1-reopen-false', 'F1-reopen-one', 'F1-reopen-boundary', 'R1-heldout-check-true', 'R1-heldout-exact-ceiling', 'R2-per-key-reopen-half']:
        before, after = source.rsplit(old, 1)
        return source, before + new + after
    return source, source.replace(old, new, 1)

if __name__ == '__main__':
    cases = S5_CASES if '--s5' in sys.argv else ROUND2_CASES if '--round2' in sys.argv else CASES + ROUND2_CASES + S5_CASES
    for name, filename, old, new, suite, test_name in cases:
        path = Path(filename)
        source, changed = mutation(path, old, new, name)
        try:
            path.write_text(changed)
            result = subprocess.run(['pnpm', 'exec', 'vitest', 'run', '--config', 'scripts/vitest-decision-calibration.config.ts', (f'scripts/decision-calibration-{suite}.test.ts' if suite in ['harness', 'scenario'] else TESTS + f'decision-calibration-{suite}.test.ts'), '-t', test_name], capture_output=True, text=True)
            output = result.stdout + result.stderr
            # A loader/compiler error is NOT proof the assertion detects it.
            if result.returncode == 0 or 'AssertionError' not in output:
                print(output)
                raise RuntimeError(f'{name}: mutation did not produce an assertion failure')
            print(f'{name}: RED (assertion failed), restored', flush=True)
        finally:
            path.write_text(source)
