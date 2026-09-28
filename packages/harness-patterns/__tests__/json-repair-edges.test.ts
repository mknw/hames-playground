/**
 * json-repair: the branches the app-side suites (`json-repair.test.ts`,
 * `json-repair-unescaped-content.test.ts`) never reach — escapes and empty
 * containers inside the unescaped-content strategy, where it DECLINES, and
 * the bracketed-literal repair's nested / quoted / refused shapes (#407).
 *
 * Each test names the source mutation that reddens it; every one was run
 * (#407 PR body, mutation table). The colon check in `readObject` has no
 * test: `readString(':')` only closes a key on a `"` followed by `:`, so that
 * check cannot be reached and no input can redden a mutation of it.
 */

import { describe, expect, it } from 'vitest'
import { repairJson, repairJsonTracked } from '@hames-ai/harness-patterns/json-repair'

describe('unescaped-content strategy: escapes and empty containers', () => {
  // Mutation J1: in `readString`, never take the `\u` branch → `\u` falls to
  // the JSON_ESCAPES lookup, the strategy declines, and the lenient chain
  // answers instead.
  it('decodes a \\u escape while recovering bare content quotes', () => {
    const r = repairJsonTracked(String.raw`{"a": "caf\u00e9 "b" x"}`)
    expect(r.args).toEqual({ a: 'café "b" x' })
    expect(r.repair).toEqual({
      strategy: 'unescaped-content',
      counts: { quotes: 2, controlChars: 0 },
    })
  })

  // Mutation J2: widen the hex test to `[0-9a-zA-Z]{4}` → `ZZZZ` is accepted
  // as a code point and the strategy reports `unescaped-content`.
  it('declines a malformed \\u escape rather than guessing a code point', () => {
    const r = repairJsonTracked(String.raw`{"a": "\uZZZZ "q" z"}`)
    expect(r.repair?.strategy).toBe('lenient-tokens')
  })

  // Mutation J3: keep an unknown escape as its bare letter (`out += mapped ??
  // esc`) instead of declining.
  it('declines an escape JSON does not define', () => {
    const r = repairJsonTracked(String.raw`{"a": "\q "y" z"}`)
    expect(r.repair?.strategy).toBe('lenient-tokens')
  })

  // Mutations J4 / J4b: delete the early `}` return in `readObject`, or the
  // early `]` return in `readArray` → the empty container is read as a
  // member, the strategy declines, and the lenient chain mangles `c`.
  it('keeps empty objects and arrays empty', () => {
    const r = repairJsonTracked(`{"a": {}, "b": [], "c": "say "hi" now"}`)
    expect(r.args).toEqual({ a: {}, b: [], c: 'say "hi" now' })
    expect(r.repair?.strategy).toBe('unescaped-content')
  })

  // Mutation J5: delete `if (i !== n) return null` → the value is parsed from
  // a PREFIX of the input and the call returns instead of throwing.
  it('declines trailing junk after the root, so the whole call fails', () => {
    expect(() => repairJsonTracked(`{"a": "x "y" z"} trailing`)).toThrow()
  })

  // Mutation J6: let the root be an array (`raw[i] === '[' ? readArray() :
  // readObject()`) → the call returns an array instead of throwing.
  it('refuses a non-object root, which is not a tool_args shape', () => {
    expect(() => repairJsonTracked(`["a "b" c"]`)).toThrow()
  })
})

describe('bracketed values in the lenient chain', () => {
  // Mutation L1: return `'{}'` for every empty literal → `a` becomes `{}`.
  it('parks an empty array as an empty array', () => {
    expect(repairJson(`{a: [], b: x}`)).toEqual({ a: [], b: 'x' })
  })

  // Mutation L2: push nested members as `${key}: ${value}` without quoting
  // the key. The key regex earlier in the chain already quotes identifier
  // keys, so only a key it cannot match (`my-key`) reaches this line; with
  // the mutation the reparse fails and `f` is lost.
  it('quotes a nested key the identifier regex cannot match', () => {
    expect(repairJson(`{a: {my-key: c, d: [e]}, f: 1}`)).toEqual({
      a: { 'my-key': 'c', d: ['e'] },
      f: 1,
    })
  })

  // Mutation L3: always `quoteToken(key)` → an already-quoted `"k"` is
  // re-quoted to `"\"k\""`.
  it('keeps an already-quoted key inside a nested object', () => {
    expect(repairJson(`{a: {"k": v}, b: 1}`)).toEqual({ a: { k: 'v' }, b: 1 })
  })

  // Mutation L4: drop `quoteToken`'s single-quote strip. The input needs a
  // double quote somewhere, or the chain's earlier all-single-quotes swap
  // handles it first and the strip is never reached.
  it("strips a single-quoted element's quotes", () => {
    expect(repairJson(`{"a": ['x', y], "b": 2}`)).toEqual({ a: ['x', 'y'], b: 2 })
  })

  // Mutation L5: drop the backslash skip in `splitTopLevel` → the escaped
  // quote ends the string early and the literal is refused.
  it('repairs nested arrays holding an escaped quote', () => {
    expect(repairJson(`{a: [[x], "y\\"z"], b: 1}`)).toEqual({ a: [['x'], 'y"z'], b: 1 })
  })

  // Mutation L6: `return literal ?? ''` in `unparkBracketedValues` (drop the
  // `=== undefined ? match` guard) → `b` comes back empty.
  it('leaves model text that merely looks like a placeholder alone', () => {
    expect(repairJson(`{a: [x], b: __JSON_REPAIR_LITERAL_7__}`)).toEqual({
      a: ['x'],
      b: '__JSON_REPAIR_LITERAL_7__',
    })
  })

  // Mutation L7: in `scanLiteral`, pop without comparing → `[x}` scans as
  // balanced and the call returns instead of throwing.
  it('refuses a literal whose brackets do not match', () => {
    expect(() => repairJson(`{a: [x}, b: 1}`)).toThrow()
  })

  // Mutation L8: treat a colon-less nested member as `key: null` instead of
  // refusing the literal → `{b}` repairs and the call returns.
  it('refuses a nested object member with no colon', () => {
    expect(() => repairJson(`{a: {b}, c: 1}`)).toThrow()
  })

  // #408: the last-resort single-key handler does not check that the input
  // HAS a single key, so a malformed multi-key object collapses into its
  // first key. Current output, recorded 2026-09-28:
  //   {"a": "x "y" z", "b": }   → { a: '"x "y" z", "b":' }
  //   {a: [x,,y], b: 1}         → { a: '[x,,y], b: 1' }
  // Un-skip when #408 is fixed.
  it.skip('BUG #408: a malformed multi-key object throws instead of collapsing into one key', () => {
    expect(() => repairJson(`{"a": "x "y" z", "b": }`)).toThrow()
    expect(() => repairJson(`{a: [x,,y], b: 1}`)).toThrow()
  })
})
