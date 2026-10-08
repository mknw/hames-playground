#!/usr/bin/env python3
"""S4 source mutations. Run from app/; every change restores in finally.
Only a pin assertion failure counts as RED (not a loader/compiler failure).
"""
from pathlib import Path
import os
import subprocess
import sys

JEV = Path('../packages/harness-baml/jev-decide.server.ts')
ADAPTER = Path('../packages/harness-baml/baml-adapters.server.ts')
PIN = 'src/__tests__/lib/harness-patterns/jev-decide.test.ts'
CASES = [
    ('jev-score-wire', JEV, "type: 'score',\n            instructions", "type: 'choice',\n            instructions", 'jev-score-wire'),
    ('jev-score-extra-index', JEV, 'Object.keys(probsIn).some((k) => !indices.includes(k))', 'false', 'jev-score-closed-levels.*extra'),
    ('jev-score-missing-index', JEV, 'const p = probsIn[indices[i]]', 'const p = probsIn[indices[i]] ?? 0', 'jev-score-closed-levels.*missing'),
    ('jev-score-out-of-range-index', JEV, 'Object.keys(probsIn).some((k) => !indices.includes(k))', 'false', 'jev-score-closed-levels.*negative index'),
    ('jev-score-mass', JEV, 'Math.abs(sum - 1) > JEV_MASS_TOLERANCE', 'false', 'jev-score-closed-levels.*missing mass'),
    ('jev-score-probability-bounds', JEV, 'p < 0 || p > 1', 'false', 'jev-score-closed-levels.*negative probability'),
    ('jev-score-mean-crosscheck', JEV, 'Math.abs(a.score - expected) > 0.01 * (labels.length - 1)', 'false', 'jev-score-mean-crosscheck'),
    ('jev-score-level-cap', JEV, 'field.levels.length < 2 || field.levels.length > MAX_SCORE_LEVELS', 'false', 'jev-score-wire.*refuses'),
    ('jev-noul-wire', JEV, "type: 'noul',\n            instructions", "type: 'choice',\n            instructions", 'jev-noul-calibrated.*native noul'),
    ('jev-noul-calibrated', JEV, 'calibrated: true,', "calibrated: typeof a.confidence === 'number',", 'jev-noul-calibrated.*native noul'),
    ('jev-noul-bounds', JEV, 'a.noul < 0 ||\n          a.noul > 1', 'false', 'jev-noul-calibrated.*invalid noul'),
    ('jev-supported-types', JEV, "value: Object.freeze(['choice', 'score', 'noul'] as const)", "value: Object.freeze(['choice'] as const)", 'jev-supported-types'),
    ('jev-supported-types-same-resolver', ADAPTER, 'const { transport, wired } = selectDecideTransport()', "const transport = 'jev'; const wired = true", 'jev-supported-types'),
]

if __name__ == '__main__':
    cases = list(CASES)
    source = JEV.read_text()
    lock_start = source.index('    // THE TIER LOCK')
    lock_end = source.index('    // Only the permitted tier', lock_start)
    lock = source[lock_start:lock_end]
    # Keep the locks themselves intact; the violation is construction BEFORE them.
    cases.append(('jev-tier-lock-score-noul', JEV, source,
                  (source[:lock_start] + source[lock_end:]).replace(
                      '    const rawInput = JSON.stringify(body)\n',
                      '    const rawInput = JSON.stringify(body)\n\n' + lock),
                  'jev-tier-lock score/noul'))
    for name, path, old, new, test in cases:
        if len(sys.argv) > 1 and name not in sys.argv[1:]:
            continue
        original = path.read_text()
        if original.count(old) != 1:
            raise RuntimeError(f'{name}: expected exactly one mutation anchor')
        try:
            path.write_text(original.replace(old, new, 1))
            result = subprocess.run(
                ['pnpm', 'exec', 'vitest', 'run', '--config',
                 'scripts/vitest-decision-calibration.config.ts', PIN, '-t', test],
                capture_output=True, text=True,
                env={**os.environ, 'BAML_LOG': 'warn',
                     'TEST_DATABASE_URL': 'postgresql://x:x@127.0.0.1:59999/x'})
            output = result.stdout + result.stderr
            if result.returncode == 0 or 'AssertionError' not in output:
                print(output)
                raise RuntimeError(f'{name}: no assertion RED')
            print(f'{name}: RED, restored', flush=True)
        finally:
            path.write_text(original)
