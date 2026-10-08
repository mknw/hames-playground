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
FAKE = Path('e2e/lib/fake-llm.ts')
PIN = 'src/__tests__/lib/harness-patterns/jev-decide.test.ts'
CASES = [
    ('jev-score-wire', JEV, "type: 'score',\n            instructions", "type: 'choice',\n            instructions", 'jev-score-wire'),
    ('jev-score-extra-index', JEV, 'Object.keys(probsIn).some((k) => !indices.includes(k))', 'false', 'jev-score-closed-levels.*extra'),
    ('jev-score-missing-index', JEV, 'const p = probsIn[indices[i]]', 'const p = probsIn[indices[i]] ?? 0', 'jev-score-closed-levels.*missing'),
    ('jev-score-out-of-range-index', JEV, 'Object.keys(probsIn).some((k) => !indices.includes(k))', 'false', 'jev-score-closed-levels.*negative index'),
    ('jev-score-mass', JEV, 'Math.abs(sum - 1) > JEV_MASS_TOLERANCE', 'false', 'jev-score-closed-levels.*missing mass'),
    ('jev-score-probability-bounds', JEV, 'p < 0 || p > 1', 'false', 'jev-score-closed-levels.*negative probability'),
    ('jev-score-mean-crosscheck', JEV, 'Math.abs(a.score - expected) > 0.01 * (labels.length - 1) + 1e-9', 'false', 'jev-score-mean-crosscheck'),
    ('jev-score-level-cap', JEV, 'field.levels.length < 2 || field.levels.length > MAX_SCORE_LEVELS', 'false', 'jev-score-wire.*refuses'),
    ('jev-noul-wire', JEV, "type: 'noul',\n            instructions", "type: 'choice',\n            instructions", 'jev-noul-calibrated.*native noul'),
    ('jev-noul-calibrated', JEV, 'calibrated: true,', "calibrated: typeof a.confidence === 'number',", 'jev-noul-calibrated.*native noul'),
    ('jev-noul-bounds', JEV, 'a.noul < 0 ||\n          a.noul > 1', 'false', 'jev-noul-calibrated.*invalid noul'),
    ('jev-supported-types', JEV, 'onExplicitAnthropicTier() ? JEV_DECISION_TYPES : JEV_LOCKED_TYPES', 'onExplicitAnthropicTier() ? JEV_LOCKED_TYPES : JEV_LOCKED_TYPES', 'jev-supported-types'),
    ('jev-supported-types-same-resolver', ADAPTER, 'const { transport, wired } = selectDecideTransport()', "const transport = 'jev'; const wired = true", 'jev-supported-types'),
    ('jev-set-supported-types-resolver', ADAPTER, 'get: () => selectSetTransport().supportedTypes', "get: () => ['choice', 'score', 'noul']", 'jev mixed-set wire and support'),
    ('jev-supported-types-future-tier', JEV, 'onExplicitAnthropicTier() ? JEV_DECISION_TYPES : JEV_LOCKED_TYPES', 'JEV_DECISION_TYPES', 'jev-supported-types.*future tier'),
    ('jev-score-always-calibrated', JEV, "calibrated: typeof (a as JevAnswer).confidence === 'number'", "calibrated: score || typeof (a as JevAnswer).confidence === 'number'", 'jev-score-wire.*confidence claim'),
    ('jev-score-range-removed', JEV, '          a.score < 0 ||\n          a.score > labels.length - 1 ||\n', '', 'jev-score-mean-crosscheck.*top-level overshoot'),
    ('jev-score-boundary-epsilon', JEV, ' + 1e-9', '', 'jev-score-mean-crosscheck.*inclusive tolerance boundary'),
    ('jev-single-support-backstop', ADAPTER, "!supportedTypes().includes(spec.type ?? 'choice')", 'false', 'jev-supported-types.*future tier'),
    ('jev-set-support-backstop', ADAPTER, "!supportedTypes.includes(spec.type ?? 'choice')", 'false', 'jev-supported-types.*future tier'),
    ('review-noul-complement', JEV, 'false: 1 - a.noul', 'false: a.noul', 'jev-noul-calibrated.*native noul'),
    ('review-score-answer-type', JEV, "score && (!isRecord(a) || a.type !== 'score')", 'false', 'jev-score-mean-crosscheck.*different question type'),
    ('review-noul-answer-type', JEV, "          a.type !== 'noul' ||\n", '', 'jev-noul-calibrated.*choice-shaped answer'),
    ('review-set-lock-false', ADAPTER, "const transport = decideTransportFor(resolveClientForRole('decide'))\n    const locked = transport !== 'logprob' && activeInferenceTier() === 'verda'", "const transport = decideTransportFor(resolveClientForRole('decide'))\n    const locked = false", 'jev mixed-set wire and support'),
    ('layer2-fake-score', FAKE, "type: 'score',\n          score:", "type: 'choice',\n          score:", 'S4 streams and persists'),
    ('layer2-fake-noul', FAKE, "{ type: 'noul', noul: 0.9 }", "{ type: 'choice', noul: 0.9 }", 'S4 streams and persists'),
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
    questions_start = source.index('    const questionFor =')
    questions_end = source.index('    // O4', questions_start)
    questions = source[questions_start:questions_end]
    # Review variant: move ONLY questions, leaving variables.fields below the lock.
    cases.append(('review-questions-before-lock', JEV, source,
                  source[:lock_start] + questions + source[lock_start:questions_start]
                  + source[questions_end:], 'jev-tier-lock score/noul'))
    for name, path, old, new, test in cases:
        if len(sys.argv) > 1 and name not in sys.argv[1:]:
            continue
        original = path.read_text()
        if original.count(old) != 1:
            raise RuntimeError(f'{name}: expected exactly one mutation anchor')
        try:
            path.write_text(original.replace(old, new, 1))
            layer2 = path == FAKE
            command = (['pnpm', 'test:e2e', 'e2e/scenarios/11-typed-decision.e2e.ts', '-t', test]
                       if layer2 else ['pnpm', 'exec', 'vitest', 'run', '--config',
                                       'scripts/vitest-decision-calibration.config.ts', PIN, '-t', test])
            env = {**os.environ, 'BAML_LOG': 'warn', 'E2E_LIVE': '0'}
            if not layer2:
                env['TEST_DATABASE_URL'] = 'postgresql://x:x@127.0.0.1:59999/x'
            elif ':59132/' not in env.get('TEST_DATABASE_URL', ''):
                raise RuntimeError('Layer-2 mutations need the owned Postgres on 59132')
            result = subprocess.run(command, capture_output=True, text=True, env=env)
            output = result.stdout + result.stderr
            if result.returncode == 0 or 'AssertionError' not in output:
                print(output)
                raise RuntimeError(f'{name}: no assertion RED')
            print(f'{name}: RED, restored', flush=True)
        finally:
            path.write_text(original)
