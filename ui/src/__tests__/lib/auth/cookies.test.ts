/**
 * Auth cookie parse/serialize (#119).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../../lib/harness-patterns/assert.server", () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}));

import {
  parseCookies,
  readCookie,
  serializeCookie,
  sessionCookie,
  clearCookie,
  SESSION_COOKIE,
} from "../../../lib/auth/cookies.server";

describe("parseCookies", () => {
  it("parses multiple cookies and URL-decodes values", () => {
    expect(parseCookies("a=1; b=hello%20world")).toEqual({ a: "1", b: "hello world" });
  });
  it("tolerates null / empty / junk", () => {
    expect(parseCookies(null)).toEqual({});
    expect(parseCookies("")).toEqual({});
    expect(parseCookies("novalue; =noname")).toEqual({});
  });
});

describe("readCookie", () => {
  it("reads a named cookie from a Request", () => {
    const req = new Request("http://x/", {
      headers: { cookie: `${SESSION_COOKIE}=sid123; other=y` },
    });
    expect(readCookie(req, SESSION_COOKIE)).toBe("sid123");
    expect(readCookie(req, "missing")).toBeNull();
  });
});

describe("serializeCookie", () => {
  it("defaults to HttpOnly + SameSite=Lax + Path=/", () => {
    const c = serializeCookie("k", "v");
    expect(c).toContain("k=v");
    expect(c).toContain("Path=/");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("HttpOnly");
  });
  it("URL-encodes the value and includes Max-Age when set", () => {
    const c = serializeCookie("k", "a b", { maxAgeSeconds: 60 });
    expect(c).toContain("k=a%20b");
    expect(c).toContain("Max-Age=60");
  });
  it("adds Secure only in production", () => {
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(serializeCookie("k", "v")).toContain("Secure");
      process.env.NODE_ENV = "test";
      expect(serializeCookie("k", "v")).not.toContain("Secure");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

describe("sessionCookie / clearCookie", () => {
  it("sessionCookie carries the id + Max-Age + HttpOnly", () => {
    const c = sessionCookie("sid", 100);
    expect(c).toContain(`${SESSION_COOKIE}=sid`);
    expect(c).toContain("Max-Age=100");
    expect(c).toContain("HttpOnly");
  });
  it("clearCookie zeroes Max-Age", () => {
    expect(clearCookie(SESSION_COOKIE)).toContain("Max-Age=0");
  });
});
