/**
 * HMAC cookie signing (#119). Keys are injectable so no env is touched.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../../lib/harness-patterns/assert.server", () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}));

import {
  signPayload,
  verifyPayload,
  newOpaqueId,
} from "../../../lib/auth/cookie-signing.server";

const KEY = "unit-test-secret";

describe("signPayload / verifyPayload", () => {
  it("round-trips a JSON payload", () => {
    const token = signPayload({ state: "s", verifier: "v", nonce: "n" }, KEY);
    expect(verifyPayload(token, KEY)).toEqual({ state: "s", verifier: "v", nonce: "n" });
  });

  it("rejects a tampered body (same signature)", () => {
    const token = signPayload({ state: "s" }, KEY);
    const sig = token.slice(token.lastIndexOf(".") + 1);
    const forgedBody = Buffer.from(JSON.stringify({ state: "evil" })).toString("base64url");
    expect(verifyPayload(`${forgedBody}.${sig}`, KEY)).toBeNull();
  });

  it("rejects a wrong key", () => {
    const token = signPayload({ state: "s" }, KEY);
    expect(verifyPayload(token, "different-key")).toBeNull();
  });

  it("rejects malformed / empty input", () => {
    expect(verifyPayload(null, KEY)).toBeNull();
    expect(verifyPayload(undefined, KEY)).toBeNull();
    expect(verifyPayload("", KEY)).toBeNull();
    expect(verifyPayload("no-dot", KEY)).toBeNull();
    expect(verifyPayload(".", KEY)).toBeNull();
    expect(verifyPayload("body.", KEY)).toBeNull();
  });
});

describe("newOpaqueId", () => {
  it("is URL-safe and unique across calls", () => {
    const a = newOpaqueId();
    const b = newOpaqueId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(40);
  });
});
