#!/usr/bin/env python3
"""M5c negative controls. Run from app/; restores each source even on failure.

Default uses the dispatch's dead TEST_DATABASE_URL. --postgres additionally
runs the lifted-origin SQL control against TEST_DATABASE_URL on port 59133.
No provider calls, Docker commands, or persistent test data are created here.
"""
import argparse
import os
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--postgres', action='store_true')
parser.add_argument('--only', help='Comma-separated control names')
args = parser.parse_args()
if not Path('src/lib/memory/config.server.ts').exists():
    sys.exit('Run from app/')
env = dict(os.environ, BAML_LOG='off')
if args.postgres:
    if ':59133/' not in env.get('TEST_DATABASE_URL', ''):
        sys.exit('--postgres requires the disposable Postgres on port 59133')
    env['TEST_DATABASE_REQUIRED'] = '1'
else:
    env['TEST_DATABASE_URL'] = 'postgresql://x:x@127.0.0.1:59999/x'
    env.pop('TEST_DATABASE_REQUIRED', None)
C = 'src/lib/memory/config.server.ts'
T = 'src/lib/harness-client/turn.server.ts'
R = 'src/lib/memory/reconcile.server.ts'
S = 'src/lib/harness-client/session.server.ts'
B = 'src/lib/memory/boot.server.ts'
config = 'src/__tests__/lib/memory/config.test.ts'
turn = 'src/__tests__/lib/harness-client/turn.test.ts'
reconcile = 'src/__tests__/lib/memory/reconcile.test.ts'
boot = 'src/__tests__/lib/memory/boot.test.ts'
# Each tuple is an exact source mutation and the pin that must reject it.
cases = [
    ('root-config', S, 'memory: createHostMemoryConfig(),', 'memory: undefined,', config, None),
    ('owner-switch', C, 'const owner = getRequestUserId', "const owner = () => 'wrong-owner'", config, None),
    ('memory-enabled', C, 'return id ? getMemoryEnabled(id) : false', 'return true', config, None),
    ('private-visibility', C, "['anthropic', 'verda']", "['anthropic']", config, None),
    ('embed-internal', 'src/lib/memory/embedder.server.ts', "provider: 'local'", "provider: 'openrouter'", config, None),
    ('wake-capability', C, 'if (!memory || !harnessUsesMemory(patterns)) return undefined', 'if (!memory) return undefined', config, None),
    ('same-wake', C, 'const wake = getRequestMemoryWake()', 'const wake = awaitMemoryWake(memoryWakeTimeoutMs())', config, None),
    ('wake-budget', C, "timer = setTimeout(() => resolve('skipped'), budgetMs)", "timer = setTimeout(() => resolve('skipped'), 10000)", config, 'waits at most'),
    ('wake-rejection', C, "  } catch {\n    return 'skipped'", "  } catch {\n    return 'awake'", config, None),
    ('interactive-only', T, "req.mode === 'interactive' ||\n    (req.mode === 'resume' && held.loaded?.memoryRunOrigin === 'interactive')", "true", turn, 'memory host'),
    ('resume-origin', T, "held.loaded?.memoryRunOrigin === 'interactive'", "held.loaded?.memoryRunOrigin !== 'interactive'", turn, 'resume preserves'),
    ('origin-new-turn', T, "memoryRunOrigin: req.mode === 'interactive' ? 'interactive' : 'triggered'", "memoryRunOrigin: 'triggered'", turn, 'promoted action'),
    ('claimed-row-id', T, 'conversationId: req.sessionId', 'conversationId: result.context.sessionId', turn, 'starts wake before'),
    ('settle-before-save', T, 'mustPersist ||= result.context.events.length !== before', 'mustPersist ||= false', turn, 'starts wake before'),
    ('next-load', S, 'const repaired = await reconcileMemoryReferences(row.serializedContext, sessionId, userId)', 'const repaired = row.serializedContext', turn, 'reply during settle'),
    ('claimed-load', S, 'row.serializedContext = await reconcileMemoryReferences(row.serializedContext, sessionId, userId)', 'row.serializedContext = row.serializedContext', 'src/__tests__/lib/harness-client/session.test.ts', 'claimSession reconciles'),
    ('source-owner', 'src/lib/db/memories.server.ts', 's.conversation_id = $1 AND s.user_id = $2', 's.conversation_id = $1', 'src/__tests__/lib/db/memories-sql.test.ts', 'reconciliation source'),
    ('memory-owner', 'src/lib/db/memories.server.ts', 'm.id = s.memory_id AND m.user_id = $2', 'm.id = s.memory_id', 'src/__tests__/lib/db/memories-sql.test.ts', 'reconciliation source'),
    ('source-idempotency', R, 'const missing = sources.filter((s) => !recorded.has(JSON.stringify([s.eventId, s.ordinal])))', 'const missing = sources', reconcile, None),
    ('erased-read', R, 'if (!memory) continue', '', reconcile, None),
    ('erased-blob', R, 'const sources = await listMemorySourcesForConversation(conversationId, userId)', "await createMemoryDbStore(userId).transaction(async (tx) => { for (const e of ctx.events) if (e.type === 'memory_written') await tx.insert({} as never) })\n    const sources = await listMemorySourcesForConversation(conversationId, userId)", reconcile, None),
    ('boot-once', B, 'return ((globalThis as BootGlobal)[KEY] ??= probe())', 'return probe()', boot, None),
    ('boot-local-only', B, "if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))", 'if (false)', boot, None),
    ('boot-no-redirect', B, "redirect: 'error'", "redirect: 'follow'", boot, None),
    ('boot-fail-open', B, 'const verdict = !schema', 'const verdict = false', boot, None),
    ('boot-hook', 'src/middleware.ts', 'void probeMemoryAtBoot()', 'void 0', boot, None),
    ('nullable-enum', 'src/lib/db/client.server.ts', 'ADD COLUMN IF NOT EXISTS memory_run_origin TEXT', "ADD COLUMN IF NOT EXISTS memory_run_origin TEXT NOT NULL DEFAULT 'interactive'", 'src/__tests__/lib/db/encryption-coverage.test.ts', None),
    ('optional-deps', '../packages/agents/types.ts', 'memory?: MemoryConfig', 'memory: MemoryConfig', None, None),
]
cases += [
    ('wake-before-pattern', T, 'const memory = startTurnMemory(patterns, agentDeps().memory)', 'const memory = undefined; setTimeout(() => startTurnMemory(patterns, agentDeps().memory), 0)', turn, 'starts wake before'),
    ('settle-after-close', T, 'req.onSettled?.()', 'setTimeout(() => req.onSettled?.(), 0)', turn, 'starts wake before'),
    ('delete-refusal-failed', '../packages/harness-patterns/memory-store.server.ts', 'failed++', 'duplicates++', 'src/__tests__/lib/memory/settle.test.ts', 'delete refusal'),
    ('wake-skips-store', '../packages/harness-patterns/memory-store.server.ts', "if (outcome !== 'awake') return stop('waking')", 'void outcome', 'src/__tests__/lib/memory/settle.test.ts', 'rejected or skipped'),
    ('boot-content-free', B, '// No exception text: drivers can quote data or credentials.', "console.info('secret content')", boot, 'does not fail boot'),
    ('shipped-opt-in', '../packages/agents/agents/search.server.ts', 'import ', "import { withMemory } from '@hames-ai/harness-patterns'\nconst _memoryOptIn = () => withMemory({} as never)\nimport ", config, 'shipped agent'),
]
cases += [
    ('wake-target-tier', 'src/lib/inference/memory-wake.server.ts', "if (activeInferenceTier() === 'verda') targets.push(SUMMARIZER)", 'targets.push(SUMMARIZER)', 'src/__tests__/lib/inference/memory-wake.test.ts', 'requested target set'),
    ('tier-consistency', '../packages/harness-patterns/memory-store.server.ts', 'if (cfg.tier && frameTier !== undefined && tier !== frameTier)', 'if (false)', '../packages/harness-patterns/__tests__/memory-store.test.ts', 'tier override'),
]
cases += [
    ('origin-no-backfill', 'src/lib/db/client.server.ts', "CHECK (memory_run_origin IN ('interactive', 'triggered'));", "CHECK (memory_run_origin IN ('interactive', 'triggered'));\n  UPDATE conversations SET memory_run_origin = 'interactive' WHERE memory_run_origin IS NULL;", 'src/__tests__/lib/db/encryption-coverage.test.ts', 'keeps routing enums'),
    ('origin-plaintext', 'src/lib/db/migrate-encryption.server.ts', "textColumns: ['title']", "textColumns: ['title', 'memory_run_origin']", 'src/__tests__/lib/db/encryption-coverage.test.ts', 'keeps routing enums'),
]
# Independent review #550, F1–F4: the prescribed mutations, one at a time.
cases += [
    ('M1', T, "if (event.type === 'memory_written')", 'if (false)', 'src/__tests__/lib/memory/review-550-merge.test.ts', None),
    ('M2', T, 'fresh.events[at] = event', '', 'src/__tests__/lib/memory/review-550-merge.test.ts', None),
    ('M3', T, "(e.data as MemoryWrittenEventData).eventId === d.eventId &&\n          (e.data as MemoryWrittenEventData).ordinal === d.ordinal", '(e.data as MemoryWrittenEventData).eventId === d.eventId', 'src/__tests__/lib/memory/review-550-merge.test.ts', None),
    ('Z', C, 'visibleTiers: visibleMemoryTiers', "visibleTiers: () => ['anthropic', 'verda']", config, 'composition root wires'),
    ('Z5', C, 'visibleTiers: visibleMemoryTiers', "visibleTiers: (t) => (t ? ['anthropic', 'verda'] : [])", config, 'composition root wires'),
    ('Z4', C, 'settle: { wakeBudgetMs: memoryWakeTimeoutMs() }', 'settle: {}', config, 'composition root wires'),
    ('F3-conjunction', B, '${verdict}', "${schema && embedder === 'answering' ? 'ENABLED' : 'DISABLED'}", boot, None),
    ('F3-off-box-disabled', B, "? 'ENABLED (embedder not probed)'", "? 'DISABLED'", boot, None),
    ('F3-ignore-schema', B, 'const verdict = !schema', 'const verdict = false', boot, None),
    ('E', R, '[d.eventId, d.ordinal]', '[d.eventId, 0]', reconcile, 'keys on'),
    ('E2', R, '[s.eventId, s.ordinal]', '[s.eventId, 0]', reconcile, 'keys on'),
    ('F', R, 'tier: source.tier', "tier: 'verda'", reconcile, 'keys on'),
    ('V', R, 'kind: memory.kind', "kind: 'preference'", reconcile, 'keys on'),
    ('A', T, '!plan.stopOnly ? startTurnMemory(patterns, agentDeps().memory) : undefined', 'startTurnMemory(patterns, agentDeps().memory)', turn, 'stop-only resume of an interactive run'),
    ('Q', B, ' || !result.vectors[0].every(Number.isFinite)', '', boot, 'non-finite vector'),
]
# #553 option 1: reject a supplier/wake bypass and origin broadening.
cases += [
    ('553-enabled', C, '      if (!isRequestMemoryAllowed()) return false', '', config, '#553'),
    ('553-wake', C, '  if (!isRequestMemoryAllowed()) return undefined', '', config, '#553'),
    ('553-triggered', T, "const memoryAllowed =\n    req.mode === 'interactive'", "const memoryAllowed =\n    req.mode !== 'resume'", turn, 'triggered run never wakes'),
    ('553-resume-attended', T, "held.loaded?.memoryRunOrigin === 'interactive'", 'isAttendedRequest()', turn, 'resume preserves'),
    ('553-resume-null', T, "held.loaded?.memoryRunOrigin === 'interactive'", "held.loaded?.memoryRunOrigin !== 'triggered'", turn, 'resume preserves'),
]
if args.postgres:
    cases = [('origin-preserve-and-update', 'src/lib/db/conversations.server.ts', 'COALESCE($9, memory_run_origin)', 'COALESCE(memory_run_origin, $9)', 'src/__tests__/lib/db/conversations.test.ts', 'M5c lifted')]
if args.only:
    selected = set(args.only.split(','))
    cases = [c for c in cases if c[0] in selected]
    if len(cases) != len(selected):
        sys.exit('Unknown or unavailable control')
failed = []
for name, filename, old, new, test, pattern in cases:
    path = Path(filename)
    original = path.read_text()
    if old not in original:
        failed.append(name)
        print(f'{name}: MISSING ANCHOR', flush=True)
        continue
    mutated = original.replace(old, new, 1)
    if name == 'erased-read':
        mutated = mutated.replace('kind: memory.kind', "kind: memory?.kind ?? 'preference'")
    command = ['pnpm', 'test:run', test] if test else ['pnpm', 'typecheck']
    if pattern:
        command += ['-t', pattern]
    try:
        path.write_text(mutated)
        result = subprocess.run(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=50)
        # A broken import or compile error is not behavioral evidence.
        red = result.returncode != 0 and ('Tests ' in result.stdout if test else 'error TS' in result.stdout)
        Path(f'/tmp/m5c-mutation-{name}.log').write_text(result.stdout)
        print(f'{name}: {"RED" if red else "NOT RED"}', flush=True)
        if not red:
            failed.append(name)
    finally:
        path.write_text(original)
if failed:
    sys.exit('Mutation failures: ' + ', '.join(failed))
print(f'{len(cases)} mutations rejected; source restored.', flush=True)
