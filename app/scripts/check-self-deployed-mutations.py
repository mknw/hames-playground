#!/usr/bin/env python3
"""#722 discriminating pins. Run from app/: CI=1 python3 scripts/check-self-deployed-mutations.py.

No provider or daemon is contacted. Every mutation must fail assertions (not just
fail to import), and source bytes are restored in finally. Add --database only
with an explicitly supplied throwaway TEST_DATABASE_URL; its schema is isolated.
"""
from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / 'app'
LOGS = Path(tempfile.mkdtemp(prefix='self-deployed-mutations-'))
ENV = {**os.environ, 'CI': '1', 'BAML_LOG': 'off',
       'TEST_DATABASE_URL': 'postgresql://x:x@127.0.0.1:59999/x'}
COMPAT = 'src/__tests__/lib/inference/self-deployed-compat.test.ts'
VALUE = 'src/__tests__/lib/inference/tier-value.test.ts'
SQL = 'src/__tests__/lib/db/memories-sql.test.ts'
POLICY = 'src/__tests__/lib/memory/config.test.ts'
BOOTSTRAP = 'src/__tests__/deploy/private-tier-bootstrap.test.ts'
ALIASES = 'packages/harness-baml/inference-env.server.ts'
TIER_CONFIG = 'app/src/lib/inference/tier-config.server.ts'
MEMORIES = 'app/src/lib/db/memories.server.ts'
CASES = []


def add(name, file, old, new, tests, pattern=None):
    CASES.append((name, file, old, new, tests, pattern))


add('alias-fallback', ALIASES,
    'return process.env[name] ?? (oldName ? process.env[oldName] : undefined)',
    'return process.env[name]', [COMPAT])
add('canonical-precedence', ALIASES,
    'return process.env[name] ?? (oldName ? process.env[oldName] : undefined)',
    'return (oldName ? process.env[oldName] : undefined) ?? process.env[name]', [COMPAT])
add('boot-warning', ALIASES, 'console.warn(', 'String(', [COMPAT])
add('baml-env-propagation', ALIASES,
    'if (process.env[name] === undefined && value !== undefined) process.env[name] = value',
    'void value', [COMPAT])
add('tier-refusal', TIER_CONFIG, '  assertLargeModelConfigured()\n', '', [COMPAT])
add('boot-refusal', TIER_CONFIG,
    'if (privateInferenceOnly()) assertPrivateTierConfigured()', '', [COMPAT])
add('legacy-restriction', TIER_CONFIG,
    "return setting === 'self_deployed' || setting === 'private'",
    "return setting === 'self_deployed'", [COMPAT])
add('legacy-frame', 'packages/harness-baml/clients.server.ts',
    "tier === 'verda'", "tier === 'removed-legacy-tier'", [COMPAT])
add('legacy-row-normalization', 'app/src/lib/inference/tier-value.ts',
    "value === 'verda' || value === 'self_deployed'", "value === 'self_deployed'",
    [VALUE, SQL, 'src/__tests__/lib/inference/tier.test.ts',
     'src/__tests__/lib/db/user-prefs.test.ts', 'src/__tests__/lib/memory/proposals.test.ts',
     'src/__tests__/lib/metrics/preview-counters.test.ts'])
add('unknown-tier-refusal', 'app/src/lib/inference/tier-value.ts',
    "return value === 'anthropic' ? 'anthropic' : null",
    "return value === 'anthropic' ? 'anthropic' : 'self_deployed'", [VALUE, POLICY])
add('turn-metadata', 'app/src/lib/inference/tier-value.ts',
    "record.tier = 'self_deployed'", "record.tier = 'anthropic'", [VALUE, 'src/__tests__/lib/db/stored-tier-context.test.ts'])
add('memory-positive-direction', MEMORIES,
    "? ['self_deployed', 'verda']", "? ['self_deployed']", [SQL])
add('memory-negative-direction', MEMORIES,
    "? ['anthropic']", "? ['anthropic', 'verda']", [SQL])
add('public-memory-policy', 'app/src/lib/memory/config.server.ts',
    "? ['anthropic']", "? ['anthropic', 'self_deployed']", [POLICY])
add('proposal-translation', 'app/src/lib/memory/proposals.server.ts',
    'return payload && tier ? { ...payload, tier } : null',
    'return payload && tier ? payload : null', ['src/__tests__/lib/memory/proposals.test.ts'])
add('live-preflight-alias', 'app/src/lib/eval-support/live-preconditions.ts',
    'env.LARGE_LLM_BASE_URL ?? env.VERDA_INFERENCE_ENDPOINT', 'env.LARGE_LLM_BASE_URL',
    ['src/__tests__/lib/eval-support/live-preconditions.test.ts'])
# Leave the old CHECK in place. The same mutation turns the isolated Postgres
# write red when --database is explicitly authorized; locally the SQL pin is red.
s = (ROOT / MEMORIES).read_text()
a = s.index('  -- Widen the old check under the schema transaction;')
b = s.index('  CREATE INDEX IF NOT EXISTS memories_user_idx', a)
add('old-check-retained', MEMORIES, s[a:b], '', [SQL])
add('bootstrap-alias', 'scripts/bootstrap-vps.sh',
    'LARGE_LLM_BASE_URL) legacy=VERDA_INFERENCE_ENDPOINT',
    'LARGE_LLM_BASE_URL) legacy=REMOVED_LEGACY_ENDPOINT', [BOOTSTRAP], 'one-release bootstrap')

add('legacy-frame-widened', 'packages/harness-baml/clients.server.ts',
    "tier === 'verda'", "(tier === 'verda' || tier === 'private' || tier === 'Verda')", [COMPAT])
add('private-restriction-warning', ALIASES,
    "    warn('INFERENCE_TIERS=private', 'INFERENCE_TIERS=self_deployed')\n", '', [COMPAT])
TIER_SERVER = 'app/src/lib/inference/tier.server.ts'
add('stale-tab-literal-refused', TIER_SERVER,
    'normalizeStoredInferenceTier(requested)',
    "(requested === 'self_deployed' || requested === 'anthropic' ? requested : null)",
    ['src/__tests__/lib/inference/tier.test.ts'])
add('stale-tab-alias-widened', TIER_SERVER,
    'normalizeStoredInferenceTier(requested)',
    "(normalizeStoredInferenceTier(requested) ?? (requested === 'private' ? 'self_deployed' : null))",
    ['src/__tests__/lib/inference/tier.test.ts'])
add('decision-documents-legacy-frame', 'app/src/lib/harness-client/decision-documents.server.ts',
    "inference?.tier !== 'self_deployed')",
    "inference?.tier !== 'self_deployed' && currentRunFrame()?.inference?.tier !== 'verda')",
    ['src/__tests__/lib/harness-client/decision-documents.test.ts'])
add('file-ingest-legacy-frame', 'app/src/lib/app-tools/index.server.ts',
    "currentRunFrame()?.inference?.tier === 'self_deployed' && privateInferenceOnly()",
    "['self_deployed', 'verda'].includes(currentRunFrame()?.inference?.tier ?? '') && privateInferenceOnly()",
    ['src/__tests__/lib/app-tools/stash-bridge.test.ts'])
add('bootstrap-v1-rule', 'scripts/bootstrap-vps.sh',
    '    [[ -z $v || $v == */v1 ]] || printf', '    printf', [BOOTSTRAP])
add('bootstrap-test-names-a-missing-key', 'scripts/bootstrap-vps.test.sh',
    "\\nLARGE_LLM_API_KEY='k'\\n\\\" >>'$good'\"",
    "\\nSELF_DEPLOYED_INFERENCE_API_KEY='k'\\n\\\" >>'$good'\"", [BOOTSTRAP], 'shell suite')

PRICING = 'src/__tests__/lib/pricing-eur.test.ts'
add('legacy-client-alias', 'app/src/lib/settings.ts',
    'const clientName = canonicalClientName(storedClientName)',
    'const clientName = storedClientName', [PRICING])
add('legacy-client-alias-table', 'app/src/lib/settings.ts',
    "  VerdaQwenThink: 'LargeQwenThink',\n", '', [PRICING])
add('legacy-client-display', 'app/src/components/ark-ui/observability/LLMCallTabs.tsx',
    '{canonicalClientName(props.llmCall.clientName)}', '{props.llmCall.clientName}', [PRICING])

add('probe-never-reads-inference-endpoint', 'app/src/lib/inference/verda-control-plane.server.ts',
    "process.env.VERDA_CONTROL_PLANE_BASE ?? 'https://api.verda.com'",
    "(void process.env.LARGE_LLM_BASE_URL, void process.env.LARGE_LLM_API_KEY, process.env.VERDA_CONTROL_PLANE_BASE ?? 'https://api.verda.com')",
    ['src/__tests__/lib/inference/verda-control-plane.test.ts'])

if '--database' in sys.argv:
    database = os.environ.get('TEST_DATABASE_URL')
    if not database or database == ENV['TEST_DATABASE_URL']:
        raise SystemExit('--database needs an explicitly supplied throwaway TEST_DATABASE_URL')
    ENV['TEST_DATABASE_URL'] = database
    ENV['TEST_DATABASE_REQUIRED'] = '1'
    add('old-check-postgres-write', MEMORIES, s[a:b], '',
        ['src/__tests__/lib/db/memories.test.ts'], 'widens an old CHECK')
    add('memory-write-canonical', MEMORIES, 'memoryTier(input.tier),', 'input.tier,',
        ['src/__tests__/lib/db/memories.test.ts'], 'legacy tier value')
    add('backfill-legacy-preference', 'app/src/lib/db/conversations.server.ts',
        "IN ('verda', 'self_deployed', 'anthropic')", "IN ('self_deployed', 'anthropic')",
        ['src/__tests__/lib/db/conversations.test.ts'], 'pre-rename spelling')

requested = set(sys.argv[1:]) - {'--database'}
selected = [case for case in CASES if not requested or case[0] in requested]
if requested - {case[0] for case in CASES}:
    raise SystemExit('Unknown mutation name')
print(f'Logs: {LOGS}', flush=True)
# Prove the selected pins are green before manufacturing any red result.
regular = sorted({test for case in selected if not case[5] for test in case[4]})
baselines = [(regular, None)] if regular else []
baselines += [(case[4], case[5]) for case in selected if case[5]]
for n, (tests, pattern) in enumerate(baselines):
    command = ['corepack', 'pnpm', 'test:run', *tests]
    if pattern:
        command += ['-t', pattern]
    with (LOGS / f'baseline-{n}.log').open('w') as log:
        run = subprocess.run(command, cwd=APP, env=ENV, stdout=log,
                             stderr=subprocess.STDOUT, timeout=120)
    if run.returncode:
        raise SystemExit(f'Baseline is not green; inspect {LOGS}')
print('Baseline pins GREEN.', flush=True)
for name, file, old, new, tests, pattern in selected:
    path = ROOT / file
    original = path.read_bytes()
    text = original.decode()
    if text.count(old) != 1:
        raise SystemExit(f'{name}: expected one source match, got {text.count(old)}')
    result_file = LOGS / f'{name}.json'
    command = ['corepack', 'pnpm', 'test:run', *tests, '--reporter=json', f'--outputFile={result_file}']
    if pattern:
        command += ['-t', pattern]
    try:
        path.write_text(text.replace(old, new, 1))
        with (LOGS / f'{name}.log').open('w') as log:
            run = subprocess.run(command, cwd=APP, env=ENV, stdout=log,
                                 stderr=subprocess.STDOUT, timeout=120)
        report = json.loads(result_file.read_text())
        if run.returncode == 0 or report.get('numFailedTests', 0) < 1:
            raise SystemExit(f'{name}: mutation survived or failed without assertions; inspect logs')
        print(f'{name}: RED ({report["numFailedTests"]} failed tests)', flush=True)
    finally:
        path.write_bytes(original)
print(f'{len(selected)} mutations verified; sources restored.', flush=True)
if '--database' not in sys.argv:
    print('Postgres mutation BLOCKED locally: no authorized throwaway daemon.', flush=True)
