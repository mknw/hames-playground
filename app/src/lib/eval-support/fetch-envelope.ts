/**
 * The text envelope the production `fetch` tool (the gateway's fetch server) wraps a
 * page in, applied to the general-next Eval's canned pages so a live model reads the
 * same completeness signal it would read in production: a `Contents of <url>:` header,
 * a truncation marker naming the next `start_index` ONLY when the slice was cut, and
 * "No more content available" past the end. The live run shows the model that tool's
 * real description (`max_length` default 5000, `start_index` "if a previous fetch was
 * truncated"); a bare one-line page with no envelope, identical for every argument,
 * reads as truncated and was re-fetched until the loop ran out of turns (03, live
 * 2026-11-04). An argument the server's schema rejects is refused, as the server
 * refuses it ({@link fetchRefusal}). `raw` is not modelled: the canned page has no HTML
 * to return.
 */
export const FETCH_DEFAULT_MAX_LENGTH = 5000
/** The server's own bounds (its argument schema): `0 < max_length < 1000000`,
 *  `start_index >= 0`, both integers. */
export const FETCH_MAX_LENGTH_LIMIT = 1_000_000

/**
 * The refusal the real server returns for an argument its schema rejects, or undefined
 * when the arguments are valid. The server validates before it fetches and answers an
 * invalid call with an error, never with the page at a default — a fake that quietly
 * substituted the default would hand a model the page for exactly the over-cap
 * `max_length` it reached for in 03's live loop (#989 review).
 */
export function fetchRefusal(args: Record<string, unknown>): string | undefined {
  const bad: string[] = []
  const { max_length: max, start_index: start } = args
  if (
    max !== undefined &&
    !(Number.isInteger(max) && (max as number) > 0 && (max as number) < FETCH_MAX_LENGTH_LIMIT)
  )
    bad.push(
      `max_length\n  Input should be an integer greater than 0 and less than ${FETCH_MAX_LENGTH_LIMIT} [input_value=${JSON.stringify(max)}]`,
    )
  if (start !== undefined && !(Number.isInteger(start) && (start as number) >= 0))
    bad.push(
      `start_index\n  Input should be an integer greater than or equal to 0 [input_value=${JSON.stringify(start)}]`,
    )
  return bad.length
    ? `${bad.length} validation error${bad.length > 1 ? 's' : ''} for Fetch\n${bad.join('\n')}`
    : undefined
}

/** The page as the server returns it for VALID arguments (see {@link fetchRefusal}). */
export function fetchEnvelope(url: string, page: string, args: Record<string, unknown>): string {
  const start = (args.start_index as number | undefined) ?? 0
  const max = (args.max_length as number | undefined) ?? FETCH_DEFAULT_MAX_LENGTH
  if (start >= page.length) return `Contents of ${url}:\n<error>No more content available.</error>`
  const slice = page.slice(start, start + max)
  const next = start + slice.length
  const cut =
    slice.length === max && page.length > next
      ? `\n\n<error>Content truncated. Call the fetch tool with a start_index of ${next} to get more content.</error>`
      : ''
  return `Contents of ${url}:\n${slice}${cut}`
}
