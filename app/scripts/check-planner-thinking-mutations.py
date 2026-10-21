#!/usr/bin/env python3
"""#625 S3 fix-round mutations (author, Codex and Opus), synthetic endpoints only.

Run from app/: CI=1 python3 scripts/check-planner-thinking-mutations.py [names...]
Each bounded subprocess must fail tests, not merely fail to start or time out.
Source and regenerated client bytes are restored in finally blocks. Logs/results
are written outside the checkout to a fresh temporary directory printed below.
The old missing-trace rejection mutation follows the corrected warning policy;
the old adapter-only tier check follows its replacement at the shared seam.
Opus M1 was removed under the reviewer's explicit no-notice option.
"""
from pathlib import Path
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
ENV = {**os.environ, 'CI': '1', 'TEST_DATABASE_URL': 'postgresql://x:x@127.0.0.1:59999/x', 'BAML_LOG': 'off',
       'LARGE_LLM_BASE_URL': 'http://127.0.0.1:59998/v1',
       'LARGE_LLM_API_KEY': 'mutation-synthetic-key'}
ADAPTER = 'packages/harness-baml/baml-adapters.server.ts'
CLIENTS = 'packages/harness-baml/clients.server.ts'
PLANNER = 'packages/harness-patterns/patterns/planner.server.ts'
SETTINGS = 'app/src/lib/settings.ts'
SELF_DEPLOYED = 'packages/harness-baml/baml_src/self-deployed-client.baml'
CONFIG = 'app/src/lib/inference/config.server.ts'
RENDER = 'src/__tests__/lib/harness-baml/planner-thinking-render.test.ts'
WIRE = 'src/__tests__/lib/harness-baml/planner-thinking.test.ts'
MUTATIONS = []


def add(name, file, old, new, test=WIRE, generate=False, count=1):
    MUTATIONS.append((name, file, old, new, test, generate, count))


# Author's 25 mutations, including the separately reported cap-hit trigger.
add('A01-thinking-flag', SELF_DEPLOYED, 'enable_thinking true', 'enable_thinking false', RENDER, True)
add('A02-sampling', SELF_DEPLOYED, 'temperature 1.0', 'temperature 0.2', RENDER, True)
add('A03-endpoint', SELF_DEPLOYED, 'client<llm> SelfDeployedQwenThink {\n  provider openai-generic\n  options {\n    base_url env.LARGE_LLM_BASE_URL', 'client<llm> SelfDeployedQwenThink {\n  provider openai-generic\n  options {\n    base_url "https://example.invalid/other/v1"', RENDER, True)
add('A04-cache-metadata', SELF_DEPLOYED, 'client<llm> SelfDeployedQwenThink {\n  provider openai-generic\n  options {', 'client<llm> SelfDeployedQwenThink {\n  provider openai-generic\n  options {\n    allowed_role_metadata ["cache_control"]', RENDER, True)
add('A05-prompt-drift', 'packages/harness-baml/baml_src/planner.baml', '{{ PlannerBody(user_message, intent, tools, context, false) }}', 'DRIFT {{ PlannerBody(user_message, intent, tools, context, false) }}', RENDER, True)
add('A06-timeout', SELF_DEPLOYED, '// Provisional: 4096 / 26 tok/s = 158s, with ~22s prefill/queue allowance.\n      request_timeout_ms 180000', '// Provisional: 4096 / 26 tok/s = 158s, with ~22s prefill/queue allowance.\n      request_timeout_ms 120000', RENDER, True)
add('A07-cap-mirror', SETTINGS, '  SelfDeployedQwenThink: 4_096,', '  SelfDeployedQwenThink: 8_192,', 'src/__tests__/lib/client-output-caps.test.ts')
add('A08-selected-leaf', ADAPTER, "if (!THINKING_CLIENTS.has(selected?.clientName ?? '')) {", 'if (false) {', 'src/__tests__/lib/harness-patterns/baml-adapters.test.ts')
add('A09-full-trace', ADAPTER, "reasoning: trace.kind === 'trace' ? trace.text : ''", "reasoning: ''")
add('A10-parser-policy', ADAPTER, 'if (split?.closed) {', 'if (false) {')
add('A11-last-delimiter', 'packages/harness-baml/thinking-trace.ts', 'raw.lastIndexOf(THINK_CLOSE)', 'raw.indexOf(THINK_CLOSE)')
add('A12-retry-thinking-again', ADAPTER, 'const retryClient = SELF_DEPLOYED_CLIENT_BY_ROLE.planner', "const retryClient = 'SelfDeployedQwenThink'")
add('A13-warning-type', PLANNER, "            'warning',", "            'error',")
add('A14-private-accounting', CLIENTS, '  ...THINKING_CLIENTS,', '', 'src/__tests__/lib/metrics/usage-recorder.test.ts')
add('A15-default-cap', PLANNER, 'DEFAULT_MAX_REASONING_CHARS = 2000', 'DEFAULT_MAX_REASONING_CHARS = 5000')
add('A16-reasoning-slice', PLANNER, 'raw.reasoning.slice(0, maxReasoningChars)', 'raw.reasoning')
add('A17-full-event-trace', PLANNER, 'plan: recordedPlan,', 'plan,')
add('A18-missing-trace-warning', ADAPTER, "if (trace.kind !== 'trace') warning = 'no thinking trace'", '// missing trace silently accepted')
add('A19-fake-inventory', 'app/e2e/lib/baml-functions.ts', "  ['PlannerThinking', 'You are a strategic planner for a tool-using agent.'],", '', RENDER)
add('A20-classifier', 'app/e2e/lib/baml-functions.ts', "schema.includes('reasoning: string')", "schema.includes('never-present-discriminator')", 'classifier')
add('A21-private-tier', CLIENTS, "(!THINKING_ROLES.has(role) || activeInferenceTier() !== 'self_deployed')", "(!THINKING_ROLES.has(role))")
add('A22-runtime-price', CONFIG, '    ...Object.fromEntries([...THINKING_CLIENTS].map((client) => [client, largeEurPerHour])),', '')
add('A23-warm-clock', 'app/src/lib/metrics/usage-recorder.server.ts', " || THINKING_CLIENTS.has(sample.clientName ?? '')", '', 'src/__tests__/lib/metrics/usage-recorder.test.ts')
add('A24-switched-function', CLIENTS, "planner: ['Planner', 'PlannerThinking']", "planner: ['Planner']", 'src/__tests__/lib/harness-patterns/clients-self-deployed.test.ts')
add('A25-cap-hit-trigger', ADAPTER, '(noAnswer || (e instanceof BamlValidationError && collectorHitOutputCap(collector)))', 'noAnswer')
# Codex's two extra cap mutations, plus discriminators for both numbered findings.
add('C-cap-plan-slice', PLANNER, 'raw.plan.slice(0, maxPlanChars)', 'raw.plan', 'src/__tests__/lib/harness-patterns/patterns/planner.test.ts')
add('C-cap-zero', PLANNER, 'DEFAULT_MAX_REASONING_CHARS = 2000', 'DEFAULT_MAX_REASONING_CHARS = 0')
add('C1-transport', ADAPTER, 'if (transport(selected?.httpRequest) !== transport(retryRequest)) {', 'if (false) {')
add('C1-credentials', ADAPTER, 'headers: Object.entries(request.headers)', 'headers: Object.entries({})')
add('C1-model', ADAPTER, 'model: (request.body.json() as { model?: string }).model,', '')
add('C2-terminal-trace', ADAPTER, "if (trace?.kind === 'trace') error.llmCall.parsedOutput = { reasoning: trace.text }", '// discard diagnostic trace')
# Opus's five red mutations and the two formerly surviving live clauses.
add('O-context-window', SETTINGS, '  SelfDeployedQwenThink: 131_072,', '  RemovedThink: 131_072,', RENDER)
add('O-time-rate', SETTINGS, '  SelfDeployedQwenThink: DEFAULT_LARGE_LLM_EUR_PER_HOUR,', '  RemovedThink: DEFAULT_LARGE_LLM_EUR_PER_HOUR,', RENDER)
add('O-reused-collector', ADAPTER, "const retryCollector = new Collector('Planner')", 'const retryCollector = collector')
add('O-undefined-attempt', ADAPTER, 'onRetry?.(failedCall)', 'onRetry?.(undefined)')
add('O-truncated-flag', PLANNER, '...(reasoningTruncated ? { reasoningTruncated: true } : {}),', '')
add('O-M4-original-selected-leaf', ADAPTER, "if (THINKING_CLIENTS.has(selectedCall()?.clientName ?? '')) {", 'if (false) {')
add('O-M9-override-bag', ADAPTER, 'const retryOpts = { ...override, collector: retryCollector, client: retryClient }', 'const retryOpts = { collector: retryCollector, client: retryClient }')
add('O-no-answer-message', ADAPTER, "throw new Error('PlannerThinking returned no answer')", "throw new Error('different no-answer message')")
# New pins for Opus 1, 3, 4 and 5 (both override branches + pure resolver).
add('O1-role-guard', CLIENTS, "(!THINKING_ROLES.has(role) || activeInferenceTier() !== 'self_deployed')", "(activeInferenceTier() !== 'self_deployed')")
add('O1-seam-guard', CLIENTS, '    assertThinkingOverride(role,', '    // assertThinkingOverride(role,', count=3)
add('O1-per-run', CLIENTS, '    assertThinkingOverride(role, perRun)', '    // assertThinkingOverride(role, perRun)')
add('O1-consumer', CLIENTS, '    assertThinkingOverride(role, consumerBag)', '    // assertThinkingOverride(role, consumerBag)')
add('O1-resolver', CLIENTS, '    assertThinkingOverride(role, bag)', '    // assertThinkingOverride(role, bag)')
add('O3-role-map', ADAPTER, 'const retryClient = SELF_DEPLOYED_CLIENT_BY_ROLE.planner', "const retryClient = 'SelfDeployedQwen'")
add('O3-retry-selected-leaf', ADAPTER, 'if (selectedCall(retryCollector)?.clientName !== retryClient) {', 'if (false) {')
add('O4-missing-trace-reject', ADAPTER, "if (trace.kind !== 'trace') warning = 'no thinking trace'", "if (trace.kind !== 'trace') throw new Error('no thinking trace')")
add('O4-pattern-warning', PLANNER, '      if (warning) {', '      if (false) {')
add('O5-event-serialization', 'packages/harness-patterns/patterns/event-view.server.ts', "    case 'plan_created': {", "    case 'unused_plan_event': {")

add('O5-event-steps', 'packages/harness-patterns/patterns/event-view.server.ts', '        n_steps: data.plan?.n_steps,', '')
add('O5-event-skipped', 'packages/harness-patterns/patterns/event-view.server.ts', '        skipped: data.skipped,', '')
add('O5-event-plan', 'packages/harness-patterns/patterns/event-view.server.ts', '        plan: data.plan?.plan,', '')

def command(args, cwd, timeout=90):
    return subprocess.run(args, cwd=cwd, env=ENV, text=True, capture_output=True, timeout=timeout)


def generate():
    result = command(['corepack', 'pnpm', 'baml-generate'], ROOT / 'packages/harness-baml')
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)


def classifier_script():
    # Standalone smoke: never import the app-path suite into layer 1.
    return f"""import assert from 'node:assert/strict'
import fs from 'node:fs'
import {{ classifyPrompt, promptText }} from '{ROOT}/app/e2e/lib/baml-functions.ts'
const bodies = JSON.parse(fs.readFileSync('{ROOT}/app/src/__tests__/lib/harness-patterns/fixtures/controller-prompts-625-s2.json', 'utf8'))
for (const scenario of ['first', 'context']) {{
  const original = bodies[`Planner/${{scenario}}/SelfDeployedQwen`]
  const twin = original.replace(', and never more than a short paragraph of reasoning', '').replace('  // Why this approach was chosen\\\\n  reasoning: string,\\\\n', '')
  assert.equal(classifyPrompt(promptText(JSON.parse(original).messages)), 'Planner')
  assert.equal(classifyPrompt('CONTEXT reasoning: string\\n' + promptText(JSON.parse(twin).messages)), 'PlannerThinking')
}}
console.log('Classifier smoke: 4 assertions passed.')
"""


def main():
    wanted = set(sys.argv[1:])
    assert wanted <= {m[0] for m in MUTATIONS}, 'Unknown mutation name'
    logdir = Path(tempfile.mkdtemp(prefix='planner-thinking-mutations-'))
    print(logdir, flush=True)
    smoke = logdir / 'classifier.mjs'
    smoke.write_text(classifier_script())
    initial = command(['node', '--experimental-strip-types', str(smoke)], ROOT / 'app')
    (logdir / 'classifier-green.log').write_text(initial.stdout + initial.stderr)
    assert initial.returncode == 0, initial.stdout + initial.stderr
    generated = {p: p.read_bytes() for p in (ROOT / 'packages/harness-baml/baml_client').iterdir() if p.is_file()}
    results = []
    for name, file, old, new, test, regen, count in MUTATIONS:
        if wanted and name not in wanted:
            continue
        path = ROOT / file
        saved = path.read_bytes()
        source = saved.decode()
        assert source.count(old) >= count, (name, 'source not found', old)
        try:
            path.write_text(source.replace(old, new, count))
            if regen:
                generate()
            args = ['node', '--experimental-strip-types', str(smoke)] if test == 'classifier' else ['corepack', 'pnpm', 'test:run', test]
            run = command(args, ROOT / 'app')
            output = run.stdout + run.stderr
            (logdir / (name + '.log')).write_text(output)
            red = run.returncode == 1 and (('AssertionError' in output) if test == 'classifier' else bool(re.search(r'Tests\s+\d+ failed', output)))
            results.append({'mutation': name, 'red': red, 'exit': run.returncode, 'tests': [line.strip() for line in output.splitlines() if 'Tests ' in line or ' FAIL ' in line]})
            print(json.dumps(results[-1]), flush=True)
        finally:
            path.write_bytes(saved)
            if regen:
                generate()
                assert all(p.read_bytes() == data for p, data in generated.items()), 'Generated bytes were not restored'
    (logdir / 'results.json').write_text(json.dumps(results, indent=2))
    assert all(row['red'] for row in results), 'A mutation survived or failed for an invalid reason'
    print(f'{len(results)}/{len(results)} mutations RED and restored', flush=True)


if __name__ == '__main__':
    main()
