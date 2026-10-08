#!/usr/bin/env python3
"""S3 mutation evidence. Run from app/; every mutation restores in finally.
A RED requires an assertion failure, never a compiler/loader error.
"""
from pathlib import Path
import subprocess
import sys

ADAPTER = Path('../packages/harness-baml/baml-adapters.server.ts')
LOGPROB = 'src/__tests__/lib/harness-patterns/decide-adapter.test.ts'
VERBALIZED = 'src/__tests__/lib/harness-patterns/decide-verbalized.test.ts'
CASES = [
    ('score-order-preserved', 'return spec.levels', 'return [...spec.levels].reverse()', [LOGPROB, VERBALIZED], 'score-order-preserved'),
    ('noul-letter-mapping',
     """        { id: 'true', description: spec.criteria?.true ?? 'Yes — the statement holds' },
        { id: 'false', description: spec.criteria?.false ?? 'No — the statement does not hold' },""",
     """        { id: 'false', description: spec.criteria?.false ?? 'No — the statement does not hold' },
        { id: 'true', description: spec.criteria?.true ?? 'Yes — the statement holds' },""",
     [LOGPROB, VERBALIZED], 'noul-letter-mapping'),
    ('score-fixture-renormalisation', 'normalizeLabelMass(calibrateLabelMass(mass, entry), letters)', '({ probs: mass })', [LOGPROB], 'score-order-preserved'),
    ('noul-fixture-renormalisation', 'normalizeLabelMass(calibrateLabelMass(mass, entry), letters)', '({ probs: mass })', [LOGPROB], 'noul-letter-mapping'),
    ('per-letter-calibration', 'calibrateLabelMass(mass, entry)', 'mass', [LOGPROB], 'per-letter-calibration'),
    ('supported-types-same-resolver', 'const { transport, wired } = selectDecideTransport()', "const transport = 'jev'; const wired = true", [LOGPROB], 'supported-types-same-resolver'),
    ('secondary-supported-types', "options.verbalized.supportedTypes ?? CHOICE_DECISION_TYPES", 'LETTER_DECISION_TYPES', [LOGPROB], 'secondary-supported-types'),
    ('unknown-type-backstop', 'throw new Error(`Unsupported decision type: ${String((spec as AnyDecisionSpec).type)}`)', 'return (spec as unknown as { labels: readonly DecisionLabel[] }).labels', [LOGPROB], 'unknown-type adapter backstop'),
    ('logprob-score-cap', "const cap = spec.type === 'score' ? MAX_SCORE_LEVELS : MAX_DECISION_LABELS", 'const cap = MAX_DECISION_LABELS', [LOGPROB], 'score transport cap', 1),
    ('verbalized-score-cap', "const cap = spec.type === 'score' ? MAX_SCORE_LEVELS : MAX_DECISION_LABELS", 'const cap = MAX_DECISION_LABELS', [VERBALIZED], 'score transport cap', 2),
    ('verbalized-supported-types', "Object.defineProperty(fn, 'supportedTypes', { value: LETTER_DECISION_TYPES })", "Object.defineProperty(fn, 'supportedTypes', { value: CHOICE_DECISION_TYPES })", [VERBALIZED], 'score-order-preserved'),
    ('verbalized-type-lock', "if (!onExplicitAnthropicTier()) {", 'if (false) {', [VERBALIZED], 'score/noul tier lock'),
]

if __name__ == '__main__':
    for case in CASES:
        if len(sys.argv) > 1 and case[0] not in sys.argv[1:]:
            continue
        name, old, new, pins, test = case[:5]
        occurrence = case[5] if len(case) > 5 else 1
        source = ADAPTER.read_text()
        parts = source.split(old)
        if len(parts) <= occurrence:
            raise RuntimeError(f'{name}: missing mutation anchor')
        try:
            ADAPTER.write_text(old.join(parts[:occurrence]) + new + old.join(parts[occurrence:]))
            for pin in pins:
                result = subprocess.run(['pnpm', 'exec', 'vitest', 'run', '--config', 'scripts/vitest-decision-calibration.config.ts', pin, '-t', test], capture_output=True, text=True)
                output = result.stdout + result.stderr
                if result.returncode == 0 or 'AssertionError' not in output:
                    print(output)
                    raise RuntimeError(f'{name}: no assertion RED in {pin}')
                print(f'{name}: RED ({Path(pin).name}), restored', flush=True)
        finally:
            ADAPTER.write_text(source)
