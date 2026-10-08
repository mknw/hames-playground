#!/usr/bin/env python3
"""M10 controls: from app/, TEST_DATABASE_URL=<private pgvector URL> python3 e2e/check-memory-mutations.py.

Each control temporarily edits ONE file, runs its named layer-2 pin under the
ordinary #516 backstop, requires an assertion failure, then restores exact bytes.
Never run concurrently with another test run or an editor of these files.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

APP = Path(__file__).resolve().parents[1]
ROOT = APP.parent
T = 'app/src/lib/harness-client/turn.server.ts'
S = 'app/src/lib/harness-client/session.server.ts'
R = 'app/src/lib/memory/reconcile.server.ts'
F = 'app/e2e/lib/fake-llm.ts'
P = 'packages/harness-patterns/patterns/withMemory.server.ts'
CONTROLS = [
    ('embedding-dimension', F, [('length: 1024', 'length: 8')], '00-fake-fidelity', 'deterministic 1024'),
    ('extract-marker', 'app/e2e/lib/baml-functions.ts', [("['ExtractMemory', 'You write down what a USER has told an assistant about themselves'],", '')], '00-fake-fidelity', 'knows every function'),
    ('compact-marker', 'app/e2e/lib/baml-functions.ts', [("['CompactMemories', 'You merge several stored memories about one USER into a single memory.'],", '')], '00-fake-fidelity', 'knows every function'),
    ('extract-output', F, [("kind: 'episodic', content: evidence, evidence", "kind: 'episodic', content: 'wrong synthetic output', evidence")], '00-fake-fidelity', 'parses both new functions'),
    ('compact-output', F, [('const latest = members.at(-1)', 'const latest = members[0]')], '00-fake-fidelity', 'parses both new functions'),
    ('recall-after-answer', P, [('return (patterns) => [\n    configuredRecall,', 'return (patterns) => [\n    ...patterns,'), ('...patterns.map((pattern)', '...[configuredRecall].map((pattern)')], '10-memory', 'answers over SSE'),
    ('settle-omitted', T, [('if (memory) {', 'if (false && memory) {')], '10-memory', 'answers over SSE'),
    ('persist-memory-event', T, [('mustPersist ||= result.context.events.length !== before', 'mustPersist ||= false')], '10-memory', 'answers over SSE'),
    ('triggered-eligible', T, [("req.mode === 'interactive' ||\n    (req.mode === 'resume' && held.loaded?.memoryRunOrigin === 'interactive')", 'true')], '10-memory', 'triggered turns exclude'),
    ('resume-origin', T, [("held.loaded?.memoryRunOrigin === 'interactive'", "held.loaded?.memoryRunOrigin === 'triggered'")], '10-memory', 'a resumed'),
    ('memory-disabled', 'app/src/lib/memory/config.server.ts', [('return id ? getMemoryEnabled(id) : false', 'return true')], '10-memory', 'a disabled user'),
    ('lost-save-reconcile', S, [('const repaired = await reconcileMemoryReferences(row.serializedContext, sessionId, userId)', 'const repaired = row.serializedContext')], '10-memory', 'repairs a lost trailing save'),
    ('erase-whole-memory', 'app/src/lib/db/conversations.server.ts', [('await deleteMemoriesForConversations(ids, userId, tx)', '// mutation: leave shared memories behind')], '10-memory', 'erases the whole shared memory'),
    ('erase-transaction', 'app/src/lib/db/conversations.server.ts', [('await deleteMemoriesForConversations(ids, userId, tx)', 'await deleteMemoriesForConversations(ids, userId, { query })')], '10-memory', 'rolls memory erasure back'),
    ('sticky-erasure', R, [('const sources = await listMemorySourcesForConversation(conversationId, userId)', """for (const e of ctx.events) {
      if (e.type !== 'memory_written') continue
      const d = e.data as MemoryWrittenEventData
      const db = await import('../db/memories.server')
      await db.insertMemory({ id: d.memoryId, userId, kind: d.kind, tier: d.tier as never, content: 'synthetic resurrection', evidence: 'synthetic resurrection', embedding: Array.from({length: 1024}, (_, i) => i === 0 ? 1 : 0), embedSpace: 'synthetic' })
      await db.insertMemorySource({ userId, memoryId: d.memoryId, eventId: d.eventId, ordinal: d.ordinal, conversationId })
    }
    const sources = await listMemorySourcesForConversation(conversationId, userId)""")], '10-memory', 'erases the whole shared memory'),
    ('private-describe', 'packages/harness-baml/clients.server.ts', [("describe: 'LocalQwenSmall',", "describe: 'DescribeAnthropic',")], '10-memory', 'answers over SSE'),
    ('private-egress', 'app/src/lib/memory/embedder.server.ts', [('documents: async (texts) => (await embed(texts, config)).vectors', "documents: async (texts) => (await fetch('https://hermetic-backstop.invalid/').catch(() => undefined), (await embed(texts, config)).vectors)")], '10-memory', 'on verda.*answers over SSE'),
    ('nonopted-wake', 'app/src/lib/memory/config.server.ts', [('if (!memory || !harnessUsesMemory(patterns)) return undefined', 'if (!memory) return undefined')], '10-memory', 'an agent without memory'),
    ('app-wipe', 'app/e2e/lib/app.ts', [(".query('DELETE FROM memories WHERE user_id = $1', [userId])", ".query('SELECT 1', [])")], '10-memory', 'the following scenario can wipe'),
    ('browser-wipe', 'app/e2e-browser/lib/db.ts', [("['memories', 'conversations', 'user_prefs']", "['conversations', 'user_prefs']")], '10-memory', 'the browser wipe'),
]

def main():
    url = os.environ.get('TEST_DATABASE_URL', '')
    if not url.startswith('postgresql://') or '@127.0.0.1:59133/' not in url:
        raise SystemExit('Set TEST_DATABASE_URL to your private pgvector database on 127.0.0.1:59133.')
    selected = set(sys.argv[1:])
    unknown = selected - {row[0] for row in CONTROLS}
    if unknown:
        raise SystemExit(f'Unknown controls: {sorted(unknown)}')
    for name, relative, edits, scenario, pin in CONTROLS:
        if selected and name not in selected:
            continue
        file = ROOT / relative
        original = file.read_bytes()
        changed = original.decode()
        for old, new in edits:
            if old not in changed:
                raise SystemExit(f'{name}: source anchor missing: {old}')
            changed = changed.replace(old, new, 1)
        report = Path(f'/tmp/m10-mutation-{name}.json')
        log = Path(f'/tmp/m10-mutation-{name}.log')
        try:
            report.unlink(missing_ok=True)
            file.write_text(changed)
            with log.open('w') as output:
                result = subprocess.run(['pnpm', 'test:e2e', scenario, '-t', pin, '--reporter=json', f'--outputFile={report}'], cwd=APP, env={**os.environ, 'BAML_LOG': 'off'}, stdout=output, stderr=subprocess.STDOUT, timeout=120)
            data = json.loads(report.read_text())
            failures = [test for suite in data['testResults'] for test in suite['assertionResults'] if test['status'] == 'failed']
            if result.returncode == 0 or not failures:
                raise SystemExit(f'{name}: NOT RED (see {log})')
            print(f'{name}: RED {len(failures)} assertion(s); exit {result.returncode}', flush=True)
        finally:
            file.write_bytes(original)

if __name__ == '__main__':
    main()
