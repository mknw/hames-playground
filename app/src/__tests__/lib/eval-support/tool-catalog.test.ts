/** Live mode's sandbox file tools are the gateway's own rust-mcp-filesystem entries under
 * the production names: the description the model reads is the server's text, not ours. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { V0_IN_VM_SERVERS } from '@hames-ai/sandbox/types'
import { sandboxFileToolsFromGateway } from '../../../lib/eval-support/synthetic-sandbox'

const native = V0_IN_VM_SERVERS.find((s) => s.key === 'filesystem')!.tools
const gateway = (names: string[]) =>
  names.map((name) => ({
    name,
    description: `server text of ${name}`,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  }))

describe('sandboxFileToolsFromGateway', () => {
  it('derives each one from the gateway entry, renamed through V0_IN_VM_SERVERS', () => {
    const tools = sandboxFileToolsFromGateway(gateway([...Object.keys(native), 'bash', 'fetch']))
    expect(tools.map((t) => t.name).sort()).toEqual(Object.values(native).sort())
    for (const [nativeName, exposed] of Object.entries(native))
      expect(tools.find((t) => t.name === exposed)?.description, exposed).toBe(
        `server text of ${nativeName}`,
      )
  })

  it('refuses to invent one the gateway does not list', () => {
    expect(() =>
      sandboxFileToolsFromGateway(gateway(Object.keys(native).filter((n) => n !== 'write_file'))),
    ).toThrow('Production tool metadata missing: write_file (sandbox_write)')
  })

  it('is what the live catalog pushes, and the hermetic stand-ins are not', () => {
    const catalog = readFileSync(resolve('evals/general-next/tool-catalog.ts'), 'utf8')
    expect(catalog).toContain('tools.push(...sandboxFileToolsFromGateway(tools))')
    expect(catalog).not.toContain('SANDBOX_FILE_TOOLS')
  })
})
