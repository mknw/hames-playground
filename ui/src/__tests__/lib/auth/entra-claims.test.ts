/**
 * Mocked-token unit tests for Entra ID-token → identity mapping (#119).
 * Pure module — no server/MSAL imports, so no mocking needed.
 */
import { describe, it, expect } from "vitest";
import { extractIdentity } from "../../../lib/auth/entra-claims";

describe("extractIdentity", () => {
  it("maps oid/email/name/tid", () => {
    expect(
      extractIdentity({ oid: "abc", email: "a@b.com", name: "A B", tid: "tenant-1" }),
    ).toEqual({
      userId: "abc",
      email: "a@b.com",
      displayName: "A B",
      tenantId: "tenant-1",
    });
  });

  it("falls back to preferred_username when email is absent", () => {
    const id = extractIdentity({ oid: "abc", preferred_username: "user@corp.com" });
    expect(id.email).toBe("user@corp.com");
    expect(id.displayName).toBeNull();
    expect(id.tenantId).toBeNull();
  });

  it("prefers email over preferred_username", () => {
    const id = extractIdentity({
      oid: "x",
      email: "primary@b.com",
      preferred_username: "upn@b.com",
    });
    expect(id.email).toBe("primary@b.com");
  });

  it("trims whitespace on all fields", () => {
    expect(
      extractIdentity({ oid: "  o  ", email: "  e@b.com ", name: "  N  " }),
    ).toEqual({ userId: "o", email: "e@b.com", displayName: "N", tenantId: null });
  });

  it("throws when oid is missing/blank/null", () => {
    expect(() => extractIdentity({ email: "a@b.com" })).toThrow(/oid/);
    expect(() => extractIdentity({ oid: "   ", email: "a@b.com" })).toThrow(/oid/);
    expect(() => extractIdentity(null)).toThrow(/oid/);
    expect(() => extractIdentity(undefined)).toThrow(/oid/);
  });

  it("throws when no email/preferred_username is present", () => {
    expect(() => extractIdentity({ oid: "abc" })).toThrow(/email|preferred_username/);
    expect(() => extractIdentity({ oid: "abc", email: "  " })).toThrow(
      /email|preferred_username/,
    );
  });
});
