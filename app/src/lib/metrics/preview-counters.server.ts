/**
 * Global usage counters (Postgres) — Server Only.
 *
 * The smallest aggregate that answers "how much has this preview used today,
 * across everyone?" and survives a restart.
 *
 * ## Why a table at all
 *
 * Nothing in the app persisted a cross-user total before this. `metrics/
 * dashboard.server.ts` folds the caller's own conversation blobs
 * (`aggregate.ts`) — accurate, per-user, and megabytes of JSONB per account.
 * Answering a header that polls by folding *every* user's blobs would be a
 * full-table JSONB scan every few seconds, which is the "heavy query" this
 * surface was explicitly told not to run. So the numbers are counted once, at
 * the moment they are spent, into a handful of integer columns.
 *
 * ## Shape
 *
 * One row per (UTC day, tier). Two rows a day at most, ~700 rows a year — small
 * enough that nothing here needs pruning, and split by tier because "what share
 * of the preview actually ran on our own box?" is the question this preview
 * exists to answer.
 *
 * `day` is a UTC date, deliberately: "today" in a per-viewer local timezone
 * would make one user's total disagree with another's on the same screen. The
 * UI labels it as UTC rather than pretending otherwise.
 *
 * ## What it is NOT
 *
 * Not billing, not an audit trail, and not a backfill of history that predates
 * it — a counter starts at the deploy that created it, and the UI must not
 * imply otherwise. It is also written on a best-effort basis: a counter write
 * that fails is logged and dropped rather than failing anyone's turn (see
 * `usage-recorder.server.ts`), so treat these as "at most what was spent".
 */
import { assertServerOnImport } from '../harness-patterns/assert.server'
import { query } from '../db/client.server'
import type { InferenceTier } from '../harness-patterns/clients.server'

assertServerOnImport()

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS usage_counters (
    day            DATE NOT NULL,
    tier           TEXT NOT NULL,
    llm_calls      BIGINT NOT NULL DEFAULT 0,
    input_tokens   BIGINT NOT NULL DEFAULT 0,
    output_tokens  BIGINT NOT NULL DEFAULT 0,
    turns          BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (day, tier)
  );
`

let _schemaReady: Promise<void> | null = null
function ensureSchema(): Promise<void> {
  if (!_schemaReady) {
    _schemaReady = query(SCHEMA_SQL)
      .then(() => undefined)
      .catch((err) => {
        _schemaReady = null // allow retry on next call
        throw err
      })
  }
  return _schemaReady
}

/** One call's contribution. All four buckets of `EventMetrics` are folded into
 *  two, because the header shows one token number and a split that no one reads
 *  is a wider table for nothing — the per-bucket detail still lives on the
 *  events, which is where the dashboard reads it from. */
export interface UsageDelta {
  tier: InferenceTier
  llmCalls: number
  inputTokens: number
  outputTokens: number
  turns: number
}

/** UTC calendar day as `YYYY-MM-DD`. Pure, so the day-boundary behaviour is
 *  testable without waiting for midnight. */
export function utcDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

/**
 * Add one delta to today's row for its tier. Upsert, so the first write of a
 * day creates the row — there is no daily job to forget to run.
 *
 * A zero-everything delta is dropped before it reaches the database: the
 * observer fires for calls that spent no tokens, and inserting a row to add
 * nothing is a write per stray call for no information.
 */
export async function addUsage(delta: UsageDelta, now: number = Date.now()): Promise<void> {
  if (
    delta.llmCalls === 0 &&
    delta.inputTokens === 0 &&
    delta.outputTokens === 0 &&
    delta.turns === 0
  ) {
    return
  }
  await ensureSchema()
  await query(
    `INSERT INTO usage_counters (day, tier, llm_calls, input_tokens, output_tokens, turns)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (day, tier) DO UPDATE SET
       llm_calls     = usage_counters.llm_calls     + EXCLUDED.llm_calls,
       input_tokens  = usage_counters.input_tokens  + EXCLUDED.input_tokens,
       output_tokens = usage_counters.output_tokens + EXCLUDED.output_tokens,
       turns         = usage_counters.turns         + EXCLUDED.turns`,
    [utcDay(now), delta.tier, delta.llmCalls, delta.inputTokens, delta.outputTokens, delta.turns],
  )
}

/** Today's totals, and the Verda share of them. */
export interface UsageToday {
  /** input + output tokens across every tier. */
  totalTokens: number
  llmCalls: number
  /** User turns started today — the closest honest thing to "messages". */
  turns: number
  /** Share of today's LLM calls that ran on the self-hosted box, 0–1. `null`
   *  when there were no calls at all: 0% would read as "we used none of it"
   *  rather than "nothing has happened yet". */
  verdaCallShare: number | null
}

/** A row as the counter table stores it — `BIGINT` arrives from `pg` as a
 *  string, so every column is parsed rather than trusted to be a number. */
interface CounterRow {
  tier: string
  llm_calls: string | number
  input_tokens: string | number
  output_tokens: string | number
  turns: string | number
}

const num = (v: string | number | null | undefined): number => Number(v ?? 0) || 0

/** Fold the day's rows into the shape the header renders. Pure — the query and
 *  the arithmetic are separated so the arithmetic is testable without a
 *  database, which is the half that has ever been wrong. */
export function foldUsageRows(rows: CounterRow[]): UsageToday {
  let totalTokens = 0
  let llmCalls = 0
  let turns = 0
  let verdaCalls = 0
  for (const row of rows) {
    totalTokens += num(row.input_tokens) + num(row.output_tokens)
    llmCalls += num(row.llm_calls)
    turns += num(row.turns)
    if (row.tier === 'verda') verdaCalls += num(row.llm_calls)
  }
  return {
    totalTokens,
    llmCalls,
    turns,
    verdaCallShare: llmCalls > 0 ? verdaCalls / llmCalls : null,
  }
}

/** Today's counters. At most two rows read by primary key prefix. */
export async function getUsageToday(now: number = Date.now()): Promise<UsageToday> {
  await ensureSchema()
  const { rows } = await query<CounterRow>(
    `SELECT tier, llm_calls, input_tokens, output_tokens, turns
       FROM usage_counters WHERE day = $1`,
    [utcDay(now)],
  )
  return foldUsageRows(rows)
}

/** How recently a conversation must have been touched to count its owner as
 *  active. 15 minutes — long enough to cover a user reading an answer, short
 *  enough that the number means "right now". */
export const ACTIVE_WINDOW_MINUTES = 15

/**
 * Distinct users whose conversations were touched in the last
 * {@link ACTIVE_WINDOW_MINUTES} minutes.
 *
 * `conversations.updated_at` is bumped by every `saveSession`, so it is the
 * app's existing record of "this user did something", with no new write path
 * and no new table. It is a *chat* activity signal specifically: a signed-in
 * user staring at the dashboard is not counted, which is the honest reading of
 * "active" for this app and is how the label is worded.
 *
 * The interval is inlined rather than parameterised because it is a constant,
 * and `make_interval` with a bound parameter is the alternative — this keeps
 * the SQL readable; the value never comes from a caller, let alone a client.
 *
 * **This is only cheap because of `conversations_updated_idx`** (`db/
 * client.server.ts`), which leads on `updated_at`. The two composite indexes
 * on that table lead on `user_id`, so without the recency-only one this
 * degrades to a full index-only scan — O(every conversation ever) rather than
 * O(the 15-minute window) — on a query that runs per poll, per tab, per user,
 * on every route. Do not drop it while this surface polls.
 */
export async function countActiveUsers(): Promise<number> {
  const { rows } = await query<{ active: string | number }>(
    `SELECT COUNT(DISTINCT user_id) AS active
       FROM conversations
      WHERE updated_at > NOW() - INTERVAL '${ACTIVE_WINDOW_MINUTES} minutes'`,
  )
  return num(rows[0]?.active)
}
