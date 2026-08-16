/**
 * Dev auth bypass — single source of truth.
 *
 * Replaces four duplicated `import.meta.env.VITE_DEV_BYPASS_AUTH === 'true'`
 * checks (`AuthProvider.tsx`, `actions.server.ts`, `routes/api/events.ts`,
 * `routes/api/stash.ts`) and unifies the frontend/backend mock user id.
 *
 * Closes #42.
 */

// TODO(#42): `BYPASS_USER.id` is a single literal shared by every developer
// running with bypass enabled, which means all devs hitting the same Postgres
// share one conversation namespace. Per-dev namespacing (e.g. seeded from
// hostname or git user.email) is intentionally out of scope here — tracked
// as the remaining footgun on #42.
export const BYPASS_USER = {
  id: "dev-bypass-user",
  email: "dev@local",
} as const;

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
  return (
    import.meta.env.DEV === true &&
    import.meta.env.VITE_DEV_BYPASS_AUTH === "true"
  );
}

// Surface the leakage path: a production build with the env var still set.
// `isBypassEnabled()` already returns false here (DEV gate), but a silent
// no-op would hide a misconfiguration. Run once at module load.
if (
  !import.meta.env.DEV &&
  import.meta.env.VITE_DEV_BYPASS_AUTH === "true"
) {
  console.warn(
    "[dev-bypass] VITE_DEV_BYPASS_AUTH=true is set in a production build. " +
      "The bypass is ignored (gated on import.meta.env.DEV), but the env " +
      "var should be removed from production config to avoid confusion.",
  );
}
