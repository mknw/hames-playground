"""Run from app/: python3 scripts/check-decision-calibration-mutations.py.

Each listed source mutation must turn its named hermetic pin red. Source is
restored in finally, including on interruption. No database/provider setup.
"""
from pathlib import Path
import subprocess

MATH = 'src/lib/inference/decision-calibration-math.ts'
FEED = 'src/lib/inference/decision-calibration.server.ts'
SMOKE = 'src/lib/inference/scripts/smoke-verda.ts'
TESTS = 'src/__tests__/lib/inference/'
CASES = [
    ('metrics', MATH, 'brier: brier / samples.length', 'brier: 0', 'math', 'metrics:'),
    ('accuracy', MATH, 'accuracy: correct / samples.length', 'accuracy: 0', 'math', 'metrics:'),
    ('ece', MATH, 'ece: bins.reduce((sum, b) => sum + Math.abs(b.correct - b.p), 0) / samples.length', 'ece: 0', 'math', 'metrics:'),
    ('coverage', MATH, 'coverage.reduce((a, b) => a + b, 0) / coverage.length', '0', 'math', 'metrics:'),
    ('validation', MATH, "throw new Error('Invalid calibration distribution')", 'return { top: "a", p: 1, correct: true, confidence: 1, margin: 1 }', 'math', 'validation:'),
    ('cuts', MATH, 'kept.filter((r) => r.correct).length / kept.length >= targetAccuracy', 'true', 'math', 'cuts:'),
    ('order-swap', MATH, 'ranked(a).top === ranked(b).top', 'true', 'math', 'order-swap:'),
    ('transform', MATH, 'Math.log(s.probs[label]) / (entry.temperature ?? 1)', 'Math.log(s.probs[label])', 'math', 'transform:'),
    ('bias', MATH, '(entry.bias?.[String.fromCharCode(65 + i)] ?? 0)', '0', 'math', 'transform:'),
    ('fitter', MATH, 'if (!jev) {', 'if (true) {', 'math', 'fitter:'),
    ('valid-feed', FEED, 'configureDecisionCalibration(table)', 'configureDecisionCalibration({})', 'feed', 'valid:'),
    ('missing-feed', FEED, 'export function feedDecisionCalibration(value: unknown): void {', 'export function feedDecisionCalibration(value: unknown): void { if (value === undefined) return;', 'feed', 'missing:'),
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
    ('policy-confidence', MATH, 'confidence: (labels.length * p - 1) / (labels.length - 1)', 'confidence: p', 'math', 'cuts:'),
    ('policy-margin', MATH, 'margin: p - labels[1][1]', 'margin: p', 'math', 'cuts:'),
    ('heldout-fit', 'evals/scenarios/decision-calibration.ts', 'fitCalibration(fit, labels, jev, accuracyFloor)', 'fitCalibration(holdout, labels, jev, accuracyFloor)', 'structure', 'scenario:'),
    ('g7-verdict', 'evals/scenarios/decision-calibration.ts', 'REOPEN G7(a): Jev measured ECE=', 'PASS: Jev ECE=', 'structure', 'scenario:'),
    ('jev-refusal', '../packages/harness-baml/clients.server.ts', 'JEV_CLIENTS.has(client) &&\n                (entry.temperature', 'false &&\n                (entry.temperature', 'feed', 'Jev:'),
    ('corpus-structure', 'evals/decision-calibration-fixtures.json', '"key": "memory.merge"', '"key": "uncovered"', 'structure', 'corpus:'),
    ('scenario-structure', 'evals/run.ts', '  decisionCalibrationScenario,', '', 'structure', 'scenario:'),
    ('host-structure', 'src/lib/inference/config.server.ts', 'feedDecisionCalibration(decisionCalibrationArtifact)', 'void decisionCalibrationArtifact', 'structure', 'host:'),
    ('smoke-structure', SMOKE, '  await smokeDecide()', '', 'structure', 'smoke:'),
    ('smoke-evidence', SMOKE, "result.llmCall?.clientName !== expected || result.method !== 'logprob'", 'false', 'smoke', 'smoke evidence:'),
    ('smoke-distribution', SMOKE, 'probabilities.length !== 2 ||', 'false && probabilities.length !== 2 ||', 'smoke', 'smoke distribution:'),
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
    return source, source.replace(old, new, 1)

if __name__ == '__main__':
    for name, filename, old, new, suite, test_name in CASES:
        path = Path(filename)
        source, changed = mutation(path, old, new, name)
        try:
            path.write_text(changed)
            result = subprocess.run(['pnpm', 'exec', 'vitest', 'run', '--config', 'scripts/vitest-decision-calibration.config.ts', TESTS + f'decision-calibration-{suite}.test.ts', '-t', test_name], capture_output=True, text=True)
            output = result.stdout + result.stderr
            # A loader/compiler error is NOT proof the assertion detects it.
            if result.returncode == 0 or 'AssertionError' not in output:
                print(output)
                raise RuntimeError(f'{name}: mutation did not produce an assertion failure')
            print(f'{name}: RED (assertion failed), restored', flush=True)
        finally:
            path.write_text(source)
