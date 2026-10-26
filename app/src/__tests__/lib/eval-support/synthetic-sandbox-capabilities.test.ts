/** The eval's synthetic `withSandbox` declares the in-VM tool names the production wrapper
 * declares (ordiag finding 2026-10-26: the fixture returned the wrapped pattern with NO
 * `capabilities`, `collectToolNames(office)` yielded no `sandbox_` names, the egress gate's
 * `localTools` stayed empty and every `sandbox_*` call was judged outgoing and refused at
 * τe — route closed, budget exhausted). The discriminating assertion is the second one: a
 * tool the synthetic transport SERVES but the declaration OMITS fails the test. Both sides
 * are derived from `V0_IN_VM_SERVERS` — the same registry production's
 * `packages/sandbox/with-sandbox.server.ts:54` derives `IN_VM_TOOL_NAMES` from. */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

import { configurePattern } from '@hames-ai/harness-patterns/patterns/chain.server'
import { collectToolNames } from '@hames-ai/harness-patterns/patterns/decisionLoop-records.server'
import type { SandboxAttach } from '@hames-ai/agents'
import { V0_IN_VM_SERVERS } from '@hames-ai/sandbox/types'
import {
  IN_VM_TOOL_NAMES,
  SANDBOX_FILE_TOOLS,
  createSyntheticSandbox,
  createSyntheticWithSandbox,
} from '../../../lib/eval-support/synthetic-sandbox'
import type {
  ConversationScenario,
  ConversationTrace,
} from '../../../lib/eval-support/conversation'

/** The eval fixture's sandbox surface: the five file tools plus the shell, the names the
 * synthetic transport actually serves (`evals/general-next/driver.ts` NAMESPACES). The
 * bash description mirrors the driver's own fixture entry. */
const SERVED = [
  ...SANDBOX_FILE_TOOLS,
  {
    name: 'sandbox_bash',
    description:
      'Run a shell command. Inputs: /work/in/lantern-notes.md and /work/in/lantern-sales.csv. Outputs: /work/out.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
  },
]

const scenario = {} as unknown as ConversationScenario

function syntheticSandbox() {
  return createSyntheticSandbox({
    scenario: () => scenario,
    trace: () => undefined as ConversationTrace | undefined,
    turn: () => 0,
    documents: new Map(),
    descriptions: SERVED,
  })
}

describe('createSyntheticWithSandbox capabilities', () => {
  it('declares every in-VM name production derives from V0_IN_VM_SERVERS', () => {
    expect([...IN_VM_TOOL_NAMES].sort()).toEqual(
      V0_IN_VM_SERVERS.flatMap((server) => Object.values(server.tools)).sort(),
    )
  })

  it('the synthetic transport serves exactly the production in-VM surface', () => {
    expect(SERVED.map((t) => t.name).sort()).toEqual([...IN_VM_TOOL_NAMES].sort())
  })

  it('every sandbox_-prefixed tool the transport serves is declared in capabilities.tools', async () => {
    const transport = syntheticSandbox()
    const withSandbox = createSyntheticWithSandbox(transport)<Record<string, unknown>>
    const wrapped = withSandbox({} as SandboxAttach)(configurePattern('probe', async (s) => s))
    const declared = new Set(wrapped.capabilities?.tools ?? [])
    const served = (await transport.listTools())
      .map((t) => t.name)
      .filter((name) => name.startsWith('sandbox_'))
    expect(served.length).toBeGreaterThan(0)
    for (const name of served) expect(declared, name).toContain(name)
  })

  it('collectToolNames over the wrapped pattern yields the in-VM names, merge keeps the pattern’s own', () => {
    const transport = syntheticSandbox()
    const withSandbox = createSyntheticWithSandbox(transport)<Record<string, unknown>>
    const wrapped = withSandbox({} as SandboxAttach)({
      ...configurePattern('probe', async (s) => s),
      capabilities: { tools: ['graph_mail_recent'] },
    })
    // The derivation general-next.server.ts:175 does over the wrapped office pattern.
    const sandboxTools = collectToolNames(wrapped).filter((name) => name.startsWith('sandbox_'))
    expect(sandboxTools.sort()).toEqual([...IN_VM_TOOL_NAMES].sort())
    expect(collectToolNames(wrapped)).toContain('graph_mail_recent')
  })
})
