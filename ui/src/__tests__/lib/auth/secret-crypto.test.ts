/**
 * At-rest secret encryption (#110). Keys are injectable so no env is touched.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../../lib/harness-patterns/assert.server", () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}));

import {
  encryptSecret,
  decryptSecret,
  generateEncryptionKey,
} from "../../../lib/auth/secret-crypto.server";
import { hkdfSync, randomBytes } from "node:crypto";

const KEY = Buffer.from(randomBytes(32));
const OTHER_KEY = Buffer.from(randomBytes(32));

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a payload", () => {
    const plain = JSON.stringify({ RefreshToken: { secret: "r1" } });
    const env = encryptSecret(plain, KEY);
    expect(decryptSecret(env, KEY)).toBe(plain);
  });

  it("does not leak plaintext into the envelope", () => {
    const env = encryptSecret("super-secret-refresh-token", KEY);
    expect(env).not.toContain("super-secret-refresh-token");
    expect(env.startsWith("v1.")).toBe(true);
    expect(env.split(".")).toHaveLength(4);
  });

  it("is non-deterministic (fresh IV per call)", () => {
    expect(encryptSecret("same", KEY)).not.toBe(encryptSecret("same", KEY));
  });

  it("returns null for a wrong key (GCM auth failure)", () => {
    expect(decryptSecret(encryptSecret("x", KEY), OTHER_KEY)).toBeNull();
  });

  it("returns null for tampered ciphertext", () => {
    const parts = encryptSecret("x", KEY).split(".");
    const flipped = Buffer.from(parts[3], "base64url");
    flipped[0] ^= 0xff;
    parts[3] = flipped.toString("base64url");
    expect(decryptSecret(parts.join("."), KEY)).toBeNull();
  });

  it("returns null for malformed / empty / unknown-version input", () => {
    expect(decryptSecret(null, KEY)).toBeNull();
    expect(decryptSecret(undefined, KEY)).toBeNull();
    expect(decryptSecret("", KEY)).toBeNull();
    expect(decryptSecret("not-an-envelope", KEY)).toBeNull();
    expect(decryptSecret("v9.a.b.c", KEY)).toBeNull();
    expect(decryptSecret("v1.a.b", KEY)).toBeNull();
  });

  it("handles unicode and large payloads", () => {
    const big = "é🔐".repeat(5000);
    expect(decryptSecret(encryptSecret(big, KEY), KEY)).toBe(big);
  });
});

describe("key handling", () => {
  it("generateEncryptionKey returns 32 bytes of base64", () => {
    const k = generateEncryptionKey();
    expect(Buffer.from(k, "base64")).toHaveLength(32);
  });

  it("derives the same key from the same env secret (HKDF is deterministic)", () => {
    const derive = (s: string) =>
      Buffer.from(hkdfSync("sha256", Buffer.from(s), Buffer.alloc(0), "kg-agent:secret-crypto:v1", 32));
    const a = derive("secret-a");
    const b = derive("secret-a");
    expect(a.equals(b)).toBe(true);
    // …and a different secret yields a different key (domain separation holds).
    expect(a.equals(derive("secret-b"))).toBe(false);
    // Round-trip through the derived key works.
    expect(decryptSecret(encryptSecret("v", a), b)).toBe("v");
  });
});
