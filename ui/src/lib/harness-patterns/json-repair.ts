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
 *
 * @returns Parsed object — throws if still invalid after repair.
 */
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

  // Quote unquoted string values.
  // After a colon, if the value is not: a quoted string, a number, a bool,
  // null, an object, or an array — treat everything up to the next , } ] as
  // a bare string that needs quoting.
  s = s.replace(
    /:\s*(?!")(?!-?\d[\d.]*)(?!true\b)(?!false\b)(?!null\b)(?![[{])([^,}\]]+?)\s*([,}\]])/g,
    ': "$1"$2',
  )

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
