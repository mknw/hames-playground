#!/usr/bin/env node
/** Offline, secret-silent preflight. Feed `docker compose config --format json`
 * on stdin; never save or print that rendered config (it contains secrets).
 * PENDING_OWNER_DATABASE_POLICY is the only provisional policy below.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function validateClones(config) {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const release = config.services?.app;
  const dev = config.services?.["app-dev"];
  check(release && dev, "Both built app services are required");
  const apps = [release, dev];
  const envs = apps.map((app) => app.environment ?? {});
  for (const app of apps) {
    check(
      app.build?.context && !app.command && !app.entrypoint,
      "Use the built image runtime",
    );
    check(
      app.networks && Object.hasOwn(app.networks, "app-network"),
      "Both apps must use the shared app network",
    );
    check(
      !(app.volumes ?? []).some(
        (v) =>
          v.type === "bind" &&
          v.target !== "/configs" &&
          v.target !== "/var/run/docker.sock",
      ),
      "No checkout or runtime env bind mounts",
    );
  }
  check(
    resolve(release.build.context) !== resolve(dev.build.context),
    "Build from separate checkouts",
  );
  check(release.image !== dev.image, "Built images need distinct names");
  check(
    (dev.ports ?? []).length === 0,
    "Dev app must stay on the compose network",
  );
  for (const [i, env] of envs.entries()) {
    check(
      env.VITE_DEV_BYPASS_AUTH === "false",
      "Auth bypass must be off in both clones",
    );
    check(
      env.SANDBOX_ENVIRONMENT === ["release", "dev"][i],
      "Each clone needs its sandbox environment label",
    );
    check(env.SANDBOX_CACHE_VOLUME, "Each clone needs a sandbox cache volume");
    const redirect = new URL(env.AUTH_REDIRECT_URI);
    check(
      redirect.protocol === "https:" &&
        redirect.pathname === "/api/auth/callback" &&
        !redirect.search &&
        !redirect.hash &&
        !redirect.username &&
        !redirect.password,
      "Each clone needs an HTTPS Entra callback",
    );
    check(
      new URL(env.AUTH_POST_LOGOUT_REDIRECT_URI).origin === redirect.origin,
      "Logout must return to the same clone",
    );
    for (const key of [
      "DATA_ENCRYPTION_KEY",
      "AUTH_SESSION_SECRET",
      "TOKEN_ENCRYPTION_KEY",
    ]) {
      check(
        typeof env[key] === "string" && env[key].trim().length >= 32,
        `Both clones require independent ${key}`,
      );
    }
    check(
      !env.POSTGRES_PASSWORD,
      "App env files must not contain Postgres administrator credentials",
    );
  }
  check(
    envs[0].SANDBOX_CACHE_VOLUME.trim() !== envs[1].SANDBOX_CACHE_VOLUME.trim(),
    "Clones must not share SANDBOX_CACHE_VOLUME",
  );
  const secrets = envs.flatMap((env) =>
    ["DATA_ENCRYPTION_KEY", "AUTH_SESSION_SECRET", "TOKEN_ENCRYPTION_KEY"].map(
      (key) => env[key].trim(),
    ),
  );
  check(
    new Set(secrets).size === secrets.length,
    "All six clone keys must be independent",
  );
  check(
    new URL(envs[0].AUTH_REDIRECT_URI).hostname !==
      new URL(envs[1].AUTH_REDIRECT_URI).hostname,
    "Clones need distinct hostnames and Entra redirects",
  );

  // PENDING_OWNER_DATABASE_POLICY: one server, separate DBs and limited roles.
  // Do not add a silent shared-database fallback; revise here after owner ruling.
  const databases = envs.map((env) => new URL(env.DATABASE_URL));
  for (const db of databases) {
    check(
      ["postgres:", "postgresql:"].includes(db.protocol) &&
        db.hostname === "postgres" &&
        (db.port || "5432") === "5432" &&
        !db.search &&
        !db.hash,
      "Both clones must use the shared compose Postgres server",
    );
    check(
      db.pathname.length > 1 &&
        db.username &&
        db.password &&
        !["postgres", "root"].includes(decodeURIComponent(db.username)),
      "Each clone needs a non-admin database role",
    );
  }
  check(
    decodeURIComponent(databases[0].pathname) !==
      decodeURIComponent(databases[1].pathname),
    "Clones need separate databases",
  );
  check(
    decodeURIComponent(databases[0].username) !==
      decodeURIComponent(databases[1].username),
    "Clones need separate Postgres roles",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    validateClones(JSON.parse(readFileSync(0, "utf8")));
    console.log(
      "Clone configuration checks passed; verify role grants separately (§12).",
    );
  } catch {
    // Parse/URL errors can include the input; never echo their messages here.
    console.error(
      "Clone configuration refused; check docs/PREVIEW.md §12 and app-only env files.",
    );
    process.exitCode = 1;
  }
}
