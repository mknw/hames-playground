#!/usr/bin/env python3
"""S1 pins: run from app/. Every mutation restores source in finally.
Runtime pins must fail an assertion; type pins must fail their named TS assertion.
"""
from pathlib import Path
import subprocess

CORE = '../packages/harness-patterns/patterns/typedDecision.server.ts'
TYPES = '../packages/harness-patterns/types.ts'
PIN = '__tests__/score-noul.test.ts'
CASES = [
    ('unsupported-type-fails-closed', CORE, "input.spec && !(input.supportedTypes ?? ['choice']).includes(input.spec.type ?? 'choice')", 'false', 'unsupported-type-fails-closed'),
    ('score-math', CORE, 'return Math.max(0, 1 - mad / uniformMad)', 'return confidenceFromMax(probs[top], labels.length)', 'score-math'),
    ('noul-math', CORE, 'confidence < cuts.minConfidence.value', 'false', 'noul-math'),
    ('choice-byte-identical', CORE, 'const event: DecisionMadeEventData = {', "const event: DecisionMadeEventData = { type: 'choice',", 'choice-byte-identical'),
    ('score-levels-cap', CORE, 'labels.length < 2 || labels.length > cap', 'false', 'score-levels-cap'),
    ('decision-state-sentinel', CORE, 'const event: DecisionMadeEventData = {', 'const event: DecisionMadeEventData = { state: input.state,', 'decision-state-sentinel score/noul'),
]
TYPE_CASES = [
    ('decision-seam-structural', TYPES, 'readonly supportedTypes?: readonly DecisionType[]', 'readonly supportedTypes: readonly DecisionType[]', 'typed-decision-patterns.test.ts'),
    ('readDecision-inferred-level', TYPES, '? ScoreDecision<L>', '? ScoreDecision<string>', 'score-noul.test.ts'),
]


ADAPTER = '../packages/harness-baml/baml-adapters.server.ts'
JEV = '../packages/harness-baml/jev-decide.server.ts'
PROJECTION = '../packages/harness-patterns/observability/projection.ts'
GUARD = """    if (spec.type !== undefined && spec.type !== 'choice') {
      throw new Error(`Unsupported decision type: ${String(spec.type)}`)
    }
"""
ADAPTER_PIN = 'S1 unsupported-type adapter backstop'
CASES += [
    ('F1-delete-private-logprob-guard', ADAPTER, GUARD, '', ADAPTER_PIN),
    ('F2-logprob-deny-list', ADAPTER, "spec.type !== undefined && spec.type !== 'choice'", "spec.type === 'score' || spec.type === 'noul'", ADAPTER_PIN),
    ('F2-verbalized-deny-list', ADAPTER, "spec.type !== undefined && spec.type !== 'choice'", "spec.type === 'score' || spec.type === 'noul'", ADAPTER_PIN, 2),
    ('F2-jev-deny-list', JEV, "input.spec.type !== undefined && input.spec.type !== 'choice'", "input.spec.type === 'score' || input.spec.type === 'noul'", ADAPTER_PIN),
    ('F3-drop-score-runtime-strip', CORE, 'policy: { ...input.policy, minMargin: undefined },', 'policy: input.policy,', 'rejects wider margin policies'),
    ('F4-uniform-MAD-centred-on-mode', CORE, 's + Math.abs(i - midpoint)', 's + Math.abs(i - mode)', 'score-math'),
    ('F4-last-tied-maximum', CORE, '.sort((a, b) => b.p - a.p)', '.sort((a, b) => b.p - a.p || labels.indexOf(b.label) - labels.indexOf(a.label))', 'score-math'),
    ('F5-swap-noul-label-order', CORE, """          { id: 'true', description: input.spec.criteria?.true ?? 'Yes — the statement holds' },
          {
            id: 'false',
            description: input.spec.criteria?.false ?? 'No — the statement does not hold',
          },""", """          {
            id: 'false',
            description: input.spec.criteria?.false ?? 'No — the statement does not hold',
          },
          { id: 'true', description: input.spec.criteria?.true ?? 'Yes — the statement holds' },""", 'noul-math'),
    ('F5-ignore-noul-criteria', CORE, "input.spec.criteria?.true ?? 'Yes — the statement holds'", "'Yes — the statement holds'", 'noul-math'),
]
TYPE_CASES += [
    ('F3-drop-score-never-margin', TYPES, "Omit<DecisionPolicy<L>, 'minMargin'> & {\n  readonly minMargin?: never\n}", "Omit<DecisionPolicy<L>, 'minMargin'>", 'score-noul.test.ts'),
]
# Re-run every named reviewer mutation, including their verified/no-action list.
CASES += [
    ('review-confidence-centred-on-mean', CORE, 'const mode = labels.indexOf(top)', 'const mode = labels.reduce((s, l, i) => s + i * probs[l], 0)', 'score-math'),
    ('review-value-rounded-mean', CORE, 'const value = input.spec.levels.findIndex((l) => l.id === label)', 'const value = Math.round(expected ?? 0)', 'score-math'),
    ('review-one-based-expected', CORE, 's + i * (common.probs[l.id] ?? 0)', 's + (i + 1) * (common.probs[l.id] ?? 0)', 'score-math'),
    ('review-noul-confidence-without-abs', CORE, 'Math.abs(2 * probs.true - 1)', '2 * probs.true - 1', 'noul-math'),
    ('review-pTrue-reads-false', CORE, '(common.probs.true ?? 0)', '(common.probs.false ?? 0)', 'noul-math'),
    ('review-noul-fallback-inverted', CORE, "fallback: input.policy.fallback ? 'true' : 'false'", "fallback: input.policy.fallback ? 'false' : 'true'", 'noul-math'),
    ('review-readDecision-ignores-type', CORE, "if (!d || (d.type ?? 'choice') !== (spec.type ?? 'choice')) return undefined", 'if (!d) return undefined', 'readDecision type inference'),
    ('review-unsupported-after-error', CORE, """  } else if (input.unsupportedType === true) {
    abstained = true
    reason = 'unsupported-type'
  } else if (input.error || (input.result && !usable)) {""", """  } else if (input.error || (input.result && !usable)) {""", 'unsupported-type', 1, ("  } else if (!input.result) {", """  } else if (input.unsupportedType === true) {
    abstained = true
    reason = 'unsupported-type'
  } else if (!input.result) {""")),
    ('review-score-keeps-fitted-margin', CORE, 'calibration: input.calibration && { ...input.calibration, minMargin: undefined },', 'calibration: input.calibration,', 'uses fitted confidence cuts'),
    ('review-uniqueness-check-off', CORE, 'new Set(labels.map((l) => l.id)).size !== labels.length', 'false', 'score-levels-cap'),
    ('review-score-cap-20', TYPES, 'MAX_SCORE_LEVELS = 10', 'MAX_SCORE_LEVELS = 20', 'score-levels-cap'),
    ('review-expected-on-unusable-readout', CORE, """    common.top === null
      ? null
      : input.spec.levels.reduce((s, l, i) => s + i * (common.probs[l.id] ?? 0), 0)""", 'input.spec.levels.reduce((s, l, i) => s + i * (common.probs[l.id] ?? 0), 0)', 'corrupt mass'),
    ('review-score-event-drops-type', CORE, "event: { ...scored.event, type: 'score', value, expected }", 'event: { ...scored.event, value, expected }', 'score-math'),
    ('review-preview-drops-expected', PROJECTION, "`${d.key}: ${d.label} (E=${d.expected?.toFixed(2) ?? 'unknown'})`", '`${d.key}: ${d.label}`', 'decision-state-sentinel score/noul'),
]

if __name__ == '__main__':
    for case in CASES + TYPE_CASES:
        name, filename, old, new, test = case[:5]
        occurrence = case[5] if len(case) > 5 else 1
        path = Path(filename)
        source = path.read_text()
        if old not in source:
            raise RuntimeError(f'{name}: missing mutation anchor')
        try:
            parts = source.split(old)
            if len(parts) <= occurrence:
                raise RuntimeError(f'{name}: missing occurrence {occurrence}')
            mutated = old.join(parts[:occurrence]) + new + old.join(parts[occurrence:])
            if len(case) > 6:
                old2, new2 = case[6]
                if old2 not in mutated:
                    raise RuntimeError(f'{name}: missing second anchor')
                mutated = mutated.replace(old2, new2, 1)
            path.write_text(mutated)
            if name in [x[0] for x in TYPE_CASES]:
                command = ['pnpm', 'typecheck']
            elif test == ADAPTER_PIN:
                command = ['pnpm', 'test:run', 'src/__tests__/lib/harness-patterns/decide-adapter.test.ts', '-t', test]
            else:
                command = ['pnpm', 'exec', 'vitest', 'run', '--config', '../packages/harness-patterns/vitest.config.ts', '--root', '../packages/harness-patterns', PIN, '-t', test]
            result = subprocess.run(command, capture_output=True, text=True)
            output = result.stdout + result.stderr
            red = result.returncode != 0 and (test in output if name in [x[0] for x in TYPE_CASES] else 'AssertionError' in output)
            if not red:
                print(output)
                raise RuntimeError(f'{name}: did not redden the intended pin')
            print(f'{name}: RED, restored', flush=True)
        finally:
            path.write_text(source)
