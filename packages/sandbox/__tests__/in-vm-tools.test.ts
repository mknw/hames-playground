/**
 * Drift pin for the static in-VM tool table a lazy sandbox advertises
 * (`in-vm-tools.ts`). The table is the contract for the actor's prompt before any
 * VM exists, so a change in what the real servers say must fail here rather than
 * leave the prompt describing a tool that no longer looks like that.
 *
 * Red when: a tool in the table is renamed or dropped, a description or schema is
 * edited on one side only, the pinned filesystem image's recorded descriptors are
 * re-recorded without the table, or `V0_IN_VM_SERVERS` gains or loses an exposed
 * name.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IN_VM_TOOL_DESCRIPTORS } from '../in-vm-tools'
import { V0_IN_VM_SERVERS } from '../types'
import recorded from './fixtures/in-vm-tools.recorded.json'

const exposedByNative = new Map(
  V0_IN_VM_SERVERS.flatMap((s) =>
    Object.entries(s.tools).map(([native, exposed]) => [`${s.key}/${native}`, exposed] as const),
  ),
)

describe('in-VM tool descriptor table', () => {
  it('names exactly the tools V0_IN_VM_SERVERS exposes', () => {
    expect(IN_VM_TOOL_DESCRIPTORS.map((t) => t.name).sort()).toEqual(
      [...exposedByNative.values()].sort(),
    )
  })

  it('restates every recorded descriptor under its exposed name', () => {
    // A raw `tools/list` also carries `inputSchema.$schema` (and a top-level
    // `execution`); the table states neither, so a raw re-record must still pass.
    const asExposed = recorded.tools.map((t) => {
      const { $schema: _draft, ...inputSchema } = t.inputSchema as Record<string, unknown>
      return {
        name: exposedByNative.get(`${t.server}/${t.name}`),
        description: t.description,
        inputSchema,
      }
    })
    expect(asExposed.every((t) => t.name !== undefined)).toBe(true)
    expect(asExposed).toEqual(IN_VM_TOOL_DESCRIPTORS)
  })

  it('records nothing the table has dropped', () => {
    expect(recorded.tools).toHaveLength(IN_VM_TOOL_DESCRIPTORS.length)
  })

  // sandbox_bash is OUR server, so its recording is also checked against its source.
  it('matches the shell server source for sandbox_bash', () => {
    // The source joins the sentence from concatenated literals; undo the joins.
    const source = readFileSync(
      resolve(__dirname, '../../../rootfs/mcp-shell/server.mjs'),
      'utf8',
    ).replace(/'\s*\+\s*'/g, '')
    const bash = IN_VM_TOOL_DESCRIPTORS.find((t) => t.name === 'sandbox_bash')!
    expect(source).toContain(bash.description)
    for (const arg of Object.keys(bash.inputSchema!.properties as Record<string, unknown>)) {
      expect(source).toMatch(new RegExp(`\\b${arg}: z`))
    }
    // The argument descriptions state the server's defaults: both must be the ones
    // the source computes, or the lazy prompt advertises a cwd/timeout that is gone.
    const props = bash.inputSchema!.properties as Record<string, { description: string }>
    const cwd = /Defaults to (\S+)\.$/.exec(props.cwd.description)![1]
    const timeout = /Defaults to (\d+)\.$/.exec(props.timeout_ms.description)![1]
    expect(source).toContain(`process.env.WORK_DIR || '${cwd}'`)
    const sourceTimeout = /SHELL_TIMEOUT_MS \|\| ([\d_]+)/.exec(source)![1].replace(/_/g, '')
    expect(Number(sourceTimeout)).toBe(Number(timeout))
  })
})
