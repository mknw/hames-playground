/**
 * Mint a fresh, globally-unique session id for a new conversation.
 *
 * Replaces Solid's `createUniqueId()` for this specific purpose. The Solid
 * helper produces `cl-${counter++}` on the client and resets the counter on
 * every page load, which collides with previously-persisted rows once any
 * conversations exist in Postgres (see #52). UUIDs avoid the collision and
 * have no cross-load shared state.
 *
 * `crypto.randomUUID` is the preferred path but it's only defined in secure
 * contexts (https, localhost, 127.0.0.1) — dev access over a LAN IP or
 * `host.docker.internal` leaves it undefined and we hit `not a function`.
 * `crypto.getRandomValues` is available in non-secure contexts too, so we
 * use it to build an RFC 4122 v4 UUID by hand as a fallback.
 */
export const newSessionId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return uuidV4Fallback()
}

const uuidV4Fallback = (): string => {
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  // RFC 4122 §4.4: set version (4) in byte 6 and variant (10xx) in byte 8.
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
