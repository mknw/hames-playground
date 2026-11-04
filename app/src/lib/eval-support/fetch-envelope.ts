/**
 * The text envelope the production `fetch` tool (the gateway's fetch server) wraps a
 * page in, applied to the general-next Eval's canned pages so a live model reads the
 * same completeness signal it would read in production: a `Contents of <url>:` header,
 * a truncation marker naming the next `start_index` ONLY when the slice was cut, and
 * "No more content available" past the end. The live run shows the model that tool's
 * real description (`max_length` default 5000, `start_index` "if a previous fetch was
 * truncated"); a bare one-line page with no envelope, identical for every argument,
 * reads as truncated and was re-fetched until the loop ran out of turns (03, live
 * 2026-11-04). Arguments are validated as the server validates them ({@link
 * parseFetchArgs}). `raw` is validated but not modelled: the canned page has no HTML to
 * return.
 */
export const FETCH_DEFAULT_MAX_LENGTH = 5000
/** The server's own bounds (its argument schema): `0 < max_length < 1000000`,
 *  `start_index >= 0`, both integers. */
export const FETCH_MAX_LENGTH_LIMIT = 1_000_000

/**
 * The gateway's pinned fetch server (`configs/custom-catalog.yaml`) validates its
 * arguments with a pydantic 2.10 model in LAX mode, before it fetches: what that model
 * coerces is served, what it rejects is refused with an error — never served at a
 * default. Every rule below was read off that image's `Fetch` model offline (#989
 * review): an integer accepts a bool, a finite whole float, or a string that, stripped,
 * is ASCII digits with an optional sign, single `_` separators and a `.0…` tail; a
 * boolean accepts 0/1 or one of the lax words, case-insensitive and unstripped; the url
 * must parse as an absolute URL. Extra keys are ignored, as the model ignores them.
 */
type Parsed<T> = { value: T } | { error: string }

const INT_STRING = /^[+-]?\d+(?:_\d+)*(?:\.0+)?$/
const TRUE_WORDS = new Set(['1', 'on', 't', 'true', 'y', 'yes'])
const FALSE_WORDS = new Set(['0', 'off', 'f', 'false', 'n', 'no'])

function laxInt(v: unknown): Parsed<number> {
  if (typeof v === 'boolean') return { value: v ? 1 : 0 }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { error: 'Input should be a finite number [type=finite_number' }
    return Number.isInteger(v)
      ? { value: v }
      : {
          error:
            'Input should be a valid integer, got a number with a fractional part [type=int_from_float',
        }
  }
  if (typeof v === 'string') {
    const t = v.trim()
    return INT_STRING.test(t)
      ? { value: Number(t.replace(/_/g, '').replace(/\.0+$/, '')) }
      : {
          error:
            'Input should be a valid integer, unable to parse string as an integer [type=int_parsing',
        }
  }
  return { error: 'Input should be a valid integer [type=int_type' }
}

function laxBool(v: unknown): Parsed<boolean> {
  if (typeof v === 'boolean') return { value: v }
  if (v === 0 || v === 1) return { value: v === 1 }
  if (typeof v === 'string') {
    const t = v.toLowerCase()
    if (TRUE_WORDS.has(t)) return { value: true }
    if (FALSE_WORDS.has(t)) return { value: false }
  }
  if (typeof v === 'number' || typeof v === 'string')
    return {
      error: 'Input should be a valid boolean, unable to interpret input [type=bool_parsing',
    }
  return { error: 'Input should be a valid boolean [type=bool_type' }
}

function anyUrl(v: unknown): Parsed<string> {
  if (v === undefined) return { error: 'Field required [type=missing' }
  if (typeof v !== 'string') return { error: 'URL input should be a string or URL [type=url_type' }
  try {
    return { value: new URL(v).href }
  } catch {
    return { error: 'Input should be a valid URL [type=url_parsing' }
  }
}

export interface FetchArgs {
  readonly url: string
  readonly maxLength: number
  readonly startIndex: number
  readonly raw: boolean
}

/** The server's validation: the coerced arguments, or its refusal text. */
export function parseFetchArgs(
  args: Record<string, unknown>,
): { ok: true; args: FetchArgs } | { ok: false; error: string } {
  const errors: string[] = []
  const field = <T>(name: string, parsed: Parsed<T>, check?: (v: T) => string | undefined) => {
    const why = 'error' in parsed ? parsed.error : check?.(parsed.value)
    if (why) errors.push(`${name}\n  ${why}, input_value=${JSON.stringify(args[name])}]`)
    return 'value' in parsed ? parsed.value : undefined
  }
  const url = field('url', anyUrl(args.url))
  const maxLength = field(
    'max_length',
    args.max_length === undefined ? { value: FETCH_DEFAULT_MAX_LENGTH } : laxInt(args.max_length),
    (v) =>
      v <= 0
        ? 'Input should be greater than 0 [type=greater_than'
        : v >= FETCH_MAX_LENGTH_LIMIT
          ? `Input should be less than ${FETCH_MAX_LENGTH_LIMIT} [type=less_than`
          : undefined,
  )
  const startIndex = field(
    'start_index',
    args.start_index === undefined ? { value: 0 } : laxInt(args.start_index),
    (v) =>
      v < 0 ? 'Input should be greater than or equal to 0 [type=greater_than_equal' : undefined,
  )
  const raw = field('raw', args.raw === undefined ? { value: false } : laxBool(args.raw))
  if (errors.length)
    return {
      ok: false,
      error: `${errors.length} validation error${errors.length > 1 ? 's' : ''} for Fetch\n${errors.join('\n')}`,
    }
  return {
    ok: true,
    args: { url: url!, maxLength: maxLength!, startIndex: startIndex!, raw: raw! },
  }
}

/**
 * The refusal the real server returns for arguments its model rejects, or undefined when
 * it accepts them (after coercion). A fake that defaulted a rejected argument would serve
 * a page production refuses; one that refused a coerced argument would fail a call
 * production serves (#989 review, both directions).
 */
export function fetchRefusal(args: Record<string, unknown>): string | undefined {
  const parsed = parseFetchArgs(args)
  return parsed.ok ? undefined : parsed.error
}

/** The page as the server returns it, for arguments {@link fetchRefusal} accepts: the
 *  header carries the url as the server serializes it, the slice uses the coerced numbers. */
export function fetchEnvelope(page: string, args: Record<string, unknown>): string {
  const parsed = parseFetchArgs(args)
  if (!parsed.ok) throw new Error(parsed.error)
  const { url, maxLength: max, startIndex: start } = parsed.args
  if (start >= page.length) return `Contents of ${url}:\n<error>No more content available.</error>`
  const slice = page.slice(start, start + max)
  const next = start + slice.length
  const cut =
    slice.length === max && page.length > next
      ? `\n\n<error>Content truncated. Call the fetch tool with a start_index of ${next} to get more content.</error>`
      : ''
  return `Contents of ${url}:\n${slice}${cut}`
}
