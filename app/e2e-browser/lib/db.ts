/**
 * The one piece of real infrastructure, reached directly.
 *
 * Postgres is not faked here for the same reason `app/e2e/` does not fake it:
 * "the conversation survived a reload" is a claim about persistence, and a
 * suite that faked the store would be asserting against its own fake. The
 * target is the throwaway `kgagent_test_browser` this suite provisions for itself
 * (#280), never a
 * developer's dev database — `initSchema()`'s backfill would otherwise rewrite
 * real rows under the unit-test key, after which `pnpm dev` refuses to boot.
 *
 * Reached with `pg` rather than through the app's own repository modules
 * because those are `.server.ts` and would drag the app's module graph — and
 * `assertServerOnImport` — into the Playwright worker. What this file does is
 * DELETE rows the suite owns; it never reads an encrypted column, so it needs
 * none of the repositories' decryption.
 */
import pg from 'pg'
import { BYPASS_USER_ID, TEST_DATABASE_URL } from './env'

/** `undefined_table` — the app has not booted far enough to create it yet,
 *  which on a first run is the normal state rather than a failure. */
const UNDEFINED_TABLE = '42P01'

/**
 * Delete everything the dev-bypass user owns.
 *
 * Called before each scenario file rather than after, so a failed run leaves
 * its rows behind to be looked at. Test database only — the `TEST_DATABASE_URL`
 * default and the dev server's `DATABASE_URL` both point at this suite's own
 * `kgagent_test_browser`.
 */
export async function wipeUserRows(): Promise<void> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    for (const table of ['conversations', 'user_prefs']) {
      try {
        await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [BYPASS_USER_ID])
      } catch (err) {
        if ((err as { code?: string }).code !== UNDEFINED_TABLE) throw err
      }
    }
  } finally {
    await client.end().catch(() => {})
  }
}

/** How many conversation rows the suite's user owns, and their status —
 *  what a scenario checks when its claim is about persistence rather than
 *  about pixels. Titles are encrypted at rest and deliberately not read here. */
export async function conversationRows(): Promise<Array<{ id: string; status: string }>> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    const result = await client.query<{ id: string; status: string }>(
      'SELECT id, status FROM conversations WHERE user_id = $1 ORDER BY created_at',
      [BYPASS_USER_ID],
    )
    return result.rows
  } catch (err) {
    if ((err as { code?: string }).code === UNDEFINED_TABLE) return []
    throw err
  } finally {
    await client.end().catch(() => {})
  }
}

/**
 * The tier the server will actually read for this suite's user, or `null` when
 * no row exists yet (a user who has never chosen — the state every scenario
 * starts in, since `wipeUserRows()` deletes it).
 *
 * The evidence half of clicking the header switch (#280). The Ark segment group
 * moves its own selection the moment it is clicked, so `toBeChecked()` says the
 * WIDGET moved and nothing about the server — while the server action that
 * persists it is still in flight. A scenario that clicked and immediately sent
 * therefore ran its turn on whichever tier `resolveInferenceTier()` happened to
 * read, and asserted the other one. That is the same "assert on evidence, not on
 * inputs" rule this suite's README states, applied to a PRECONDITION: this row is
 * the exact thing the next turn reads, so waiting for it is waiting for the state
 * the scenario needs rather than for a paint. `chat.ts#chooseTier` is the wait.
 */
export async function storedTier(): Promise<string | null> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    const result = await client.query<{ inference_tier: string | null }>(
      'SELECT inference_tier FROM user_prefs WHERE user_id = $1',
      [BYPASS_USER_ID],
    )
    return result.rows[0]?.inference_tier ?? null
  } catch (err) {
    if ((err as { code?: string }).code === UNDEFINED_TABLE) return null
    throw err
  } finally {
    await client.end().catch(() => {})
  }
}

/**
 * Force the suite's user onto one inference tier, the way the header switch
 * does — by writing the row `resolveInferenceTier()` reads.
 *
 * Used by global setup's preflight, which since the 2026-08-26 tier widening
 * needs BOTH tiers to prove itself (see `assertHermetic`): every role is now
 * self-hosted on the private tier, so a default-tier turn makes no Anthropic
 * call at all and cannot witness the redirect. Requires the app to have booted
 * far enough to have run `ensureSchema()` — the preflight's first turn is what
 * guarantees that, which is why this is called between the two and not before
 * either.
 *
 * The same raw upsert `setStoredInferenceTier()` performs, rather than an
 * import of it, for this file's stated reason: the repository modules are
 * `.server.ts` and would drag `assertServerOnImport` into the runner.
 * `wipeUserRows()` deletes the row afterwards, so scenarios still start from
 * the default a preview user gets.
 */
export async function setStoredTier(tier: 'anthropic' | 'verda'): Promise<void> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    await client.query(
      `INSERT INTO user_prefs (user_id, inference_tier)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET
         inference_tier = EXCLUDED.inference_tier,
         updated_at     = NOW()`,
      [BYPASS_USER_ID, tier],
    )
  } finally {
    await client.end().catch(() => {})
  }
}
