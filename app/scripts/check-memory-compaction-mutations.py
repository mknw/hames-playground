"""#576 fix rounds 1/2: isolated assertion mutations; restores every file.

Run from app/: python3 scripts/check-memory-compaction-mutations.py /tmp/m3-results
No DB, Docker or live providers. Author A1-A22 reproduce the published table; A9/A10 migrate to G11 equivalents.
Only eight reviewer mutations were enumerated publicly; R1-R19 reconstruct the
named controls and finding pins, NOT a claim to possess the reviewer's harness.
The coordinator approved this reconstruction; the reviewer owns the delta rerun.
The original 44 cases remain; round 2 adds five G1/G2/G3 assertion mutations.
"""
from pathlib import Path
import json
import os
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / 'packages/harness-patterns'
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/tmp/m3-fix1-mutations')
OUT.mkdir(parents=True, exist_ok=True)
CORE = 'memory-compaction.server.ts'
PURE = 'memory-compaction-pure.server.ts'
STORE = 'memory-store.server.ts'
KEEP_LABEL = """    {
      id: 'keep',
      description: 'Keep separately: distinct facts, uncertainty or any loss of meaning.',
    },
"""
MERGE_LABEL = """    {
      id: 'merge',
      description:
        'They express one fact; merge, resolving contradictions toward the most recent member.',
    },
"""
# id, file, old, new, optional test-name filter
CASES = [
 ('A1-tier', PURE, 'm.tier === row.tier &&', 'true &&', ''),
 ('A2-kind', PURE, 'm.kind === row.kind &&', 'true &&', ''),
 ('A3-space', PURE, 'm.embedSpace === row.embedSpace &&', 'true &&', ''),
 ('A4-threshold', PURE, 'memoryCosine(m.embedding, row.embedding) >= threshold', 'true', ''),
 ('A5-acceptance', PURE, '  return acceptCandidate(', '  return true; return acceptCandidate(', ''),
 ('A6-evidence', PURE, 'if (value.evidence !== latest.evidence) return false', 'if (false) return false', ''),
 ('A7-default-retention', PURE, 'episodic: 180,', 'episodic: 181,', ''),
 ('A8-override-retention', PURE, 'const retention = memoryRetention(cfg)', 'const retention = memoryRetention()', ''),
 ('A9-G11-no-calibration-policy', CORE, "if (d.decision.label !== 'merge' || d.decision.abstained) return kept", "if (!d.decision.calibrated || d.decision.label !== 'merge' || d.decision.abstained) return kept", ''),
 ('A10-G11-keep-on-error', CORE, "if (d.decision.label !== 'merge' || d.decision.abstained) return kept", "if (false) return kept", ''),
 ('A11-evidence-id', CORE, 'evidenceEventId: latest.evidenceEventId,', "evidenceEventId: 'wrong-event',", ''),
 ('A12-retention-clock', CORE, 'lastSeenAt: latest.lastSeenAt,', 'lastSeenAt: now,', ''),
 ('A13-source-count', CORE, ') !== row.sources.length', ') === -1', ''),
 ('A14-delete-members', CORE, 'await remove(tx, members)', 'await Promise.resolve()', ''),
 ('A15-accumulated-count', CORE, 'n + m.compactedFrom', 'n + 1', ''),
 ('A16-tier-refusal', CORE, 'await cfg.assertTier(tier)', 'await Promise.resolve()', ''),
 ('A17-post-inference-switch', CORE, "if (!(await cfg.enabled())) throw new Error('memory disabled during compaction')", 'if (false) throw new Error()', ''),
 ('A18-redaction', CORE, 'redactCall(d.llmCall)', 'd.llmCall', ''),
 ('A19-eviction-kind', CORE, "m.kind === 'episodic'", 'true', ''),
 ('A20-daily-interval', CORE, 'delay = 86_400_000', 'delay = 86_400', ''),
 ('A21-insertion-ceiling', STORE, 'after >= hard', 'after > hard', ''),
 ('A22-insertion-eviction', STORE, 'await tx.evictOldestEpisodes(count - hard + 1)', 'await Promise.resolve()', ''),
 ('R1-soft-gate-formerly-GREEN', CORE, 'if (snapshot.rows.length >= l.soft)', 'if (true)', ''),
 ('R2-target-break-formerly-GREEN', CORE, 'if (report.remaining <= l.target) break', '', ''),
 ('R3-stale-space-formerly-GREEN', CORE, 'members.length < 2 || members[0].embedSpace !== cfg.embed.spaceId', 'members.length < 2', ''),
 ('R4-NFKC-formerly-GREEN', CORE, "value.content.normalize('NFKC').trim()", 'value.content.trim()', ''),
 # Move expiry to the merge transaction: a failed source move undoes it.
 ('R5-F1-expiry-rollback', CORE, '      await remove(tx, expired)', '      // mutation: defer expiry until merge', 'F1: expiry'),
 ('R6-F1-inference-lock', CORE, 'return prepare(cfg, members)', 'return cfg.store.transaction(() => prepare(cfg, members))', 'F1: concurrent'),
 ('R7-acceptance-homogeneity', PURE, 'm.kind !== latest.kind || m.tier !== latest.tier || m.embedSpace !== latest.embedSpace', 'false', ''),
 ('R8-F1-member-reverify', CORE, 'return matches.length === 1 && unchanged(m, matches[0])', 'return true', ''),
 ('R9-events-before-commit', CORE, 'await tx.insert({ ...row, sources: [] })', 'ctx.events.push(...result.events); await tx.insert({ ...row, sources: [] })', ''),
 ('R10-F2-per-cluster-switch', CORE, "if (!(await cfg.enabled())) return { ...report, skipped: 'disabled' }\n        const tier", 'const tier', ''),
 ('R11-persistent-kinds', PURE, 'days !== null && Number.isFinite(row.lastSeenAt)', 'Number.isFinite(row.lastSeenAt)', ''),
 ('R12-per-kind-override', PURE, 'const retention = { ...DEFAULT_MEMORY_RETENTION, ...cfg }', 'const retention = { ...DEFAULT_MEMORY_RETENTION }', ''),
 ('R13-F3-bad-row-blocks-expiry', CORE, 'const expired = expiredMemories(rows, now, cfg.retention)', "if (!verifiable(rows)) throw new Error('unverifiable snapshot'); const expired = expiredMemories(rows, now, cfg.retention)", ''),
 ('R14-F4-full-trigger', STORE, 'let compactionDue = full', 'let compactionDue = false', ''),
 ('R15-F4-startup-sweep', CORE, '  schedule(0)', '  schedule()', ''),
 ('R16-F5-cluster-cap', CORE, 'if (members.length > l.maxClusterSize)', 'if (false)', ''),
 ('R17-F8-later-reinforcement', STORE, "        full = true\n        logStop('full')\n        continue", "        return stop('full', undefined, { written, duplicates, failed, route, rejected, compactionDue: true })", ''),
 ('R18-F9-routing-docs', 'types.ts', 'company-run only on the private', 'company-run on every', ''),
 ('R19-F10-timeout-docs', 'SPEC.md', 'have no abort signal', 'have an abort signal', ''),
 ('F7-bare-host-guard', 'GUIDE.md', "const assertTier = (tier: string) => {\n  if (tier !== 'anthropic' && tier !== 'verda') throw new TypeError('unknown memory tier')\n  assertInferenceTier(tier)\n}", 'const assertTier = assertInferenceTier', ''),
 ('F9-deletion-audit-docs', 'SPEC.md', 'are deliberately not context events in M3', 'are recorded as context events in M3', ''),
 ('F9-changeset-full', '../../.changeset/memory-core-compaction.md', '`settleMemory` now refuses insertion at `hardLimit` (default 400)', 'Settle has no capacity change', ''),
 ('G1-tie-order', CORE, KEEP_LABEL + MERGE_LABEL, MERGE_LABEL + KEEP_LABEL, 'G1:'),
 ('G2-switch-before-summary', CORE, '  if (!(await cfg.enabled())) return kept', '', 'G2:'),
 ('G3-kept-decision', CORE, '        if (!committed) {\n          ctx.events.push(...result.events)', '        if (!committed) {', 'G3: a failed member'),
 ('G3-expiry-switch', CORE, 'const snapshot = await cfg.store.transaction(async (tx) => {\n      if (!(await cfg.enabled())) return undefined', 'const snapshot = await cfg.store.transaction(async (tx) => {', 'G3: switch-off under the expiry'),
 ('G3-eviction-switch', CORE, 'const final = await cfg.store.transaction(async (tx) => {\n      if (!(await cfg.enabled())) return undefined', 'const final = await cfg.store.transaction(async (tx) => {', 'G3: switch-off under the eviction'),

]
COMMAND = ['corepack', 'pnpm', 'exec', 'vitest', 'run', '--root', str(BASE),
           '__tests__/memory-compaction.test.ts', '__tests__/memory-store.test.ts', '__tests__/with-memory.test.ts']
ENV = {**os.environ, 'CI': '1', 'TEST_DATABASE_URL': 'postgresql://x:x@127.0.0.1:59999/x', 'BAML_LOG': 'warn'}

def run(name, test=''):
    r = subprocess.run(COMMAND + (['-t', test] if test else []), cwd=ROOT / 'app',
                       env=ENV, capture_output=True, text=True, timeout=120)
    output = r.stdout + r.stderr
    (OUT / (name + '.log')).write_text(output)
    return r.returncode, bool(re.search(r'AssertionError', output))

results = []
if run('baseline')[0]:
    raise RuntimeError('restored baseline must pass first')
for name, file, old, new, test in CASES:
    path = BASE / file
    original = path.read_text()
    if original.count(old) != 1:
        raise RuntimeError(f'{name}: expected exactly one mutation anchor, found {original.count(old)}')
    try:
        mutated = original.replace(old, new, 1)
        if name == 'R5-F1-expiry-rollback':
            anchor = 'const fresh = [...(await tx.list())]'
            assert mutated.count(anchor) == 1
            mutated = mutated.replace(anchor, anchor + '\n          await remove(tx, expiredMemories(fresh, now, cfg.retention))', 1)
        path.write_text(mutated)
        code, assertion = run(name, test)
        result = {'mutation': name, 'exit': code, 'result': 'RED' if code and assertion else 'INVALID' if code else 'GREEN'}
        results.append(result)
        (OUT / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
        print(f'{name}: {result["result"]}', flush=True)
    finally:
        path.write_text(original)
if run('restored')[0]:
    raise RuntimeError('restored baseline failed')
if any(r['result'] != 'RED' for r in results):
    raise RuntimeError('not every mutation failed by assertion')
print(f'{len(results)}/{len(results)} assertion RED; restored baseline PASS')
