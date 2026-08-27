/**
 * Per-user preferences (Postgres) — Server Only.
 *
 * One row per user, holding the settings that must survive the browser because
 * the thing they configure runs on the SERVER. Today that is exactly one: the
 * inference tier a user's NEXT NEW conversation starts on. `localStorage` cannot
 * hold it — the turn executes server-side, in an SSE POST and in triggered runs
 * that have no browser at all, so a client-only preference would be invisible to
 * the code it is supposed to steer.
 *
 * **It is a seed, not a setting, since the switch became per-conversation.**
 * Every flip writes it, so a new chat starts where the last one left off; a
 * conversation that has ever run carries its own tier on its row and stops
 * consulting this. The two places that still read it are the resolver
 * (`lib/inference/tier.server.ts`, step 2 of its order) and the preview header's
 * latency figure, which has to name some tier and names the one a new chat
 * takes. Triggered runs and routines have no switch, so they resolve through
 * here exactly as they always did.
 *
 * Schema bootstraps idempotently on first use (mirrors `users.server.ts` and
 * `session-store.server.ts`), so no shared migration file is touched.
 *
 * Deliberately NOT a `'use server'` module: every export of one is an RPC the
 * browser can call, and both functions below take a `userId`, which would let
 * the caller choose whose preference to read or write. The `'use server'`
 * surface is `harness-client/actions.server.ts` (the switch) and
 * `preview-header.server.ts` (the strip), both of which resolve the owner from
 * the session and pass it in — the same contract `turn.server.ts` and
 * `action-runner.server.ts` carry.
 */
import { assertServerOnImport } from '../harness-patterns/assert.server'
import { query } from './client.server'
import { type InferenceTier, verdaConfigured } from '../harness-patterns/clients.server'

assertServerOnImport()

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS user_prefs (
    user_id        TEXT PRIMARY KEY,
    inference_tier TEXT,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

/** The two legal values, as a runtime guard. The column is TEXT rather than an
 *  enum so adding a tier is not a migration; the cost of that is that a row
 *  written by an older/newer build can hold something this build does not
 *  understand, which is what this narrows. */
export function isInferenceTier(value: unknown): value is InferenceTier {
  return value === 'verda' || value === 'anthropic'
}

/**
 * The tier a user with no stored preference gets.
 *
 * **Verda when the self-hosted endpoint is configured** — the owner's preview
 * decision (2026-08-25): every preview user starts on the company's own
 * deployment and opts *out* to Anthropic, not the other way round.
 *
 * **Anthropic when it is not.** That is not a second policy, it is the same
 * one under a fail-closed constraint: `runWithInferenceTier('verda')` throws
 * when the endpoint is unset (see `clients.server.ts`), so defaulting an
 * unconfigured deployment — a dev box, CI — to Verda would make every turn
 * throw rather than fall through to Anthropic. The fall-through is refused by
 * design; refusing to *default* there is the only remaining option.
 *
 * Note for the owner: `USE_VERDA_INFERENCE` keeps its base-branch meaning as
 * the deployment default for runs OUTSIDE a user scope, but it no longer gates
 * the per-user default. A deployment that has the endpoint configured and
 * nevertheless wants its users to start on Anthropic has no lever today — that
 * would be one more env var, and inventing it unasked seemed worse than
 * naming the gap here.
 */
export function defaultInferenceTier(): InferenceTier {
  return verdaConfigured() ? 'verda' : 'anthropic'
}

/**
 * The user's stored tier, or `null` when they have never chosen one. A value
 * this build does not recognise is treated as "never chosen" rather than
 * passed through — an unknown tier reaching `runWithInferenceTier` would be a
 * silent no-op that reads like a choice.
 */
export async function getStoredInferenceTier(userId: string): Promise<InferenceTier | null> {
  await ensureSchema()
  const { rows } = await query<{ inference_tier: string | null }>(
    `SELECT inference_tier FROM user_prefs WHERE user_id = $1`,
    [userId],
  )
  const stored = rows[0]?.inference_tier
  return isInferenceTier(stored) ? stored : null
}

// The user-level resolver that used to live here is gone: since the switch
// became per-conversation the order has a step in front of it (the row's own
// column), and the whole order lives in `lib/inference/tier.server.ts`, which
// is the module both the turn runner and the switch call. Two resolvers, one of
// them a prefix of the other, is how a control ends up showing a tier the run
// does not take.

/** Store a user's choice. Upsert: one row per user, `updated_at` bumped. */
export async function setStoredInferenceTier(userId: string, tier: InferenceTier): Promise<void> {
  await ensureSchema()
  await query(
    `INSERT INTO user_prefs (user_id, inference_tier)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET
       inference_tier = EXCLUDED.inference_tier,
       updated_at     = NOW()`,
    [userId, tier],
  )
}
