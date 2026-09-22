/**
 * The tool-transport seam's two registration primitives.
 *
 * This file covers the SCOPE and the REGISTRY in isolation — propagation,
 * nesting, the unregister handle, and the source-scan pin that no rank can be
 * expressed. What ORDER dispatch consults them in is `transport-precedence.test.ts`,
 * which drives the real `callTool`.
 *
 * Since #374 the scoped half is the RUN FRAME's `transports` slot rather than a
 * store of this module's own: `withRunFrame({ transports })` supplies it and
 * `amendRunFrame({ transports })` prepends below it. The invariants are
 * unchanged and so are the assertions — the two ways to supply a transport are
 * still structurally different, which is what carries the containment rule.
 *
 * It replaces `__tests__/lib/sandbox/scope.test.ts`, whose four cases pinned the
 * same invariants against a sandbox-owned AsyncLocalStorage that no longer
 * exists. Nothing it pinned is lost: outside-scope, inside-scope, nesting and
 * async propagation are all here, against the core primitive the sandbox now
 * registers through.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import {
  registerTransport,
  activeTransports,
  processTransports,
  type ToolTransport,
} from '@hames-ai/harness-patterns/tool-transport.server'
import {
  withRunFrame,
  amendRunFrame,
  currentRunFrame,
} from '@hames-ai/harness-patterns/run-frame.server'

/** Open-or-amend, which is what the two supply paths do in production:
 *  `harness()` opens the run's frame, `withSandbox` amends it. */
function withTransport<T>(transport: ToolTransport, fn: () => Promise<T>): Promise<T> {
  return currentRunFrame()
    ? amendRunFrame({ transports: [transport] }, fn)
    : withRunFrame({ transports: [transport] }, fn)
}

function fakeTransport(id: string, owns: string[] = []): ToolTransport {
  return {
    id,
    ownsTool: (n) => owns.includes(n),
    callTool: async () => ({ success: true, data: id }),
    listTools: async () => [],
  }
}

describe("the run frame's transports slot — the scoped registry", () => {
  it('is empty outside any frame', () => {
    expect(activeTransports()).toEqual([])
  })

  it('makes the transport visible inside the scope, and only inside', async () => {
    let seen: readonly ToolTransport[] = []
    await withTransport(fakeTransport('t-1'), async () => {
      seen = activeTransports()
    })
    expect(seen.map((t) => t.id)).toEqual(['t-1'])
    expect(activeTransports()).toEqual([])
  })

  it('stacks innermost-first when nested, and pops back on exit', async () => {
    let inner: string[] = []
    let afterInner: string[] = []
    await withTransport(fakeTransport('outer'), async () => {
      await withTransport(fakeTransport('inner'), async () => {
        inner = activeTransports().map((t) => t.id)
      })
      afterInner = activeTransports().map((t) => t.id)
    })
    // Innermost FIRST is the whole ordering rule: dispatch walks this array in
    // order, so `inner` shadowing `outer` for a name they both own is this
    // array's shape rather than a decision taken at the call site.
    expect(inner).toEqual(['inner', 'outer'])
    expect(afterInner).toEqual(['outer'])
  })

  it('propagates through async/await chains', async () => {
    const seen: string[] = []
    await withTransport(fakeTransport('t-async'), async () => {
      await Promise.resolve()
      seen.push(activeTransports()[0]?.id ?? '<none>')
      await new Promise<void>((r) => setTimeout(r, 0))
      seen.push(activeTransports()[0]?.id ?? '<none>')
    })
    expect(seen).toEqual(['t-async', 't-async'])
  })

  it('hands out a frozen stack, so a reader cannot reorder it for everyone else', async () => {
    await withTransport(fakeTransport('a'), async () => {
      await withTransport(fakeTransport('b'), async () => {
        const stack = activeTransports()
        expect(() => (stack as ToolTransport[]).reverse()).toThrow()
        expect(activeTransports().map((t) => t.id)).toEqual(['b', 'a'])
      })
    })
  })
})

describe('registerTransport — the process registry', () => {
  it('keeps registration order and unregisters exactly one entry', () => {
    const offA = registerTransport(fakeTransport('p-a'))
    const offB = registerTransport(fakeTransport('p-b'))
    expect(processTransports().map((t) => t.id)).toEqual(['p-a', 'p-b'])

    offA()
    expect(processTransports().map((t) => t.id)).toEqual(['p-b'])

    // Idempotent: a second call must not remove someone else's later entry.
    const offC = registerTransport(fakeTransport('p-c'))
    offA()
    expect(processTransports().map((t) => t.id)).toEqual(['p-b', 'p-c'])

    offB()
    offC()
    expect(processTransports()).toEqual([])
  })

  it('hands out a copy, so a caller cannot reorder the registry it was given', () => {
    const off = registerTransport(fakeTransport('p-1'))
    const copy = processTransports() as ToolTransport[]
    copy.push(fakeTransport('p-smuggled'))
    expect(processTransports().map((t) => t.id)).toEqual(['p-1'])
    off()
  })
})

/**
 * The invariant's OTHER half is a negative: there is no value a registrant can
 * pass to express a priority. That is a property of the signatures, and a
 * runtime test asserting it would only prove the test compiles — so it is
 * pinned the way this repo pins its other structural absences
 * (`encryption-coverage.test.ts`, `clients-verda.test.ts`): by reading the
 * source.
 */
describe('no registrant can express a priority', () => {
  const SOURCE = readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../../packages/harness-patterns/tool-transport.server.ts',
    ),
    'utf8',
  )
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('registerTransport takes exactly one parameter', () => {
    expect(registerTransport.length).toBe(1)
    expect(code).toMatch(
      /export function registerTransport\(transport: ToolTransport\): \(\) => void/,
    )
  })

  it('the frame carries transports as a plain ordered list, with no rank beside them', () => {
    // The scoped half moved to `run-frame.server.ts`, so the negative moved
    // with it: the slot is `readonly ToolTransport[]`, and the merge that makes
    // it innermost-first is a PREPEND, never a sort against a field a
    // registrant could set.
    const frameCode = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../../../packages/harness-patterns/run-frame.server.ts',
      ),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(frameCode).toMatch(/transports\?: readonly ToolTransport\[\]/)
    expect(frameCode).not.toMatch(/priority|rank|weight|precedence\s*[:?]/i)
    expect(frameCode).not.toMatch(/\.sort\(/)
  })

  it('neither the interface nor the module carries a rank, and nothing is sorted', () => {
    expect(code).not.toMatch(/priority|rank|weight|precedence\s*[:?]/i)
    expect(code).not.toMatch(/\.sort\(/)
  })

  it('the transport module reaches nothing outside harness-patterns', () => {
    const specs = [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1])
    expect(specs).not.toContain('../sandbox')
    for (const spec of specs) {
      expect(spec, `${spec} leaves harness-patterns`).not.toMatch(/^\.\.\//)
    }
  })
})
