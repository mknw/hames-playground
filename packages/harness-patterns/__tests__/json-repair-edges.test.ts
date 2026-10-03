/**
 * json-repair: the branches the app-side suites (`json-repair.test.ts`,
 * `json-repair-unescaped-content.test.ts`) never reach — escapes and empty
 * containers inside the unescaped-content strategy, where it DECLINES, and
 * the bracketed-literal repair's nested / quoted / refused shapes (#407), the
 * last-resort single-key handler's refusal of a multi-member object (#408),
 * and which `, word:` the key-quoting step reads as a key (#453).
 *
 * Each test names the source mutation that reddens it; every one was run
 * (#407, #408 and #453 PR bodies, mutation tables). The colon check in `readObject` has no
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
})

// #408: the last-resort single-key handler checked only that the input BEGINS
// with one key, so a multi-key object malformed anywhere came back as its
// first key holding the text of the others — well-formed, tagged
// `lenient-tokens`, and wrong. Output before the fix, recorded 2026-09-28:
//   {"a": "x "y" z", "b": }   → { a: '"x "y" z", "b":' }
//   {"a": "x "y" z" "b": 1}   → { a: '"x "y" z" "b": 1' }
//   {a: [x,,y], b: 1}         → { a: '[x,,y], b: 1' }
// It now declines, so the call throws, and both loops feed that back to the
// model as a recovery round (#437).
describe('last-resort single-key handler (#408)', () => {
  // Mutation M1: drop `&& !holdsSiblingMember(value)` from the handler → all
  // three collapse into `a` and return.
  it("throws on the issue's three inputs instead of collapsing them into the first key", () => {
    expect(() => repairJson(`{"a": "x "y" z", "b": }`)).toThrow()
    expect(() => repairJson(`{"a": "x "y" z" "b": 1}`)).toThrow()
    expect(() => repairJson(`{a: [x,,y], b: 1}`)).toThrow()
  })

  // Mutation M2: drop the `,\s*key\s*:` branch of MEMBER_START → an unquoted
  // sibling after a comma is folded in again.
  it('throws on an unquoted sibling key after a comma', () => {
    expect(() => repairJson(`{query: Brussels events, time: 10:00}`)).toThrow()
    expect(() => repairJson(`{query: MATCH (c)-[r]-() RETURN c, r, limit: 5}`)).toThrow()
  })

  // Mutation M3: drop `-` from the key class (`[\w$]*`) → `max-results` is
  // not read as a key and folds into `a`.
  it('reads a hyphenated key as a key', () => {
    expect(() => repairJson(`{a: x, max-results: }`)).toThrow()
  })

  // Mutation M4: drop the `"[^"]*"\s*:` branch → a well-formed first member
  // with a broken double-quoted sibling folds into one key.
  it('throws when only the second, double-quoted member is broken', () => {
    expect(() => repairJson(`{"query": "MATCH (c)-[r]-() RETURN c, r", "limit": }`)).toThrow()
  })

  // Mutation M5: drop the `'[^']*'\s*:` branch → a single-quoted sibling
  // key folds into `query`.
  it('throws on a single-quoted sibling key', () => {
    expect(() => repairJson(`{query: RETURN 'a', 'b': 1}`)).toThrow()
  })

  // Mutation M6: loosen ONE_QUOTED_STRING to `/^"[\s\S]*"$/` → a value that
  // merely starts and ends with a quote is exempted and the siblings fold in.
  it('does not exempt a value that only starts and ends with a quote', () => {
    expect(() => repairJson(`{"a": "x", "b": [y,,z], "c": "w"}`)).toThrow()
  })

  // Mutation M7: drop the ONE_QUOTED_STRING exemption → a cleanly quoted
  // Cypher string holding `, n:Person` is declined and the call throws.
  it('keeps one cleanly quoted value whole even when it holds `, key:`', () => {
    expect(repairJsonTracked(`{query: "MATCH (n) RETURN n, n:Person"}`)).toEqual({
      args: { query: 'MATCH (n) RETURN n, n:Person' },
      repair: { strategy: 'lenient-tokens' },
    })
  })

  // What the handler is FOR still works: a colon that does not follow a comma
  // (a label predicate) and a quoted token that no colon follows are content.
  // Mutation M8: widen the comma branch to any whitespace (`[,\s]\s*key\s*:`)
  // → `WHERE a:Person` reads as a member and the first call throws; M9: make
  // the colon optional in the quoted branch (`"[^"]*"\s*:?`) → `"x"` reads as
  // a key and the second call throws.
  it('still repairs a single key whose value carries commas, colons and quotes', () => {
    expect(repairJson(`{query: MATCH (a)-[r]-(b) WHERE a:Person RETURN a, b}`)).toEqual({
      query: 'MATCH (a)-[r]-(b) WHERE a:Person RETURN a, b',
    })
    expect(repairJson(`{query: MATCH (n) RETURN n, "x"}`)).toEqual({
      query: 'MATCH (n) RETURN n, "x"',
    })
  })

  // The price of declining rather than guessing, pinned so it is visible: a
  // label predicate or label write AFTER a comma is indistinguishable from a
  // sibling key, and so is a quoted word followed by a colon, so values the
  // old handler got right now throw. Each throw costs a recovery round (#437),
  // and by default a second unusable answer in a row ends the loop.
  // Mutation: M1 or M2 above → the two Cypher values return one key again;
  // M1, M4 or M6 → the Python one does.
  it('declines `, b:Label`, label writes and `"y":` too — the cost of not guessing', () => {
    expect(() => repairJson(`{query: MATCH (a)-[r]-(b) RETURN a, b:Person}`)).toThrow()
    expect(() => repairJson(`{query: MATCH (a)-[r]->(b) SET a:Customer, b:Vendor}`)).toThrow()
    expect(() => repairJson(`{"code": "if x == "y":\n    print("a", b)"}`)).toThrow()
  })
})

// #453: the lenient chain's key-quoting step quoted EVERY `, ident:` as a key,
// so a `, word:` inside one unquoted value split it into two keys. It runs
// before the last-resort handler, so #408's decline never saw these. Output
// before the fix, recorded 2026-10-03 on main (0a61419a):
//   {query: sites like https://a.com, https://b.com} → { query: 'sites like https://a.com', https: '//b.com' }
//   {query: MATCH (a) RETURN a, b:Person}            → { query: 'MATCH (a) RETURN a', b: 'Person' }
// A key after a comma is now quoted only when its colon is followed by
// whitespace or by the start of a JSON value. A colon glued to a word or a
// path is content, and the steps below keep the value whole or decline it.
describe('key-quoting after a comma (#453)', () => {
  // Mutation K1: restore the old comma branch (no lookahead) → `https` is
  // quoted as a key and the value splits. Mutation K2: drop `(?!\/\/)` from
  // MEMBER_START → the last-resort handler declines and the call throws.
  it('keeps a value holding `, https://` whole', () => {
    expect(repairJsonTracked(`{query: sites like https://a.com, https://b.com}`)).toEqual({
      args: { query: 'sites like https://a.com, https://b.com' },
      repair: { strategy: 'lenient-tokens' },
    })
  })

  // K1 → the second URL becomes a key `https` and the call returns three keys.
  // No step can tell where the URL list ends and `depth` begins, so it throws.
  it('declines a URL list followed by a genuine sibling rather than splitting it', () => {
    expect(() => repairJson(`{urls: https://a.com, https://b.com, depth: 2}`)).toThrow()
  })

  // K1 → both split into `query` + `b` again. #408 declines the same value
  // when the Cypher holds a relationship pattern; before this fix, the same
  // value without one came back split.
  it('declines `, b:Label` whether or not the Cypher holds a relationship pattern', () => {
    expect(() => repairJson(`{query: MATCH (a) RETURN a, b:Person}`)).toThrow()
    expect(() => repairJson(`{query: MATCH (a) SET a:Customer, b:Vendor}`)).toThrow()
  })

  // What key-quoting is FOR still works: a genuinely unquoted key after a
  // comma. The second row is the one multi-key shape the local `.harness-logs`
  // corpus holds. Each row pins one branch of the lookahead; its mutation
  // drops that branch, the key is no longer quoted, and the call throws.
  it.each([
    [
      'K3 `\\s`',
      `{query: movies in Brussels, limit: 5}`,
      { query: 'movies in Brussels', limit: 5 },
    ],
    [
      'K3 `\\s`',
      `{name: graph_web_analyzer, servers: [memory, web_search]}`,
      { name: 'graph_web_analyzer', servers: ['memory', 'web_search'] },
    ],
    ['K4 `"`', `{query:movies,mode:"fast"}`, { query: 'movies', mode: 'fast' }],
    ['K5 `[`', `{name:x,servers:[a, b]}`, { name: 'x', servers: ['a', 'b'] }],
    ['K6 `{`', `{query:x,filter:{status: open}}`, { query: 'x', filter: { status: 'open' } }],
    ['K7 digit', `{query:movies,limit:5}`, { query: 'movies', limit: 5 }],
    ['K8 `-?`', `{query:movies,offset:-1}`, { query: 'movies', offset: -1 }],
    ['K9 literal', `{query:x,verbose:true}`, { query: 'x', verbose: true }],
  ])('still quotes a genuine unquoted key after a comma (%s): %s', (_branch, input, expected) => {
    expect(repairJson(input)).toEqual(expected)
  })

  // Mutation K10: drop the `\b` after `true|false|null` → `nullable` reads as
  // the literal `null`, `b` is quoted as a key and the value splits.
  it('does not read a word that only starts with a literal as a value', () => {
    expect(() => repairJson(`{query: MATCH (a) RETURN a, b:nullable}`)).toThrow()
  })

  // The limit of the fix, pinned so it stays visible: to this step a colon
  // followed by a space separates a key, because `{query: movies, limit: 5}`
  // reads exactly the same way. A value whose own text holds `, word: ` still
  // splits. Mutation K3 (drop `\s`) turns this call into a throw.
  it('still splits a value at `, word: ` with a space — the residual this fix leaves', () => {
    expect(repairJson(`{code: lambda a, b: a + b}`)).toEqual({ code: 'lambda a', b: 'a + b' })
  })

  // Mutation R3: widen MEMBER_START's `(?!\/\/)` to `(?!\/)` → `path` folds
  // into `a` as 'x, path:/work/in' and the call returns.
  it('declines a genuine sibling whose colon is glued to a path', () => {
    expect(() => repairJson(`{a: x, path:/work/in}`)).toThrow()
  })

  // main: { query: 'SELECT id', created_at: ':date FROM orders' }.
  // Mutation R5: add `:` to the lookahead's class → it splits again.
  it('declines a `::` cast after a comma rather than splitting it', () => {
    expect(() => repairJson(`{query: SELECT id, created_at::date FROM orders}`)).toThrow()
  })

  // Residual. Mutation K4 (drop `"` from the lookahead) turns it into a throw.
  it('still splits at a glued colon followed by a value start', () => {
    expect(repairJson(`{query: site:example.com, intitle:"neo4j"}`)).toEqual({
      query: 'site:example.com',
      intitle: 'neo4j',
    })
  })

  // The price of the `//` exemption. Mutation K2 turns it into a throw.
  it('merges a glued sibling whose value starts with `//`', () => {
    expect(repairJson(`{q: x, src://cdn.example.com/a.js}`)).toEqual({
      q: 'x, src://cdn.example.com/a.js',
    })
  })
})
