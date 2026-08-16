/**
 * Sandbox ALS scope unit tests.
 *
 * Covers `runWithSandbox` / `getActiveSandbox` propagation invariants — the
 * load-bearing primitive for build-order step 3 (see docs/plan/sandbox.md →
 * "How tools reach the controller").
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import { runWithSandbox, getActiveSandbox } from '../../../lib/sandbox/scope.server'
import type { McpTransport } from '../../../lib/sandbox/types'

function fakeTransport(vmId: string): McpTransport {
  return {
    vmId,
    toolNames: async () => [],
    listTools: async () => [],
    ownsTool: () => false,
    callTool: async () => ({ success: true, data: null }),
    close: async () => {},
  }
}

describe('sandbox scope', () => {
  it('returns undefined outside any scope', () => {
    expect(getActiveSandbox()).toBeUndefined()
  })

  it('makes the transport visible inside runWithSandbox', async () => {
    const t = fakeTransport('vm-1')
    let captured: McpTransport | undefined
    await runWithSandbox(t, async () => {
      captured = getActiveSandbox()
    })
    expect(captured?.vmId).toBe('vm-1')
    // Outside the scope, the store is empty again.
    expect(getActiveSandbox()).toBeUndefined()
  })

  it('overrides the outer scope inside a nested runWithSandbox', async () => {
    const outer = fakeTransport('outer')
    const inner = fakeTransport('inner')
    let midVm: string | undefined
    let afterInnerVm: string | undefined
    await runWithSandbox(outer, async () => {
      await runWithSandbox(inner, async () => {
        midVm = getActiveSandbox()?.vmId
      })
      afterInnerVm = getActiveSandbox()?.vmId
    })
    expect(midVm).toBe('inner')
    expect(afterInnerVm).toBe('outer')
  })

  it('propagates through async/await chains', async () => {
    const t = fakeTransport('vm-async')
    const seen: string[] = []
    await runWithSandbox(t, async () => {
      await Promise.resolve()
      seen.push(getActiveSandbox()?.vmId ?? '<none>')
      await new Promise<void>((r) => setTimeout(r, 0))
      seen.push(getActiveSandbox()?.vmId ?? '<none>')
    })
    expect(seen).toEqual(['vm-async', 'vm-async'])
  })
})
