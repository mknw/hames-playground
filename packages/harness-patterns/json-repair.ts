/**
 * Lenient JSON repair for LLM output.
 *
 * Smaller/faster LLMs (Groq Llama, etc.) frequently output relaxed
 * JSON-like syntax with unquoted keys or string values.
 * This utility attempts a strict parse first, then applies lightweight
 * regex repairs before retrying.
 */

/**
 * Index just past the bracket matching the one at `start`, or -1 when the
 * literal is unbalanced. Double-quoted strings (with backslash escapes) are
 * skipped, so `["a]b"]` closes at the right place. Single quotes are NOT
 * treated as delimiters — apostrophes in bare text are far more common in LLM
 * output than a bracket inside a single-quoted string.
 */
function scanLiteral(s: string, start: number): number {
  const expected: string[] = []
  let inString = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '[') expected.push(']')
    else if (ch === '{') expected.push('}')
    else if (ch === ']' || ch === '}') {
      if (expected.pop() !== ch) return -1
      if (expected.length === 0) return i + 1
    }
  }
  return -1
}

/** Split literal contents on top-level commas. null when unbalanced. */
function splitTopLevel(inner: string): string[] | null {
  const parts: string[] = []
  let depth = 0
  let inString = false
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') {
      depth--
      if (depth < 0) return null
    } else if (ch === ',' && depth === 0) {
      parts.push(inner.slice(start, i))
      start = i + 1
    }
  }
  if (depth !== 0 || inString) return null
  parts.push(inner.slice(start))
  return parts
}

/** Split an object member on its first top-level colon. null when there is none. */
function splitMember(item: string): [string, string] | null {
  let depth = 0
  let inString = false
  for (let i = 0; i < item.length; i++) {
    const ch = item[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
    else if (ch === ':' && depth === 0) return [item.slice(0, i), item.slice(i + 1)]
  }
  return null
}

/** true when `token` is already a valid JSON scalar (string, number, bool, null). */
function isJsonScalar(token: string): boolean {
  try {
    const parsed: unknown = JSON.parse(token)
    return typeof parsed !== 'object' || parsed === null
  } catch {
    return false
  }
}

/** Quote a bare token, stripping surrounding single quotes the LLM may have added. */
function quoteToken(token: string): string {
  const singleQuoted = token.match(/^'([\s\S]*)'$/)
  return JSON.stringify(singleQuoted ? singleQuoted[1] : token)
}

/** Repair one value: recurse into nested literals, quote bare scalars. null on failure. */
function repairValue(rawValue: string): string | null {
  const token = rawValue.trim()
  if (token === '') return null
  if (token.startsWith('[') || token.startsWith('{')) {
    return scanLiteral(token, 0) === token.length ? repairLiteral(token) : null
  }
  return isJsonScalar(token) ? token : quoteToken(token)
}

/**
 * Repair a balanced array/object literal whose contents may be unquoted, e.g.
 * `[X, [b, c]]` → `["X", ["b", "c"]]`. Returns null when anything looks off, so
 * the caller can leave the region untouched rather than guess.
 */
function repairLiteral(literal: string): string | null {
  const isArray = literal.startsWith('[')
  const inner = literal.slice(1, -1)
  if (inner.trim() === '') return isArray ? '[]' : '{}'

  const items = splitTopLevel(inner)
  if (!items) return null

  const repaired: string[] = []
  for (const item of items) {
    if (item.trim() === '') return null
    if (isArray) {
      const value = repairValue(item)
      if (value === null) return null
      repaired.push(value)
      continue
    }
    const member = splitMember(item)
    if (!member) return null
    const key = member[0].trim()
    const value = repairValue(member[1])
    if (key === '' || value === null) return null
    repaired.push(`${isJsonScalar(key) && key.startsWith('"') ? key : quoteToken(key)}: ${value}`)
  }
  return isArray ? `[${repaired.join(', ')}]` : `{${repaired.join(', ')}}`
}

const PLACEHOLDER = (index: number) => `__JSON_REPAIR_LITERAL_${index}__`

/**
 * Replace every `: [...]` / `: {...}` value with a placeholder, collecting the
 * repaired literal into `parked`. Without this the unquoted-value regex below —
 * which deliberately skips bracketed values — lets the last-resort single-key
 * handler swallow the sibling keys: `{author: [X], limit: 5}` silently became
 * `{"author": "[X], limit: 5"}`.
 *
 * Only complete values are parked (the literal must be followed by `,`, `}` or
 * `]`), so trailing junk still falls through to the original handling.
 */
function parkBracketedValues(s: string, parked: string[]): string {
  let out = ''
  let i = 0
  let inString = false
  while (i < s.length) {
    const ch = s[i]
    if (inString) {
      out += ch
      if (ch === '\\' && i + 1 < s.length) {
        out += s[i + 1]
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i++
      continue
    }
    if (ch === '"') inString = true
    if (ch === ':') {
      let open = i + 1
      while (open < s.length && /\s/.test(s[open])) open++
      if (s[open] === '[' || s[open] === '{') {
        const end = scanLiteral(s, open)
        let after = end
        while (after > 0 && after < s.length && /\s/.test(s[after])) after++
        const complete = end > 0 && (after === s.length || [',', '}', ']'].includes(s[after]))
        const repaired = complete ? repairLiteral(s.slice(open, end)) : null
        if (repaired !== null) {
          parked.push(repaired)
          out += s.slice(i, open) + PLACEHOLDER(parked.length - 1)
          i = end
          continue
        }
      }
    }
    out += ch
    i++
  }
  return out
}

/** Put the parked literals back, with or without the quotes the value regex added. */
function unparkBracketedValues(s: string, parked: string[]): string {
  if (parked.length === 0) return s
  return s.replace(/"?__JSON_REPAIR_LITERAL_(\d+)__"?/g, (match, index: string) => {
    const literal = parked[Number(index)]
    return literal === undefined ? match : literal
  })
}

// ---------------------------------------------------------------------------
// Strategy 1: string CONTENT that was not escaped
// ---------------------------------------------------------------------------
//
// `ControllerAction.tool_args` is a STRING whose content is JSON (#145), so a
// `"` belonging to the payload's own data has to survive two encodings and is
// written `\\\"`, while a `"` belonging to the payload's JSON structure is
// written `\"`. Captured live in `.harness-logs/sandbox-tool-recovery.json`
// (event `ev-tey7ez`, the `flavour-office-loop` actor): a 19 180-character
// `sandbox_edit` whose `newText` was openpyxl code full of Excel formulas —
// `"='Revenue Model'!N" + str(row)` — reached this module with 5 of its 38
// content quotes doubly escaped and 33 singly escaped, so the first of the 33
// ended `newText` 13 706 characters in and `JSON.parse` asked for a `,`.
// Nothing upstream could have caught it: the response was 9 913 tokens against
// a 32 768 cap (no truncation), the envelope itself was a well-formed JSON
// object (no shape to recover, cf. `controller-action.ts`), and the prompt the
// model was reading DID demonstrate the `\\\"` form — the flavoured-sandbox
// few-shot writes `print(\\\"hello\\\")` — 5 KB above the defect. A
// demonstration that holds for a 40-character script does not hold for 18 KB
// of quote-dense code, which is why this is a parse-side fix.
//
// The failure leaves the document's STRUCTURE intact and corrupts only string
// CONTENT, and that is what makes it recoverable at all: a `"` can be read as
// content whenever the grammar does not need it as a delimiter there. Two
// readings of the same character, decided by what may legally follow it —
// `:` after a key, `,`/`}` after a member value, `,`/`]` after an element.
// Where BOTH readings are grammatical the payload carries no signal to choose
// between them; `parseUnescapedContent` documents what that costs and what
// bounds it, and it is a bound rather than a proof.
//
// It is DELIBERATELY the first strategy tried after a strict parse, ahead of
// the token rewriting below: this one reads the whole document under the JSON
// grammar and declines when anything is off, while the regex chain rewrites
// tokens in place and cannot tell a mangled result from a good one. On the
// corpus of nine distinct `Invalid tool_args JSON` payloads in `.harness-logs`
// the ordering is load-bearing, not cosmetic — a `code-mode` script arriving
// with raw newlines was being "repaired" by the chain into
// `{"script": "\"const g = read_graph({});\n…\""}`, two quote characters the
// model never wrote, wrapping the whole program in a string literal that would
// have run as a no-op expression. That is precisely the silent mis-coercion
// #217(b) is open about, and it is why every repair now reports itself.
//
// Scope is the escaping class and nothing else. Unquoted keys, single-quoted
// strings and trailing commas are DECLINED here and fall through to the
// lenient chain, which is what they were written for.

/** The escapes JSON defines. An escape outside this set means the model's
 *  escaping is broken in a way this strategy cannot infer — it declines. */
const JSON_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

/** Thrown to abandon a tolerant parse. Never escapes this module. */
class DeclineParse extends Error {}

/** What the tolerant parse had to read as content rather than as syntax. */
export interface UnescapedContentCounts {
  /** `"` characters inside a string that the structure did not need as a
   *  closing delimiter. */
  quotes: number
  /** Raw control characters (a literal newline or tab inside a string), which
   *  strict JSON rejects outright — so escaping them is the only reading. */
  controlChars: number
}

/**
 * Parse `raw` under the JSON grammar, reading a `"` inside a string as CONTENT
 * unless the structure requires it to close the string, and a raw control
 * character as itself.
 *
 * WHAT THIS GUARANTEES: the result is `null`, or a value parsed from the
 * ENTIRE input — never a prefix of one. It declines a non-object root, an
 * unquoted key, a single-quoted string, an unknown escape, a token the grammar
 * disallows, and a single character of trailing junk.
 *
 * WHAT IT DOES NOT GUARANTEE is that a wrong reading is always caught, and an
 * earlier version of this comment claimed it did. Where a content `"` is
 * followed by a delimiter the structure accepts, both readings are grammatical
 * and nothing in the payload chooses between them. Usually the greedy choice
 * runs out of grammar a token or two later and the whole document declines —
 * but not always: `{"cmd":"echo "a", "b"","p":"/x"}` (one `cmd` holding two
 * quoted words) splits at the `",` and came back COMPLETE, well-formed and
 * WRONG, reported as a clean recovery.
 *
 * The key guard in `readObject` is what closes that shape: a KEY that needed
 * content recovery is evidence the split is wrong, because a key is a short
 * identifier and a quote legitimately inside one arrives as an ESCAPE, not as
 * a bare character. It costs nothing on real payloads — all three recoveries
 * in the `.harness-logs` corpus, including the 19 KB incident, are untouched.
 *
 * So the honest bound is: this returns the intended object or declines on
 * every mis-split we have been able to CONSTRUCT, which is not the same as on
 * every one that exists. The residual risk is a tool running on rebuilt
 * arguments, and the `JsonRepairNote` on the event is the only signal that it
 * did.
 *
 * The root must be an object, because that is `tool_args`' contract.
 */
function parseUnescapedContent(
  raw: string,
): { value: Record<string, unknown>; counts: UnescapedContentCounts } | null {
  const n = raw.length
  let i = 0
  const counts: UnescapedContentCounts = { quotes: 0, controlChars: 0 }

  function skipWs(): void {
    while (i < n && (raw[i] === ' ' || raw[i] === '\t' || raw[i] === '\n' || raw[i] === '\r')) i++
  }

  /** `follow` is the set of characters the STRUCTURE allows after this string
   *  ('' = end of input). A `"` followed by anything else is content. */
  function readString(follow: string): string {
    if (raw[i] !== '"') throw new DeclineParse()
    i++
    let out = ''
    while (i < n) {
      const ch = raw[i]
      if (ch === '\\') {
        const esc = raw[i + 1]
        if (esc === 'u') {
          const hex = raw.slice(i + 2, i + 6)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new DeclineParse()
          out += String.fromCharCode(parseInt(hex, 16))
          i += 6
          continue
        }
        const mapped = esc === undefined ? undefined : JSON_ESCAPES[esc]
        if (mapped === undefined) throw new DeclineParse()
        out += mapped
        i += 2
        continue
      }
      if (ch === '"') {
        let j = i + 1
        while (j < n && (raw[j] === ' ' || raw[j] === '\t' || raw[j] === '\n' || raw[j] === '\r'))
          j++
        const next = j < n ? raw[j] : ''
        // `''.includes(x)` is true for every x, so end-of-input is compared
        // explicitly rather than through the follow set.
        if (next === '' ? follow === '' : follow.includes(next)) {
          i++
          return out
        }
        counts.quotes++
        out += '"'
        i++
        continue
      }
      if (ch < ' ') {
        counts.controlChars++
        out += ch
        i++
        continue
      }
      out += ch
      i++
    }
    throw new DeclineParse()
  }

  function readObject(): Record<string, unknown> {
    i++ // '{'
    const obj: Record<string, unknown> = {}
    skipWs()
    if (raw[i] === '}') {
      i++
      return obj
    }
    for (;;) {
      skipWs()
      // A key that needed CONTENT recovery means the split is wrong — see the
      // docblock. Counting is how we ask: `readString` only bumps these when
      // it had to read a character the grammar would have rejected.
      const recoveredBefore = counts.quotes + counts.controlChars
      const key = readString(':')
      if (counts.quotes + counts.controlChars !== recoveredBefore) throw new DeclineParse()
      skipWs()
      if (raw[i] !== ':') throw new DeclineParse()
      i++
      const value = readValue(',}')
      // `obj['__proto__'] = v` mutates the prototype instead of adding a
      // member. `JSON.parse` makes it an ordinary own property and so does
      // this — model output is a trust boundary.
      if (key === '__proto__') {
        Object.defineProperty(obj, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        })
      } else {
        obj[key] = value
      }
      skipWs()
      if (raw[i] === ',') {
        i++
        continue
      }
      if (raw[i] === '}') {
        i++
        return obj
      }
      throw new DeclineParse()
    }
  }

  function readArray(): unknown[] {
    i++ // '['
    const arr: unknown[] = []
    skipWs()
    if (raw[i] === ']') {
      i++
      return arr
    }
    for (;;) {
      arr.push(readValue(',]'))
      skipWs()
      if (raw[i] === ',') {
        i++
        continue
      }
      if (raw[i] === ']') {
        i++
        return arr
      }
      throw new DeclineParse()
    }
  }

  function readValue(follow: string): unknown {
    skipWs()
    if (i >= n) throw new DeclineParse()
    const ch = raw[i]
    if (ch === '"') return readString(follow)
    if (ch === '{') return readObject()
    if (ch === '[') return readArray()
    let j = i
    while (j < n && !' \t\n\r,}]'.includes(raw[j])) j++
    const token = raw.slice(i, j)
    i = j
    let scalar: unknown
    try {
      scalar = JSON.parse(token)
    } catch {
      throw new DeclineParse()
    }
    if (scalar !== null && typeof scalar === 'object') throw new DeclineParse()
    return scalar
  }

  try {
    skipWs()
    if (raw[i] !== '{') return null
    const value = readObject()
    skipWs()
    if (i !== n) return null
    return { value, counts }
  } catch (err) {
    if (err instanceof DeclineParse) return null
    throw err
  }
}

/**
 * How a value was obtained, when it was not obtained by `JSON.parse` alone.
 *
 * A repaired call is indistinguishable downstream from one the model emitted
 * cleanly — #217(b) tracks that as a hidden-repair-loop concern — so both
 * strategies say so, and the loop patterns carry the note onto the `tool_call`
 * event they emit.
 */
export interface JsonRepairNote {
  /** `unescaped-content`: the structure parsed under the JSON grammar and only
   *  string content had to be re-read (see `parseUnescapedContent`).
   *  `lenient-tokens`: the regex chain rewrote tokens — unquoted keys, bare
   *  values, single quotes, a trailing comma. */
  strategy: 'unescaped-content' | 'lenient-tokens'
  /** `unescaped-content` only. */
  counts?: UnescapedContentCounts
}

/** A parsed args object plus how it was obtained. */
export interface RepairedJson {
  args: Record<string, unknown>
  /** Absent when `JSON.parse` accepted the input exactly as the model wrote it. */
  repair?: JsonRepairNote
}

const LENIENT: JsonRepairNote = { strategy: 'lenient-tokens' }

/**
 * Parse a JSON string leniently, repairing common LLM mistakes, and report
 * WHICH repair (if any) produced the value.
 *
 * Callers that only want the value use `repairJson`; the loop patterns use
 * this one so the `tool_call` event can record that the args were
 * reconstructed rather than emitted cleanly (#217b).
 */
export function repairJsonTracked(raw: string): RepairedJson {
  // Fast path: already valid JSON
  try {
    return { args: JSON.parse(raw) }
  } catch {
    // continue to repair
  }

  let s = raw.trim()

  // Strategy 1 — string content that was not escaped. Ahead of the token
  // rewriting below on purpose; see the block comment on
  // `parseUnescapedContent` for why the ordering is load-bearing.
  const content = parseUnescapedContent(s)
  if (content) {
    return {
      args: content.value,
      repair: { strategy: 'unescaped-content', counts: content.counts },
    }
  }

  // Replace single quotes with double quotes (but not inside double-quoted strings)
  // Simple approach: if there are no double quotes at all, swap all single quotes
  if (!s.includes('"') && s.includes("'")) {
    s = s.replace(/'/g, '"')
    try {
      return { args: JSON.parse(s), repair: LENIENT }
    } catch {
      /* continue */
    }
  }

  // Remove trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, '$1')

  // Quote unquoted keys:  { key: or , key:  →  {"key": or ,"key":
  s = s.replace(/([{,])\s*([a-zA-Z_$][\w$]*)\s*:/g, '$1"$2":')

  // Try again — keys are now quoted, values may already be valid
  try {
    return { args: JSON.parse(s), repair: LENIENT }
  } catch {
    // continue to fix values
  }

  // Park bracketed values ({a: [X], b: 5}) before the value regex runs — it
  // skips them, and the last-resort handler below would absorb their siblings.
  const parked: string[] = []
  s = parkBracketedValues(s, parked)

  // Quote unquoted string values.
  // After a colon, if the value is not: a quoted string, a number, a bool,
  // null, an object, or an array — treat everything up to the next , } ] as
  // a bare string that needs quoting.
  // `(?!\s)` pins `\s*` to the whole run of whitespace: without it the engine
  // backtracks to zero-width, the guards below inspect a space instead of the
  // first value character, and valid values get re-quoted ({a: 5} → {a: " 5"}).
  s = s.replace(
    /:\s*(?!\s)(?!")(?!-?\d[\d.]*)(?!true\b)(?!false\b)(?!null\b)(?![[{])([^,}\]]+?)\s*([,}\]])/g,
    ': "$1"$2',
  )

  s = unparkBracketedValues(s, parked)

  try {
    return { args: JSON.parse(s), repair: LENIENT }
  } catch {
    // continue to last-resort handler
  }

  // Last-resort: single-key object whose unquoted value contains commas / parens
  // and so trips the "value up to next , } ]" regex above. Common with BAML's
  // lossy stringification of Cypher tool_args, e.g.
  //   {query: MATCH (c)-[r]-() RETURN c.name, count(r)}
  // We extract the key, then take everything between the first colon and the
  // final closing brace as a single string value. Only safe when the value has
  // no nested `{`/`}` — bail otherwise.
  const original = raw.trim()
  const singleKey = original.match(/^\{\s*"?([a-zA-Z_$][\w$]*)"?\s*:\s*([\s\S]+?)\s*\}\s*$/)
  if (singleKey) {
    const [, key, rawValue] = singleKey
    const value = rawValue.trim()
    if (!value.includes('{') && !value.includes('}')) {
      // Strip optional surrounding quotes the LLM may or may not have added.
      const unquoted = value.replace(/^['"`]([\s\S]*)['"`]$/, '$1')
      return { args: { [key]: unquoted }, repair: LENIENT }
    }
  }

  return { args: JSON.parse(s), repair: LENIENT }
}

/**
 * Parse a JSON string leniently, repairing common LLM mistakes.
 *
 * Handles:
 * - Unescaped `"` and raw newlines inside string CONTENT (the `tool_args`
 *   double-encoding class, #145) — see `parseUnescapedContent`
 * - Unquoted keys:   {query: "val"}  → {"query": "val"}
 * - Unquoted string values: {query: hello world} → {"query": "hello world"}
 * - Trailing commas:  {a: 1,}  → {a: 1}
 * - Single-quoted strings: {'key': 'val'} → {"key": "val"}
 * - Bracketed values with unquoted contents: {author: [X], limit: 5}
 *   → {"author": ["X"], "limit": 5}
 *
 * @returns Parsed object — throws if still invalid after repair.
 */
export function repairJson(raw: string): Record<string, unknown> {
  return repairJsonTracked(raw).args
}
