/**
 * Per-user encrypted MSAL token cache (#110).
 *
 * Hits the live Postgres container (mirrors session-store.test.ts); skips
 * gracefully when Postgres isn't reachable.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("../../../lib/harness-patterns/assert.server", () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}));

// The store encrypts with a key derived from AUTH_SESSION_SECRET when no
// dedicated TOKEN_ENCRYPTION_KEY is set. Pin one so the test is self-contained.
process.env.TOKEN_ENCRYPTION_KEY ||= "unit-test-token-encryption-key";

import {
  saveUserTokenCache,
  loadUserTokenCache,
  hasUserTokenCache,
  deleteUserTokenCache,
} from "../../../lib/auth/user-tokens.server";
import { closePool, query } from "../../../lib/db/client.server";

const TEST_OID = `test-oid-${Math.random().toString(36).slice(2, 10)}`;
const CACHE = JSON.stringify({ RefreshToken: { "x-y": { secret: "r3fr3sh" } } });
let dbAvailable = true;

beforeAll(async () => {
  try {
    await query("SELECT 1");
  } catch (err) {
    dbAvailable = false;
    console.warn("[user-tokens.test] Postgres unreachable, skipping:", err);
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  await query("DELETE FROM user_tokens WHERE user_id = $1", [TEST_OID]);
  await closePool();
});

describe("per-user token cache", () => {
  it("round-trips a cache and reports existence", async () => {
    if (!dbAvailable) return;
    expect(await hasUserTokenCache(TEST_OID)).toBe(false);

    await saveUserTokenCache(TEST_OID, CACHE, "home-acct-1");

    const loaded = await loadUserTokenCache(TEST_OID);
    expect(loaded).not.toBeNull();
    expect(loaded!.tokenCache).toBe(CACHE);
    expect(loaded!.homeAccountId).toBe("home-acct-1");
    expect(await hasUserTokenCache(TEST_OID)).toBe(true);
  });

  it("stores the cache ENCRYPTED at rest (no plaintext secret in the row)", async () => {
    if (!dbAvailable) return;
    const { rows } = await query<{ token_cache: string }>(
      "SELECT token_cache FROM user_tokens WHERE user_id = $1",
      [TEST_OID],
    );
    expect(rows[0].token_cache).not.toContain("r3fr3sh");
    expect(rows[0].token_cache).not.toContain("RefreshToken");
    expect(rows[0].token_cache.startsWith("v1.")).toBe(true);
  });

  it("upsert replaces the cache (refresh-token rotation) and bumps updated_at", async () => {
    if (!dbAvailable) return;
    const before = await loadUserTokenCache(TEST_OID);
    await new Promise((r) => setTimeout(r, 25));

    const rotated = JSON.stringify({ RefreshToken: { "x-y": { secret: "rotated" } } });
    await saveUserTokenCache(TEST_OID, rotated, "home-acct-2");

    const after = await loadUserTokenCache(TEST_OID);
    expect(after!.tokenCache).toBe(rotated);
    expect(after!.homeAccountId).toBe("home-acct-2");
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
  });

  it("treats an undecryptable row as absent (re-auth required)", async () => {
    if (!dbAvailable) return;
    await query("UPDATE user_tokens SET token_cache = $2 WHERE user_id = $1", [
      TEST_OID,
      "v1.aaaa.bbbb.cccc", // well-formed shape, bogus contents
    ]);
    expect(await loadUserTokenCache(TEST_OID)).toBeNull();
    // …but existence is still true: the row is there, just unusable.
    expect(await hasUserTokenCache(TEST_OID)).toBe(true);
  });

  it("delete is idempotent and clears the cache", async () => {
    if (!dbAvailable) return;
    await deleteUserTokenCache(TEST_OID);
    expect(await loadUserTokenCache(TEST_OID)).toBeNull();
    expect(await hasUserTokenCache(TEST_OID)).toBe(false);
    await deleteUserTokenCache(TEST_OID); // no throw
  });

  it("returns null for a user who never signed in", async () => {
    if (!dbAvailable) return;
    expect(await loadUserTokenCache("never-signed-in-oid")).toBeNull();
  });
});
