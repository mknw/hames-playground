/**
 * The turn's CLOCK — when a turn started and which time zone it is read in.
 *
 * A model has no notion of "now". Without this, "today", "this afternoon",
 * "recent" or "next Tuesday" resolve against whatever date the model's training
 * suggests, and a tool that means "today" resolves against the server's zone.
 * The fix is one value per turn, captured once at the turn's start and carried
 * on the run frame (`RunFrame.clock`), so every model call and every tool in
 * the turn reads the SAME instant in the SAME zone — a turn that crosses
 * midnight does not have a planner on one date and a calendar read on the next.
 *
 * Client-safe on purpose: it is pure `Intl` arithmetic, no I/O, so the host
 * validates a browser-sent zone with the same function the server formats with.
 */
import type { UnifiedContext } from './types'

/** One turn's clock. Built by the host at turn start; read, never written, below it. */
export interface TurnClock {
  /** The turn's start instant, epoch milliseconds. */
  readonly instant: number
  /** The IANA zone the user's "now" is read in. */
  readonly timeZone: string
  /** True when no zone was known for the user and `timeZone` is the UTC
   *  fallback. The time block then says so, so the answer can too. */
  readonly zoneUnknown?: boolean
}

/** The host's resume clock. Older blobs have no recorded zone: keep their
 * latest user-message instant (session creation if absent) and explicitly
 * assume UTC, rather than inventing a historical zone from today's preference. */
export function pausedTurnClock(
  ctx: Pick<UnifiedContext, 'turnClock' | 'events' | 'createdAt'>,
): TurnClock {
  return (
    ctx.turnClock ?? {
      instant: ctx.events.findLast((event) => event.type === 'user_message')?.ts ?? ctx.createdAt,
      timeZone: 'UTC',
      zoneUnknown: true,
    }
  )
}

// `Area/Location` (one or two slashes) or the bare `UTC`. Shape first, because
// `Intl` itself accepts more than a zone name: offsets (`+01:00`) and legacy
// abbreviations (`EST` → America/Panama) both construct a formatter.
const ZONE_SHAPE = /^(?:UTC|[A-Za-z][A-Za-z0-9_-]*(?:\/[A-Za-z0-9_+-]+){1,2})$/
const MAX_ZONE_LENGTH = 64

let zones: ReadonlySet<string> | undefined
function ianaZones(): ReadonlySet<string> {
  zones ??= new Set(Intl.supportedValuesOf('timeZone'))
  return zones
}

/**
 * `value` as a usable IANA zone name, or `null` when it is not one.
 *
 * Validated against the runtime's IANA set (`Intl.supportedValuesOf`), after
 * the runtime's own canonicalization — so a current alias the browser reports
 * (`Asia/Kolkata`, `Europe/Kyiv`) is accepted although this ICU lists the older
 * canonical name. Anything else is refused: a non-string, an over-long value,
 * an offset, an abbreviation, a path, an unknown zone.
 */
export function validTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_ZONE_LENGTH || !ZONE_SHAPE.test(value)) {
    return null
  }
  let resolved: string
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone
  } catch {
    return null
  }
  if (resolved !== 'UTC' && !ianaZones().has(resolved)) return null
  // Keep the name the caller used (an alias is still a valid IANA name), but
  // not its casing: `europe/brussels` resolves, and is returned as written by ICU.
  return value.toLowerCase() === resolved.toLowerCase() ? resolved : value
}

interface LocalParts {
  weekday: string
  date: string
  time: string
  offset: string
}

function localParts(instant: number, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(instant))
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? ''
  // `longOffset` renders `GMT+01:00`, and bare `GMT` at a zero offset.
  const gmt = get('timeZoneName').replace(/^GMT/, '')
  return {
    weekday: get('weekday'),
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}:${get('second')}`,
    offset: gmt || '+00:00',
  }
}

/** The clock's local calendar date, `YYYY-MM-DD`, in its own zone. */
export function localDate(clock: TurnClock): string {
  return localParts(clock.instant, clock.timeZone).date
}

const timeBlocks = new WeakMap<TurnClock, string>()

/**
 * The block every time-reasoning prompt carries: weekday, ISO date, local time,
 * UTC offset and zone name, plus the one instruction that makes it useful.
 * Memoized per clock for decisions and BAML calls alike. The host holds one
 * clock per turn, so every call sees the same rendering even across midnight.
 */
export function formatTimeBlock(clock: TurnClock): string {
  const cached = timeBlocks.get(clock)
  if (cached !== undefined) return cached
  const p = localParts(clock.instant, clock.timeZone)
  const header = clock.zoneUnknown
    ? "CURRENT TIME (when this turn started; the user's time zone is unknown, so this is UTC):"
    : "CURRENT TIME (when this turn started, in the user's time zone):"
  const rule =
    "Use this time to resolve relative dates in the current request only, unless the user gives an explicit reference date; use that reference date instead. Preserve the temporal context of dated quotations: relative dates inside them refer to the quotation's date. This is not the date of documents or events."
  const block = [
    header,
    `${p.weekday}, ${p.date}T${p.time}${p.offset} (${clock.timeZone})`,
    rule,
    ...(clock.zoneUnknown
      ? ['When an answer depends on the local time, say that you assumed UTC.']
      : []),
  ].join('\n')
  timeBlocks.set(clock, block)
  return block
}
