/** Live mode's sandbox file tools are production's own pre-VM text: general-next's office
 * sandbox is lazy, so its actor's prompt lists `IN_VM_TOOL_DESCRIPTORS` (the pinned
 * rust-mcp-filesystem image's descriptors under the production names, held to the image by the
 * sandbox package's drift pin) — not the gateway's entries and not the hermetic stand-ins (#1032).
 * Mutations that turn this red: return `SANDBOX_FILE_TOOLS` from `lazySandboxFileTools` (first
 * case); push the gateway derivation or the stand-ins in the live catalog (last case). */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { V0_IN_VM_SERVERS } from '@hames-ai/sandbox/types'
import { IN_VM_TOOL_DESCRIPTORS } from '@hames-ai/sandbox/in-vm-tools'
import { lazySandboxFileTools } from '../../../lib/eval-support/synthetic-sandbox'

const native = V0_IN_VM_SERVERS.find((s) => s.key === 'filesystem')!.tools

describe('lazySandboxFileTools', () => {
  it('is the five file tools exactly as the lazy sandbox advertises them', () => {
    const tools = lazySandboxFileTools()
    expect(tools.map((t) => t.name).sort()).toEqual(Object.values(native).sort())
    for (const tool of tools)
      expect(tool, tool.name).toEqual(IN_VM_TOOL_DESCRIPTORS.find((t) => t.name === tool.name))
    expect(tools.map((t) => t.name)).not.toContain('sandbox_bash')
  })

  it('hands out copies, so a caller cannot rewrite the shared table', () => {
    const [first] = lazySandboxFileTools()
    first.description = 'changed'
    expect(IN_VM_TOOL_DESCRIPTORS.find((t) => t.name === first.name)?.description).not.toBe(
      'changed',
    )
  })

  it('is what the live catalog pushes, and the gateway derivation and the stand-ins are not', () => {
    const catalog = readFileSync(resolve('evals/general-next/tool-catalog.ts'), 'utf8')
    expect(catalog).toContain('tools.push(...lazySandboxFileTools())')
    expect(catalog).not.toContain('SANDBOX_FILE_TOOLS')
    expect(catalog).not.toContain('FromGateway')
  })
})
