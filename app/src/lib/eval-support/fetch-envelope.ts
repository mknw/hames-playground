/**
 * The text envelope the production `fetch` tool (the gateway's fetch server) wraps a
 * page in, applied to the general-next Eval's canned pages so a live model reads the
 * same completeness signal it would read in production: a `Contents of <url>:` header,
 * a truncation marker naming the next `start_index` ONLY when the slice was cut, and
 * "No more content available" past the end. The live run shows the model that tool's
 * real description (`max_length` default 5000, `start_index` "if a previous fetch was
 * truncated"); a bare one-line page with no envelope, identical for every argument,
 * reads as truncated and was re-fetched until the loop ran out of turns (03, live
 * 2026-11-04). `raw` is not modelled: the canned page has no HTML to return.
 */
export const FETCH_DEFAULT_MAX_LENGTH = 5000

const whole = (value: unknown, fallback: number, min: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min ? value : fallback

export function fetchEnvelope(url: string, page: string, args: Record<string, unknown>): string {
  const start = whole(args.start_index, 0, 0)
  const max = whole(args.max_length, FETCH_DEFAULT_MAX_LENGTH, 1)
  if (start >= page.length) return `Contents of ${url}:\n<error>No more content available.</error>`
  const slice = page.slice(start, start + max)
  const next = start + slice.length
  const cut =
    slice.length === max && page.length > next
      ? `\n\n<error>Content truncated. Call the fetch tool with a start_index of ${next} to get more content.</error>`
      : ''
  return `Contents of ${url}:\n${slice}${cut}`
}
