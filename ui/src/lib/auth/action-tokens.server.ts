/**
 * Action API tokens — Server Only
 *
 * Resolves the `Authorization: Bearer <secret>` presented to
 * `POST /api/agents/:id` into the userId that owns the resulting action rows.
 *
 * Secrets live in a git-ignored `configs/action-tokens.yaml` (mirroring
 * `configs/mcp-config.yaml`); see `configs/template.action-tokens.yaml` for the
 * shape. The file is parsed once and cached for the process lifetime — like
 * `server-catalog.server.ts`, config is treated as static within a run.
 *
 * Shape:
 *   tokens:
 *     - label: "iphone"            # optional, bookkeeping only
 *       secret: "<long-random>"
 *       userId: "<entra-oid>"      # caller's Entra object id (#119)
 *
 * The `userId` is the Entra `oid` — the same stable id the app keys sessions
 * and conversations on since #119. The endpoint contract is unchanged; only
 * what this value denotes moved from a Stack Auth id to the Entra oid.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { assertServerOnImport } from "../harness-patterns/assert.server";

assertServerOnImport();

interface TokenEntry {
  secret: string;
  userId: string;
  label?: string;
}

/**
 * Parse the YAML text into a `secret → userId` map. Pure (no filesystem) so it
 * can be unit-tested directly. Tolerant of a missing/empty `tokens` list and
 * skips entries without a non-empty `secret` and `userId`.
 */
export function parseActionTokens(yamlText: string): Map<string, string> {
  const out = new Map<string, string>();
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch {
    return out;
  }
  const tokens = (doc as { tokens?: unknown })?.tokens;
  if (!Array.isArray(tokens)) return out;
  for (const raw of tokens) {
    const entry = raw as Partial<TokenEntry>;
    const secret = typeof entry.secret === "string" ? entry.secret.trim() : "";
    const userId = typeof entry.userId === "string" ? entry.userId.trim() : "";
    if (secret && userId) out.set(secret, userId);
  }
  return out;
}

/** `process.cwd()` is the `ui/` dir, so repo-root `configs/` is one level up.
 *  Mirror `server-catalog.server.ts`'s candidate resolution. */
function resolveConfigPath(file: string): string | null {
  const candidates = [
    path.resolve(process.cwd(), "..", "configs", file),
    path.resolve(process.cwd(), "configs", file),
    path.resolve(process.cwd(), "..", "..", "configs", file),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

let tokenCache: Map<string, string> | null = null;

function loadTokens(): Map<string, string> {
  if (tokenCache) return tokenCache;
  const file = resolveConfigPath("action-tokens.yaml");
  if (!file) {
    console.warn(
      "[action-tokens] configs/action-tokens.yaml not found — POST /api/agents/:id will reject all requests. Copy configs/template.action-tokens.yaml to set it up.",
    );
    tokenCache = new Map();
    return tokenCache;
  }
  try {
    tokenCache = parseActionTokens(readFileSync(file, "utf8"));
  } catch (err) {
    console.error("[action-tokens] failed to read action-tokens.yaml:", err);
    tokenCache = new Map();
  }
  return tokenCache;
}

/**
 * Resolve a Bearer secret to its userId, or null when unknown/blank. A blank
 * secret never matches (we never store blank keys), so an absent header maps to
 * null rather than the first entry.
 */
export function resolveActionUser(secret: string | null | undefined): string | null {
  if (!secret) return null;
  return loadTokens().get(secret) ?? null;
}

/** Extract the Bearer credential from an `Authorization` header, or null. */
export function bearerSecret(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return m ? m[1].trim() : null;
}

/** Test-only: drop the cached config so a test can swap the file under it. */
export function __resetActionTokenCache(): void {
  tokenCache = null;
}
