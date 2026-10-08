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

if __name__ == '__main__':
    for name, filename, old, new, test in CASES + TYPE_CASES:
        path = Path(filename)
        source = path.read_text()
        if old not in source:
            raise RuntimeError(f'{name}: missing mutation anchor')
        try:
            path.write_text(source.replace(old, new, 1))
            if name in [x[0] for x in TYPE_CASES]:
                command = ['pnpm', 'typecheck']
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
