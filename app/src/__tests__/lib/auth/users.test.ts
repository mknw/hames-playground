/**
 * Round-trip test for the users repository (#119).
 *
 * Hits the live Postgres container (mirrors session-store.test.ts). Skips
 * gracefully when Postgres isn't reachable.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Bypass server-only guard in the jsdom test env.
vi.mock("../../../lib/harness-patterns/assert.server", () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}));

import { upsertUser, getUser, listUsers } from "../../../lib/auth/users.server";
import { closePool, query } from "../../../lib/db/client.server";

const TEST_OID = `test-user-oid-${Math.random().toString(36).slice(2, 10)}`;
let dbAvailable = true;

beforeAll(async () => {
  try {
    await query("SELECT 1");
  } catch (err) {
    dbAvailable = false;
    console.warn("[users.test] Postgres unreachable, skipping:", err);
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  await query("DELETE FROM users WHERE id = $1", [TEST_OID]);
  await closePool();
});

describe("users repository", () => {
  it("creates on first sign-in with first_login == last_login", async () => {
    if (!dbAvailable) return;
    await upsertUser({
      id: TEST_OID,
      email: "u@dtsc.be",
      displayName: "U One",
      tenantId: "tid-1",
    });
    const u = await getUser(TEST_OID);
    expect(u).not.toBeNull();
    expect(u!.email).toBe("u@dtsc.be");
    expect(u!.displayName).toBe("U One");
    expect(u!.tenantId).toBe("tid-1");
    expect(u!.firstLogin.getTime()).toBe(u!.lastLogin.getTime());
  });

  it("re-sign-in refreshes profile + last_login but preserves first_login", async () => {
    if (!dbAvailable) return;
    const before = await getUser(TEST_OID);
    // Ensure NOW() differs measurably from the insert timestamp.
    await new Promise((r) => setTimeout(r, 25));
    await upsertUser({
      id: TEST_OID,
      email: "renamed@dtsc.be",
      displayName: "U Renamed",
      tenantId: "tid-1",
    });
    const after = await getUser(TEST_OID);
    expect(after!.email).toBe("renamed@dtsc.be");
    expect(after!.displayName).toBe("U Renamed");
    expect(after!.firstLogin.getTime()).toBe(before!.firstLogin.getTime());
    expect(after!.lastLogin.getTime()).toBeGreaterThan(before!.lastLogin.getTime());
  });

  it("getUser returns null for unknown ids; listUsers includes the row", async () => {
    if (!dbAvailable) return;
    expect(await getUser("never-signed-in")).toBeNull();
    const all = await listUsers();
    expect(all.some((u) => u.id === TEST_OID)).toBe(true);
  });
});
