/**
 * LLM request-body parsing for the prompt drill-down — the provider-shape
 * normalisation behind the "Rendered messages" view. Pure; split out of
 * `ObservabilityPanel.tsx` (#226 B5).
 */

export interface ParsedMessage {
  role: string
  content: string
}

/**
 * Flatten one message's `content` into readable text.
 *
 * OpenAI-shaped bodies put a plain string here. Anthropic puts an array of
 * typed blocks — `{type:'text',text}`, `{type:'tool_use',…}`,
 * `{type:'tool_result',…}` — and dumping that array through `JSON.stringify`
 * is what made the prompt viewer useless on the default client chain (SA-H11):
 * the prompt read as one wall of escaped JSON. Text blocks are concatenated;
 * anything non-text keeps its JSON, labelled with its block type so it is still
 * findable.
 */
export function flattenContent(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2)
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (!block || typeof block !== 'object') return JSON.stringify(block)
      const b = block as { type?: string; text?: unknown }
      if (b.type === 'text' && typeof b.text === 'string') return b.text
      return `[${b.type ?? 'block'}]\n${JSON.stringify(block, null, 2)}`
    })
    .join('\n\n')
}

/** A `system` value that is a string, or Anthropic's array of text blocks. */
export function hasSystemContent(system: unknown): boolean {
  if (typeof system === 'string') return system.trim().length > 0
  return Array.isArray(system) && system.length > 0
}

/**
 * Parse an LLM HTTP request body into structured messages + metadata.
 *
 * Handles both provider shapes this app actually sends. OpenAI-compatible
 * bodies carry the system prompt as `messages[0]` and string content;
 * Anthropic's carries it as a **top-level `system` field** with content as
 * block arrays. On the Anthropic shape the old parser swept `system` into the
 * params bar (rendered as one unwrapped line of JSON) and escaped every message
 * body — and since Anthropic-only is this repo's dev default, that blinded the
 * primary debug surface exactly where it is needed most.
 *
 * The system prompt is lifted into a synthetic leading `system` message so both
 * shapes render identically.
 */
export function parsePromptBody(
  rawInput: string,
): { messages: ParsedMessage[]; model?: string; params: Record<string, unknown> } | null {
  try {
    const body = JSON.parse(rawInput)
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return null

    const messages: ParsedMessage[] = body.messages.map(
      (m: { role?: string; content?: unknown }) => ({
        role: String(m.role ?? 'unknown'),
        content: flattenContent(m.content),
      }),
    )

    // Anthropic's top-level system prompt becomes the first message.
    if (hasSystemContent(body.system)) {
      messages.unshift({ role: 'system', content: flattenContent(body.system) })
    }

    // Extract non-message params. `system` is dropped from `rest` whether or
    // not it was liftable, so a malformed one can't reappear in the params bar.
    const { messages: _messages, model, system: _system, ...rest } = body
    return { messages, model, params: rest }
  } catch {
    return null
  }
}

/** Longest param value rendered inline before it is truncated. */
const PARAM_VALUE_MAX = 160

/** Render a param value as a single wrappable, bounded string. */
export function formatParamValue(value: unknown): string {
  const text = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
  return text.length > PARAM_VALUE_MAX ? `${text.slice(0, PARAM_VALUE_MAX)}…` : text
}
