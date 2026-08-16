/**
 * At-rest encryption for stored secrets — Server Only.
 *
 * AES-256-GCM (authenticated) for secret material we must persist, currently
 * the per-user MSAL token cache (#110): it holds refresh tokens, so plaintext
 * at rest is not acceptable (#107 / #110 both specify an *encrypted* cache).
 *
 * Key material: a dedicated `TOKEN_ENCRYPTION_KEY` when set, otherwise
 * HKDF-derived from `AUTH_SESSION_SECRET` with a distinct `info` label. The
 * derivation keeps encryption and cookie-signing keys cryptographically
 * separate (domain separation) without forcing a second mandatory env var —
 * but a dedicated key is preferred in production so the two can rotate
 * independently.
 *
 * Ciphertext format (versioned so the scheme can be rotated):
 *   `v1.<iv>.<authTag>.<ciphertext>`   — all parts base64url
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  hkdfSync,
} from "node:crypto";
import { assertServerOnImport } from "../harness-patterns/assert.server";

assertServerOnImport();

const VERSION = "v1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32;
const HKDF_INFO = "kg-agent:secret-crypto:v1";

/**
 * Resolve the 32-byte encryption key. Throws when neither
 * `TOKEN_ENCRYPTION_KEY` nor `AUTH_SESSION_SECRET` is configured — failing
 * closed is deliberate: we must never silently fall back to storing plaintext.
 */
function encryptionKey(): Buffer {
  const dedicated = process.env.TOKEN_ENCRYPTION_KEY?.trim();
  if (dedicated) {
    // Accept base64 / base64url / hex / raw; normalize to exactly 32 bytes by
    // HKDF so a short or long value can still be used safely.
    return Buffer.from(
      hkdfSync("sha256", Buffer.from(dedicated), Buffer.alloc(0), HKDF_INFO, KEY_BYTES),
    );
  }
  const fallback = process.env.AUTH_SESSION_SECRET?.trim();
  if (fallback) {
    return Buffer.from(
      hkdfSync("sha256", Buffer.from(fallback), Buffer.alloc(0), HKDF_INFO, KEY_BYTES),
    );
  }
  throw new Error(
    "[secret-crypto] no encryption key: set TOKEN_ENCRYPTION_KEY (preferred) " +
      "or AUTH_SESSION_SECRET. Refusing to store secrets unencrypted.",
  );
}

/** Encrypt a UTF-8 plaintext into the versioned envelope. */
export function encryptSecret(plaintext: string, key: Buffer = encryptionKey()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ct.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt an envelope produced by {@link encryptSecret}. Returns `null` on any
 * malformed input, unknown version, wrong key, or failed authentication —
 * callers treat that as "no usable cache" and re-authenticate rather than
 * crashing a request.
 */
export function decryptSecret(
  envelope: string | null | undefined,
  key: Buffer = encryptionKey(),
): string | null {
  if (!envelope) return null;
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ct = Buffer.from(parts[3], "base64url");
    if (iv.length !== IV_BYTES || tag.length !== 16) return null;
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key or tampered ciphertext — GCM auth failure lands here.
    return null;
  }
}

/** Test/ops helper: generate a fresh key suitable for `TOKEN_ENCRYPTION_KEY`. */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}
