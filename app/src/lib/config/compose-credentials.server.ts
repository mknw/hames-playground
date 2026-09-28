/**
 * The laptop stack's two database passwords have ONE source: the repo-root
 * `.env` that `docker-compose.yaml` reads for `${NEO4J_PASSWORD:?}` /
 * `${POSTGRES_PASSWORD:?}`.
 *
 * Everything outside Compose that needs the same value — `pnpm dev` on the host,
 * the three test suites' database URLs, the org-graph scripts — reads it through
 * this module instead of carrying its own default. Those defaults used to be the
 * literal `password`, which was right only while the compose file said the same
 * thing; once the password moved into `.env`, a fresh clone initialised its
 * volumes with one value while every other consumer kept sending another.
 *
 * Resolution, per name: the process environment first (an explicit value always
 * wins — it is how the `app` container gets it, from Compose), then the `.env`
 * beside `docker-compose.yaml` in the working directory or its parent (`app/`
 * is the usual cwd; the org-graph scripts run from the root). There is
 * deliberately no fallback literal: an unresolved password yields a credential
 * the database rejects, and the test suites' global setup turns that rejection
 * into a failed run (`src/__tests__/global-setup.ts`) rather than a skip.
 *
 * No `assertServerOnImport()`: `src/__tests__/setup.ts` imports this under
 * jsdom, where the guard would throw. It reads the filesystem, so nothing
 * client-side can import it and build.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'

export type ComposeSecretName = 'NEO4J_PASSWORD' | 'POSTGRES_PASSWORD'

/** The `.env` Compose reads: beside the `docker-compose.yaml` found in `cwd` or
 *  its parent. `undefined` when there is no compose project in reach (e.g. the
 *  built image, whose cwd is `/app`). */
export function composeEnvFile(cwd: string = process.cwd()): string | undefined {
  for (const dir of [cwd, path.dirname(cwd)]) {
    if (existsSync(path.join(dir, 'docker-compose.yaml'))) return path.join(dir, '.env')
  }
  return undefined
}

/** `name` from the environment, else from the compose `.env`; `undefined` when
 *  neither has a non-empty value. Pass `file: null` for "no file at all" (an
 *  `undefined` argument means the default discovery). */
export function composeSecret(
  name: ComposeSecretName,
  env: Readonly<Record<string, string | undefined>> = process.env,
  file: string | null | undefined = composeEnvFile(),
): string | undefined {
  if (env[name]) return env[name]
  if (!file) return undefined
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  return parseEnv(text)[name] || undefined
}

/** A `postgresql://` URL for the compose Postgres on localhost, carrying the
 *  compose password (URL-encoded). With no password resolved the URL has none,
 *  and the server's rejection is what reports it. `resolvePassword` is a thunk
 *  rather than a defaulted value so a caller can say "none" explicitly — an
 *  `undefined` argument would silently re-trigger the default. */
export function localDatabaseUrl(
  database: string,
  resolvePassword: () => string | undefined = () => composeSecret('POSTGRES_PASSWORD'),
): string {
  const password = resolvePassword()
  const auth = password === undefined ? 'postgres' : `postgres:${encodeURIComponent(password)}`
  return `postgresql://${auth}@localhost:5432/${database}`
}
