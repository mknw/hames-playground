#!/usr/bin/env node
/** Offline, secret-silent preflight. Feed `docker compose config --format json`
 * on stdin; never save or print that rendered config (it contains secrets).
 * PENDING_OWNER_DATABASE_POLICY is provisional; dev Docker access is opt-in.
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  // Lexical paths can hide the same checkout behind a symlink. Missing build
  // contexts are refused by realpathSync rather than accepted speculatively.
  const contexts = apps.map((app) => realpathSync(app.build.context));
  check(contexts[0] !== contexts[1], "Build from separate checkouts");
  const configs = apps.map((app, i) => {
    const mounts = (app.volumes ?? []).filter((v) => v.target === "/configs");
    check(
      mounts.length === 1 && mounts[0].type === "bind" && mounts[0].read_only,
      "Each app needs its own read-only configs bind",
    );
    const source = realpathSync(mounts[0].source);
    check(
      source === realpathSync(join(dirname(contexts[i]), "configs")),
      "Each app must mount its own checkout's configs",
    );
    return source;
  });
  check(configs[0] !== configs[1], "Clones must not share configs");

  // One owner opt-in: add docker-compose.dev-sandbox.yaml to COMPOSE_FILE.
  // It supplies both this policy and the mount; default clones have neither.
  const devDockerSocket = config["x-clone-dev-docker-socket"];
  check(
    typeof devDockerSocket === "boolean",
    "Declare the dev Docker socket policy",
  );
  const devSockets = (dev.volumes ?? []).filter(
    (v) => v.target === "/var/run/docker.sock",
  );
  check(
    devDockerSocket || devSockets.length === 0,
    "Dev Docker socket requires the explicit owner opt-in",
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
  const cacheBases = envs.map((env) => env.SANDBOX_CACHE_VOLUME.trim());
  check(
    cacheBases[0] !== cacheBases[1] &&
      !cacheBases[0].startsWith(`${cacheBases[1]}-`) &&
      !cacheBases[1].startsWith(`${cacheBases[0]}-`),
    "Clones must not share or overlap tenant SANDBOX_CACHE_VOLUME names",
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
