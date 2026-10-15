/**
 * Text that came from a model, shown to a person.
 *
 * A proposed memory is model-derived from the user's own message and is
 * untrusted (#433 P3): it is rendered as a TEXT node, never as markup, so there
 * is no HTML to inject — and what is stripped here is what a text node cannot
 * defend against, characters that make one string read as another. Bidi
 * overrides and isolates reorder what follows them (a memory ending in U+202E
 * displays reversed), zero-width and other format characters hide, and control
 * characters and line separators break the layout. Format characters (`Cf`)
 * are removed; controls, `Zl` and `Zp` become one space; runs of whitespace
 * collapse. Pure, client-safe.
 */
export function displayText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
