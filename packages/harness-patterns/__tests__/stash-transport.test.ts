/**
 * The stash transport seam: which `CallTool` the Data Stash pipeline defaults
 * to, and which ones the list cache may treat as a REAL backend.
 *
 * Mutations that redden this file (each run by hand, #407):
 *  - `resolveStashCallTool` returning `gatewayCallTool` unconditionally →
 *    "a registered host resolver wins" goes red.
 *  - deleting `resolver = undefined` from `resetStashTransport` → "reset
 *    reverts to the gateway" goes red.
 *  - deleting `builtinPredicates.length = 0` from `registerStashTransport` →
 *    "a re-registration drops the previous predicate" goes red.
 *  - deleting the same line from `resetStashTransport` → "reset drops the
 *    predicate" goes red.
 *  - never pushing `isBuiltin` → "a host predicate marks its own transport
 *    builtin" goes red.
 *  - `isBuiltinStashTransport` without the `=== gatewayCallTool` arm → both
 *    "the gateway is always builtin" tests go red.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

// A stand-in for the gateway client, so importing the seam opens no socket.
vi.mock('@hames-ai/harness-patterns/mcp-client.server', () => ({
  callTool: vi.fn(async () => ({ success: false, data: null, error: 'no gateway' })),
}))

import {
  gatewayCallTool,
  isBuiltinStashTransport,
  registerStashTransport,
  resetStashTransport,
  resolveStashCallTool,
} from '@hames-ai/harness-patterns/stash-transport.server'
import type { CallTool } from '@hames-ai/harness-patterns/stash/document-store.server'

const fake = (): CallTool => vi.fn(async () => ({ success: true, data: null })) as CallTool

afterEach(() => resetStashTransport())

describe('resolveStashCallTool', () => {
  it('defaults to the gateway when no host registered', () => {
    expect(resolveStashCallTool()).toBe(gatewayCallTool)
  })

  it('a registered host resolver wins, and is asked on every resolve', () => {
    const host = fake()
    const resolve = vi.fn(() => host)
    registerStashTransport(resolve)
    expect(resolveStashCallTool()).toBe(host)
    expect(resolveStashCallTool()).toBe(host)
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('reset reverts to the gateway', () => {
    registerStashTransport(() => fake())
    resetStashTransport()
    expect(resolveStashCallTool()).toBe(gatewayCallTool)
  })
})

describe('isBuiltinStashTransport', () => {
  it('the gateway is always builtin, an unregistered fake never is', () => {
    expect(isBuiltinStashTransport(gatewayCallTool)).toBe(true)
    expect(isBuiltinStashTransport(fake())).toBe(false)
  })

  it('a host predicate marks its own transport builtin', () => {
    const host = fake()
    registerStashTransport(
      () => host,
      (c) => c === host,
    )
    expect(isBuiltinStashTransport(host)).toBe(true)
    expect(isBuiltinStashTransport(fake())).toBe(false)
  })

  it('a re-registration drops the previous predicate', () => {
    const first = fake()
    registerStashTransport(
      () => first,
      (c) => c === first,
    )
    registerStashTransport(() => fake())
    expect(isBuiltinStashTransport(first)).toBe(false)
  })

  it('reset drops the predicate but keeps the gateway builtin', () => {
    const host = fake()
    registerStashTransport(
      () => host,
      (c) => c === host,
    )
    resetStashTransport()
    expect(isBuiltinStashTransport(host)).toBe(false)
    expect(isBuiltinStashTransport(gatewayCallTool)).toBe(true)
  })
})
