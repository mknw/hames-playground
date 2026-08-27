/**
 * Dev auth bypass — single source of truth.
 *
 * Replaces four duplicated `import.meta.env.VITE_DEV_BYPASS_AUTH === 'true'`
 * checks (`AuthProvider.tsx`, `actions.server.ts`, `routes/api/events.ts`,
 * `routes/api/stash.ts`) and unifies the frontend/backend mock user id.
 *
 * Closes #42.
 */

/**
 * The identity every bypassed request runs as.
 *
 * `id` is overridable through `VITE_DEV_BYPASS_USER_ID`, and that is the only
 * reason this is not a bare literal. #42 recorded the footgun: one id shared by
 * everything running with the bypass on means one conversation namespace in one
 * Postgres, so two things using the bypass at once delete each other's rows.
 * That stopped being hypothetical with the test pyramid — `app/e2e/` and
 * `app/e2e-browser/` both drive real turns and both wipe "their" rows by user id,
 * and running them concurrently produced false reds (#280). Each suite now names
 * its own id.
 *
 * Read through `import.meta.env` rather than `process.env` for the same reason
 * `VITE_DEV_BYPASS_AUTH` below is: this module is imported by BOTH halves —
 * `AuthProvider.tsx` in the browser bundle and the turn path on the server — and
 * `process` does not exist in one of them. Vite inlines `VITE_*` into both, so
 * setting it once on the dev server (or in a vitest `test.env`) moves both.
 *
 * It cannot leak into production: the id is only ever consulted when
 * `isBypassEnabled()` is true, and that is gated on `import.meta.env.DEV`, which
 * a production build statically replaces with `false`.
 *
 * Per-DEVELOPER namespacing (seeded from hostname or git user.email) is still out
 * of scope and still on #42; this closes the half that was breaking the suites.
 */
export const BYPASS_USER = {
  id: import.meta.env.VITE_DEV_BYPASS_USER_ID || 'dev-bypass-user',
  email: 'dev@local',
} as const

/**
 * Returns true when the dev auth bypass should be honored.
 *
 * Both gates must pass:
 *   1. `import.meta.env.DEV` — Vite statically replaces this with `false` in
 *      production builds, so the bypass is structurally impossible to enable
 *      in a prod bundle regardless of what the env var says.
 *   2. `VITE_DEV_BYPASS_AUTH === 'true'` — the explicit opt-in.
 */
export function isBypassEnabled(): boolean {
  return import.meta.env.DEV === true && import.meta.env.VITE_DEV_BYPASS_AUTH === 'true'
}

// Surface the leakage path: a production build with the env var still set.
// `isBypassEnabled()` already returns false here (DEV gate), but a silent
// no-op would hide a misconfiguration. Run once at module load.
if (!import.meta.env.DEV && import.meta.env.VITE_DEV_BYPASS_AUTH === 'true') {
  console.warn(
    '[dev-bypass] VITE_DEV_BYPASS_AUTH=true is set in a production build. ' +
      'The bypass is ignored (gated on import.meta.env.DEV), but the env ' +
      'var should be removed from production config to avoid confusion.',
  )
}
