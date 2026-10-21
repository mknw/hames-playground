#!/usr/bin/env node
/** Offline, secret-silent preflight. Feed `docker compose config --format json`
 * on stdin; never save or print that rendered config (it contains secrets).
 * Each clone has its own database and role; dev Docker access is opt-in.
 */
import { X509Certificate, createPrivateKey } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isIPv4 } from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// Where each clone's sandbox reaches Docker (#648): the host socket rules, or
// its own environment VM over mutual TLS. Common-pool is designed, not built.
const SANDBOX_MODES = ["socket", "per-env"];
const TLS_FILES = {
  SANDBOX_DOCKER_TLS_CA: "/run/sandbox-tls/ca.pem",
  SANDBOX_DOCKER_TLS_CERT: "/run/sandbox-tls/cert.pem",
  SANDBOX_DOCKER_TLS_KEY: "/run/sandbox-tls/key.pem",
};
// Each reaches host or sibling resources around the mount rules: another
// container's mounts or /proc/<pid>/root (the gateway holds the host socket),
// host devices, capabilities or namespaces, or a file-backed secret or config,
// which Compose bind-mounts at any target and of any file type.
const HOST_REACH = [
  "privileged",
  "volumes_from",
  "pid",
  "ipc",
  "network_mode",
  "userns_mode",
  "cgroup",
  "devices",
  "cap_add",
  "secrets",
  "configs",
];

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const within = (path, directory) =>
  path === directory ||
  path.startsWith(directory === sep ? directory : directory + sep);
// Every host path a service mounts, with its target: bind volumes, the files
// behind its secrets and configs, and named volumes whose local driver binds a
// host device.
const hostMounts = (config, service) => [
  ...(service.volumes ?? []).flatMap((v) => {
    if (v.type === "bind") return [v];
    const device =
      v.type === "volume" && config.volumes?.[v.source]?.driver_opts?.device;
    return device ? [{ source: device, target: v.target }] : [];
  }),
  ...["secrets", "configs"].flatMap((key) =>
    (service[key] ?? []).flatMap((entry) => {
      const file = config[key]?.[entry.source]?.file;
      return file ? [{ source: file, target: entry.target }] : [];
    }),
  ),
];

// A VM clone reaches Docker only through its own environment VM: a tcp endpoint
// with verified TLS and three read-only files outside both checkouts, and no
// other mount, so no Docker socket can ride in under another target or name.
function environmentVm(app, roots) {
  const env = app.environment ?? {};
  const volumes = app.volumes ?? [];
  check(
    volumes.length === 4 &&
      volumes.every((v) => v.type === "bind" && v.read_only === true) &&
      Object.values(TLS_FILES).every(
        (target) =>
          volumes.filter(
            (v) => v.target === target && v.bind?.create_host_path === false,
          ).length === 1,
      ),
    "A VM clone mounts only its configs and its three read-only TLS files",
  );
  check(
    Object.keys(env)
      .filter((key) => key.startsWith("SANDBOX_DOCKER_"))
      .sort()
      .join() === ["SANDBOX_DOCKER_HOST", ...Object.keys(TLS_FILES)].join() &&
      Object.entries(TLS_FILES).every(([key, target]) => env[key] === target),
    "A VM clone reaches Docker only with its mounted TLS files",
  );
  // The backend passes the endpoint as flags, but the terminal path inherits
  // the app's environment: a DOCKER_* variable would be a second endpoint.
  check(
    Object.keys(env).every((key) => !key.startsWith("DOCKER_")),
    "A VM clone must not carry Docker client variables",
  );
  const endpoint = /^tcp:\/\/([0-9.]+):([0-9]{1,5})$/.exec(
    env.SANDBOX_DOCKER_HOST,
  );
  const [a, b] = endpoint?.[1].split(".").map(Number) ?? [];
  check(
    endpoint &&
      isIPv4(endpoint[1]) &&
      Number(endpoint[2]) >= 1 &&
      Number(endpoint[2]) <= 65535 &&
      !(a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254)),
    "A VM clone needs a tcp://IPv4:port guest endpoint",
  );
  const files = {};
  for (const [key, target] of Object.entries(TLS_FILES)) {
    const path = realpathSync(volumes.find((v) => v.target === target).source);
    const stat = statSync(path);
    // A Docker socket is not a regular file, whatever it is called.
    check(stat.isFile(), "TLS mounts must be regular files");
    check(
      !roots.some((root) => path.startsWith(root + sep)),
      "TLS files must live outside both checkouts",
    );
    files[key] = { path, stat, pem: readFileSync(path, "utf8") };
  }
  check(
    (files.SANDBOX_DOCKER_TLS_KEY.stat.mode & 0o077) === 0,
    "The TLS key file must have no group/other permissions",
  );
  const ca = files.SANDBOX_DOCKER_TLS_CA.pem;
  const leaf = files.SANDBOX_DOCKER_TLS_CERT.pem;
  const certificates = (pem) =>
    (pem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length;
  check(
    certificates(ca) === 1 &&
      certificates(leaf) === 1 &&
      ![ca, leaf].some((pem) => pem.includes("PRIVATE KEY-----")),
    "TLS CA and certificate files hold one certificate each and no key",
  );
  // The CA alone decides which daemon answers: the client verifies the server
  // against it, and only this environment's VM holds a leaf it signed.
  const authority = new X509Certificate(ca);
  const certificate = new X509Certificate(leaf);
  check(
    authority.ca &&
      !certificate.ca &&
      certificate.verify(authority.publicKey) &&
      certificate.checkPrivateKey(
        createPrivateKey(files.SANDBOX_DOCKER_TLS_KEY.pem),
      ),
    "The client certificate must chain to its own VM's CA and match its key",
  );
  // Neither check above reads the dates: an expired CA or leaf would pass the
  // preflight and then fail every sandbox call.
  const now = Date.now();
  check(
    [authority, certificate].every(
      (x) => new Date(x.validFrom) <= now && now <= new Date(x.validTo),
    ),
    "TLS CA and client certificates must be within their validity period",
  );
  const sources = Object.values(files).map((file) => file.path);
  return { host: endpoint[1], authority, certificate, sources };
}

export function validateClones(config) {
  const release = config.services?.app;
  const dev = config.services?.["app-dev"];
  check(release && dev, "Both built app services are required");
  const apps = [release, dev];
  const envs = apps.map((app) => app.environment ?? {});
  const modes = ["release", "dev"].map(
    (clone) => config[`x-clone-${clone}-sandbox`],
  );
  check(
    modes.every((mode) => SANDBOX_MODES.includes(mode)),
    "Declare each clone's sandbox endpoint (socket or per-env)",
  );
  for (const [i, app] of apps.entries()) {
    check(
      app.build?.context && !app.command && !app.entrypoint,
      "Use the built image runtime",
    );
    check(
      app.networks && Object.hasOwn(app.networks, "app-network"),
      "Both apps must use the shared app network",
    );
    check(
      !HOST_REACH.some((key) => [app[key]].flat().some(Boolean)),
      "Apps must not join host or sibling namespaces, devices or mounts",
    );
    // A VM clone's mounts are pinned exactly by environmentVm instead.
    check(
      modes[i] === "per-env" ||
        !hostMounts(config, app).some(
          (v) => v.target !== "/configs" && v.target !== "/var/run/docker.sock",
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
  check(
    !(devDockerSocket && modes[1] === "per-env"),
    "Dev cannot combine the socket opt-in with its environment VM",
  );
  const roots = contexts.map((context) => dirname(context));
  const vms = [];
  for (const [i, name] of ["app", "app-dev"].entries()) {
    if (modes[i] !== "per-env") {
      check(
        !Object.keys(envs[i]).some((key) => key.startsWith("SANDBOX_DOCKER_")),
        "A socket clone must not carry sandbox VM settings",
      );
      continue;
    }
    const vm = environmentVm(apps[i], roots);
    vms.push(vm);
    // Another service built from, tagged as or joined to a VM clone would run
    // that clone's code beside whatever it mounts, and one that mounts its TLS
    // files, or a directory holding them, by any of hostMounts' routes would
    // reach its VM: a VM clone is one service. A container id cannot be told
    // apart from the clone's, so only the other app's container name may be
    // joined.
    const joins = [
      name,
      `service:${name}`,
      `container:${apps[i].container_name}`,
    ];
    const resolved = (source) => {
      try {
        return realpathSync(source);
      } catch {
        return resolve(source); // A missing source cannot hold a TLS file.
      }
    };
    for (const [other, service] of Object.entries(config.services)) {
      check(
        other === name ||
          !(
            service.image === apps[i].image ||
            (service.build?.context &&
              realpathSync(service.build.context) === contexts[i]) ||
            ["network_mode", "pid", "ipc"].some(
              (key) =>
                joins.includes(service[key]) ||
                (String(service[key] ?? "").startsWith("container:") &&
                  service[key] !== `container:${apps[1 - i].container_name}`),
            ) ||
            [service.volumes_from ?? []]
              .flat()
              .some((v) => joins.includes(String(v).replace(/:r[ow]$/, ""))) ||
            hostMounts(config, service).some((v) =>
              vm.sources.some((file) => within(file, resolved(v.source))),
            )
          ),
        "A VM clone runs as one service",
      );
    }
  }
  if (vms.length === 2) {
    const [own, other] = vms;
    check(own.host !== other.host, "Each clone needs its own environment VM");
    // Checked both ways, so neither clone's leaf is valid on the other's VM.
    check(
      !own.certificate.verify(other.authority.publicKey) &&
        !other.certificate.verify(own.authority.publicKey),
      "A clone's TLS identity must not reach the other clone's VM",
    );
  }
  check(release.image !== dev.image, "Built images need distinct names");
  check(
    (dev.ports ?? []).length === 0,
    "Dev app must stay on the compose network",
  );
  for (const [i, env] of envs.entries()) {
    check(
      !Object.keys(env).some((key) =>
        /^(RELEASE_DATABASE_URL|DEV_DATABASE_URL|.*_RUNTIME_ENV_FILE|DEV_CLONE_PATH|COMPOSE_FILE|(RELEASE|DEV)_SANDBOX_DOCKER_[A-Z_]+)$/.test(
          key,
        ),
      ),
      "App env files must not contain root Compose inputs",
    );
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

  // Owner-approved policy: one server, separate databases and limited roles.
  // Keep this guard aligned with x-clone-database-policy; no shared-DB fallback.
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
        !["postgres", "template0", "template1"].includes(
          decodeURIComponent(db.pathname.slice(1)),
        ) &&
        db.username &&
        db.password &&
        !["postgres", "root"].includes(decodeURIComponent(db.username)),
      "Each clone needs a non-admin database role",
    );
  }
  const passwords = databases.map((db) => decodeURIComponent(db.password));
  check(passwords[0] !== passwords[1], "Clone role passwords must differ");
  const administrator =
    config.services.postgres?.environment?.POSTGRES_PASSWORD;
  for (const [i, env] of envs.entries()) {
    const ownSecrets = [
      passwords[i],
      env.DATABASE_URL,
      ...[
        "DATA_ENCRYPTION_KEY",
        "AUTH_SESSION_SECRET",
        "TOKEN_ENCRYPTION_KEY",
      ].map((key) => env[key].trim()),
    ];
    check(
      !Object.values(envs[1 - i]).some((value) =>
        ownSecrets.some((secret) => String(value).includes(secret)),
      ),
      "App env contains sibling credentials",
    );
    check(
      !administrator ||
        !Object.values(env).some(
          (value) =>
            String(value).includes(administrator) ||
            (value === env.DATABASE_URL &&
              passwords[i].includes(administrator)),
        ),
      "App env contains Postgres administrator credentials",
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
