/**
 * @vitest-environment node
 *
 * The server-only guard every `.server.ts` module calls at import time.
 *
 * This suite runs under the node environment on purpose: importing the module
 * under jsdom would trip its own self-check at load. The behaviour that matters
 * is that a browser-like global (a `window`) is refused — that is what stops a
 * secret-bearing module from being bundled into the client.
 */

import { describe, it, expect, afterEach } from 'vitest'

import {
  assertServer,
  assertServerOnImport,
  ServerOnlyError,
} from '../../../lib/harness-patterns/assert.server'

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('assertServer', () => {
  it('passes in a server runtime', () => {
    expect(() => assertServer()).not.toThrow()
    expect(() => assertServerOnImport()).not.toThrow()
  })

  it('refuses to run once a window global exists', () => {
    ;(globalThis as { window?: unknown }).window = {}

    expect(() => assertServer()).toThrow(ServerOnlyError)
    expect(() => assertServerOnImport()).toThrow(/must run on server/)
  })
})

describe('ServerOnlyError', () => {
  it('is a named Error carrying the default message', () => {
    const err = new ServerOnlyError()

    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ServerOnlyError')
    expect(err.message).toBe('harness-patterns must run on server')
  })

  it('accepts a caller-supplied message', () => {
    expect(new ServerOnlyError('nope').message).toBe('nope')
  })
})
