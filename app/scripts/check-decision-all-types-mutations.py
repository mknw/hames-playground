#!/usr/bin/env python3
"""S2 pins. Run from app/. Require assertion/compiler failures and restore each source."""
from pathlib import Path
import subprocess

CORE = Path('../packages/harness-patterns/patterns/typedDecision.server.ts')
TYPES = Path('../packages/harness-patterns/types.ts')
ADAPTER = Path('../packages/harness-baml/baml-adapters.server.ts')
JEV = Path('../packages/harness-baml/jev-decide.server.ts')
INDEX = Path('../packages/harness-patterns/index.ts')
CASES = [
    ('R1', CORE, 'supportedTypes: src.supportedTypes,', "supportedTypes: joint ? (['choice', 'score', 'noul'] as const) : src.supportedTypes,", 'never sent a score or noul'),
    ('R2', CORE, 'supportedTypes: src.supportedTypes,', "supportedTypes: call.decideAll ? src.supportedTypes : (['choice', 'score', 'noul'] as const),", 'never sent a score or noul'),
    ('R14', CORE, "error: `Decision '${key}' could not be scored: ${errorFrom(e, call.state).error.error}`,", "error: `Decision '${key}' could not be scored: ${e instanceof Error ? e.message : String(e)}`,", 'a scorer-level throw that echoes state'),
    ('F4-root-export', INDEX, '  MixedDecisionSet,\n', '', 'decision-all-types.test.ts', 1, 'type'),
    ('decide-fields-mixed', CORE, '  return out\n}\n\n/**\n * Decide several', "  for (const k of keys) out[k].event.type = set.fields[keys[0]].type\n  return out\n}\n\n/**\n * Decide several", 'decide-fields-mixed'),
    ('decision-joint-product', CORE, 'n * categoricalOptions(spec).length', "n * ('labels' in spec ? spec.labels.length : 1)", 'decision-joint-product'),
    ('typed-decision-construction', CORE, "!(decideFn.supportedTypes ?? ['choice']).includes(spec.type ?? 'choice')", 'false', 'refuses unsupported'),
    ('unsupported-type-fails-closed-evaluate', CORE, 'supportedTypes: call.decide.supportedTypes,', "supportedTypes: ['choice', 'score', 'noul'],", 'refuses score/noul before calling'),
    ('unsupported-type-decideAll', CORE, 'supportedTypes: src.supportedTypes,', 'supportedTypes: call.decide.supportedTypes,', 'uses decideAll support independently'),
    ('unsupported-type-joint-choice', CORE, "!(call.decide.supportedTypes ?? ['choice']).includes('choice')", 'false', 'requires choice support'),
    ('fallback-noul-boolean', CORE, "typeof fallback !== 'boolean'", 'false', 'decision-fallback-validation'),
    ('fallback-level-membership', CORE, 'categoricalOptions(spec)?.some((l) => l.id === fallback) === false', 'false', 'decision-fallback-validation'),
    ('state-sentinel', CORE, '    event,\n    ...(llmCall', '    event: { ...event, state: call.state },\n    ...(llmCall', 'decision-state-sentinel mixed'),
    ('set-adapter-refusal', ADAPTER, "if (spec.type !== undefined && spec.type !== 'choice') {", 'if (false) {', 'S2 unsupported-type set adapter backstop', 2),
    ('jev-set-refusal', JEV, "if (field.type !== undefined && field.type !== 'choice') {", 'if (false) {', 'S2 unsupported-type set adapter backstop'),
    ('mixed-field-inference', CORE, 'Promise<{ [K in keyof F]: DecisionFor<F[K]> }>', 'Promise<{ [K in keyof F]: AnyDecision }>', 'decision-all-types.test.ts', 1, 'type'),
    ('legacy-choice-generics', CORE, 'export function evaluateDecision<L extends string>', 'export function evaluateDecision<L extends never>', 'decision-all-types.test.ts', 1, 'type'),
]

for case in CASES:
    name, path, old, new, pin = case[:5]
    occurrence = case[5] if len(case) > 5 else 1
    source = path.read_text()
    parts = source.split(old)
    if len(parts) <= occurrence:
        raise RuntimeError(f'{name}: mutation anchor missing')
    try:
        path.write_text(old.join(parts[:occurrence]) + new + old.join(parts[occurrence:]))
        if len(case) > 6 and case[6] == 'type':
            command = ['pnpm', 'typecheck']
        elif path in [ADAPTER, JEV]:
            command = ['pnpm', 'exec', 'vitest', 'run', '--config', 'scripts/vitest-decision-calibration.config.ts', 'src/__tests__/lib/harness-patterns/decide-adapter.test.ts', '-t', pin]
        else:
            command = ['pnpm', 'exec', 'vitest', 'run', '--config', '../packages/harness-patterns/vitest.config.ts', '--root', '../packages/harness-patterns', '__tests__/decision-all-types.test.ts', '-t', pin]
        result = subprocess.run(command, capture_output=True, text=True)
        output = result.stdout + result.stderr
        red = result.returncode != 0 and (pin in output if command == ['pnpm', 'typecheck'] else 'AssertionError' in output)
        if not red:
            print(output)
            raise RuntimeError(f'{name}: intended pin did not turn RED')
        print(f'{name}: RED, restored', flush=True)
    finally:
        path.write_text(source)
