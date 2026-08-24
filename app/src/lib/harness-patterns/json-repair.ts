/**
 * Lenient JSON repair for LLM output.
 *
 * Smaller/faster LLMs (Groq Llama, etc.) frequently output relaxed
 * JSON-like syntax with unquoted keys or string values.
 * This utility attempts a strict parse first, then applies lightweight
 * regex repairs before retrying.
 */

/**
 * Parse a JSON string leniently, repairing common LLM mistakes.
 *
 * Handles:
 * - Unquoted keys:   {query: "val"}  → {"query": "val"}
 * - Unquoted string values: {query: hello world} → {"query": "hello world"}
 * - Trailing commas:  {a: 1,}  → {a: 1}
 * - Single-quoted strings: {'key': 'val'} → {"key": "val"}
 * - Bracketed values with unquoted contents: {author: [X], limit: 5}
 *   → {"author": ["X"], "limit": 5}
 *
 * @returns Parsed object — throws if still invalid after repair.
 */
/**
 * Index just past the bracket matching the one at `start`, or -1 when the
 * literal is unbalanced. Double-quoted strings (with backslash escapes) are
 * skipped, so `["a]b"]` closes at the right place. Single quotes are NOT
 * treated as delimiters — apostrophes in bare text are far more common in LLM
 * output than a bracket inside a single-quoted string.
 *
 * Exported for `controller-action.ts`, which needs the same "where does this
 * literal end" answer to find the extent of a `tool_args:` value embedded in a
 * brace-less action envelope. One scanner, one set of escape rules.
 */
export function scanLiteral(s: string, start: number): number {
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

export function repairJson(raw: string): Record<string, unknown> {
  // Fast path: already valid JSON
  try {
    return JSON.parse(raw)
  } catch {
    // continue to repair
  }

  let s = raw.trim()

  // Replace single quotes with double quotes (but not inside double-quoted strings)
  // Simple approach: if there are no double quotes at all, swap all single quotes
  if (!s.includes('"') && s.includes("'")) {
    s = s.replace(/'/g, '"')
    try {
      return JSON.parse(s)
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
    return JSON.parse(s)
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
    return JSON.parse(s)
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
      return { [key]: unquoted }
    }
  }

  return JSON.parse(s)
}
