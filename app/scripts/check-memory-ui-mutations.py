#!/usr/bin/env python3
"""M7 review #574 negative controls. Run from app/; restores each source.

No provider calls or Docker. Every mutation must fail a targeted unit pin.
"""
import os
from pathlib import Path
import subprocess
import sys

A = 'src/lib/memory/actions.server.ts'
P = 'src/components/ark-ui/MemoryPanel.tsx'
D = 'src/lib/db/memories.server.ts'
C = 'src/lib/memory/config.server.ts'
if not Path(A).exists():
    sys.exit('Run from app/')
env = dict(os.environ, CI='1', TEST_DATABASE_URL='postgresql://x:x@127.0.0.1:59999/x')
gate = 'src/__tests__/lib/memory'
panel = 'src/__tests__/components/ark-ui/MemoryPanel.test.tsx'
sql = 'src/__tests__/lib/db/memories-sql.test.ts'
cases = [
    ('M1 ungate listMyMemories', A,
     'export async function listMyMemories() {\n  const user = await requireUser()',
     'export async function listMyMemories() {\n  const user = { id: "unguarded" }', gate),
    ('M2 requireUser always bypasses', A, 'if (isBypassEnabled())', 'if (true)', gate),
    ('M3 exported listFor(user_id)', A, None,
     '\nexport async function listFor(user_id: string) { const user = await requireUser(); void user; return listMemoriesForUser(user_id) }', gate),
    ('M4 forgetMemory uid owner', A,
     'export async function forgetMemory(memoryId: string) {\n  const user = await requireUser()\n  if (typeof memoryId !== \'string\' || !memoryId.trim()) throw new Error(\'Memory ID required\')\n  await deleteMemoryForUser(user.id, memoryId)',
     'export async function forgetMemory(memoryId: string, uid?: string) {\n  const user = await requireUser()\n  if (typeof memoryId !== \'string\' || !memoryId.trim()) throw new Error(\'Memory ID required\')\n  await deleteMemoryForUser(uid ?? user.id, memoryId)', gate),
    ('M5 forgetMemory who overwrites principal', A,
     'export async function forgetMemory(memoryId: string) {\n  const user = await requireUser()',
     'export async function forgetMemory(memoryId: string, who?: string) {\n  const user = await requireUser()\n  if (who) user.id = who', gate),
    ('M6 export sources without owner', D,
     'WHERE s.user_id = $1 AND s.memory_id = m.id', 'WHERE s.memory_id = m.id', sql),
    ('M7 memory as innerHTML', P,
     '<p whitespace="pre-wrap">{row.content}</p>', '<p innerHTML={row.content} />', panel),
    ('switch RPC without confirmation', P,
     '''if (!d.checked && state().memories.length > 0) {
                  setConfirmSwitchOff(true)
                  setConfirmOpen(true)
                } else void run(() => setMemoryEnabled(d.checked))''',
     'void run(() => setMemoryEnabled(d.checked))', panel),
    ('wake called for a disabled user', C,
     'if (!(await memory.enabled())) return undefined', 'await memory.enabled()', gate),
    ('uncompacted row shown as merged', P,
     'row.compactedFrom > 1', 'row.compactedFrom > 0', panel),
]
failed = False
for name, filename, old, new, target in cases:
    path = Path(filename)
    original = path.read_text()
    if old is not None and original.count(old) != 1:
        sys.exit(f'{name}: expected exactly one mutation anchor')
    try:
        path.write_text(original + new if old is None else original.replace(old, new))
        result = subprocess.run(['corepack', 'pnpm', 'test:run', target], env=env,
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        log = Path('/tmp') / ('m7-mutation-' + name.split()[0] + '.log')
        log.write_text(result.stdout)
        # A compiler/startup error alone is not proof that the assertion caught it.
        red = result.returncode != 0 and 'AssertionError' in result.stdout
        print(f'{name}: {"RED (assertion)" if red else "NOT VERIFIED"} ({log})', flush=True)
        failed |= not red
    finally:
        path.write_text(original)
sys.exit(1 if failed else 0)
