# Application upgrade and rollback gate

#432 G20 row 13. Operator procedure from the existing pinned release checkout,
with its production Compose files/profile and protected configuration. No step
authorizes an agent to access a live server or run providers. Schedule downtime
and review the full target commit SHA and migration diff first. Keep Engine and
database image changes separate; use the [Engine gate](docker-engine-upgrade.md)
for those. Never use `down -v`, reset data volumes or prune retained images.

## 1. Stop writers and take local dumps before changing the checkout

Stop ingress, both app containers if enabled, gateway clients and any external
writer. Stop routines by stopping their apps. Keep Postgres/Redis/Neo4j running
for capture. Confirm that the matching application keys are escrowed **off the
host and separately from dumps** (SD-17). The two-clone database policy still
needs the owner's nod in PREVIEW §12; this procedure does not grant it.

The following is the **single-app** shape, run as the deployment's Docker user:

```sh
docker compose stop caddy app mcp-gateway || exit 1
neo4j_id=$(docker compose ps -q neo4j) || exit 1
test -n "$neo4j_id" || exit 1
neo4j_image=$(docker inspect --format '{{.Image}}' "$neo4j_id") || exit 1
neo4j_volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$neo4j_id") || exit 1
test -n "$neo4j_image" && test -n "$neo4j_volume" || exit 1
dump_root="$PWD/upgrade-dumps/$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
BACKUP_DIR="$dump_root/release" NEO4J_IMAGE="$neo4j_image" NEO4J_DATA_VOLUME="$neo4j_volume" \
  bash scripts/backup-preview.sh || exit 1
```

With two clones, also stop `app-dev` **before** the dump. Supply the actual
release database name via `POSTGRES_DB` to that command (the default is the
single-app database). Then run the same backup command with `--no-neo4j`,
`BACKUP_DIR` set to `"$dump_root/dev"` and `POSTGRES_DB` set to the separate dev
database. The default `POSTGRES_USER` is the local administrator; keep database
names and dump records private. Do not assume a dump of one database covers the
other. Both dumps must succeed before either clone upgrades. The first capture
already covers shared Neo4j and Redis; repeating Redis capture is harmless while
all writers remain stopped. Take the matching role/grant inventory privately
too: `pg_dump` does not dump server roles.

**Stop on any failure.** For every database, retain its nonempty `postgres.dump`,
successful `MANIFEST`, and absence of `INCOMPLETE`; also require the shared
`neo4j.dump` and `redis.rdb`. The backup verifies Postgres's archive table of
contents and Redis's header; Neo4j is checked only for nonempty bytes
(scripts/backup-preview.sh:164). PREVIEW §9's isolated restore drill is the
loadability check. Capture with the currently running Neo4j image, not a rebuilt
mutable tag. The script restarts Neo4j after its dump; a failed health wait is a
failed gate. Do not continue with partial files.

Keep this `upgrade-dumps/` directory outside the routinely rotated `backups/`
tree until the rollback window is explicitly closed; protect it as user data and
never commit it. Off-box backups remain deferred. A local dump protects against
a bad migration, not host/disk loss.

## 2. Retain the actual last-good images

The apps are stopped, so use `ps -aq`, not the running-only selector. Record
the current commit and image IDs privately, then tag each actual container image
before any build can replace its mutable tag:

```sh
app_id=$(docker compose ps -aq app) || exit 1
test -n "$app_id" || exit 1
app_image=$(docker inspect --format '{{.Image}}' "$app_id") || exit 1
docker image tag "$app_image" hames-app:rollback || exit 1
```

When enabled, repeat for `app-dev` using `hames-app:dev-rollback`. Do not overwrite
an unresolved previous rollback point; choose an additional unique tag privately
and retain its matching dumps/configuration. A tag without its matching key set
and compatible data is insufficient. Never publish inspect output or env files.

## 3. Move the pin, build and verify before reopening ingress

Review the target's bootstrap arguments and release notes. Use bootstrap with
the existing hostname/ACME/operator arguments and the new **full** `--ref` SHA,
selecting `--only checkout,env,images,boot --no-seed` for a **single app**.
For clones, instead run `--only checkout,env,images --no-seed` first, keep the
two-clone inputs in place, and build/update each reviewed pin via PREVIEW §12's
validated Compose path. Before any clone-enabled bootstrap `boot`, validate the
final production/clone configuration and chain boot with `&&` as below. Replace
the example hostname, ACME email and full target SHA with the deployment's
existing bootstrap arguments; retain any other required operator arguments.
Never print or save the rendered configuration. A failed render or validator
must prevent boot; do not run boot separately after a failure.

```bash
set -o pipefail
docker compose config --format json | node scripts/validate-clones.mjs &&
  bash scripts/bootstrap-vps.sh --hostname app.example.invalid \
    --acme-email ops@example.invalid --ref '<full-target-sha>' --only boot --no-seed
```

No automatic update of the dev branch is implied. Boot can start
Caddy; keep ingress blocked by the operator's maintenance control until the
checks pass. Never run the seed stage as an upgrade mechanism. Build only after
checking measured capacity for the serving data tier plus embedder/build peak.

Run bootstrap `--only smoke --no-seed` with the deployment's normal hostname and
ACME arguments. This covers the relay/isolation checks and the local CPU
embedder's `/v1/embeddings` response with **1024 finite dimensions**
(scripts/bootstrap-vps.sh:1769). Repeat app/auth checks for each enabled clone;
bootstrap's on-box app checks target the release app. Run PREVIEW §8's browser
sign-in/allow-list, persisted synthetic conversation, graph and stash checks.
Run the [external uptime probe](observability.md) from off-box for each hostname.

**Private-tier check is explicit and may wake a metered box.** In a separately
authorized live window for the operator's current private endpoints, add
`--probe-private-health` to smoke for one small-model health GET, then run a
synthetic private conversation that completes, exercises describe and a systemone
decision, and survives reload. Check the recorded clients follow the selected
tier and no public fallback occurred. Health alone does not exercise the chat
model or decisions. Verda is paused: **never wake or probe it**. If the relevant
live window is not authorized, mark private validation **pending** and the
upgrade gate incomplete; do not call a skipped check success. This repository
change runs none of those live checks.

Reopen ingress only after all required checks pass; preserve the previous
image, protected configuration, dumps and separate key escrow until the rollback
window closes. If a gate fails, stop ingress and both writers, keep evidence
privately and follow the decision below. No automated rollback is shipped.

## 4. Schema rollback decision

`SCHEMA_SQL` is additive/idempotent, pinned in #643 by the
[schema pin](../../app/src/__tests__/lib/db/schema-additive.test.ts#L123) (including exact legacy
exceptions). **There is no automatic down-migration.** An older compatible app
may ignore added columns/tables, but an image rollback leaves them in place;
never drop columns/tables to make the old image fit. Review data semantics,
encrypted-column inventories and dependencies too: the additive pin does not
prove old code can read new data or ciphertext.

For a compatible image-only rollback, return the checkout/configuration to its
recorded good pin, tag `hames-app:rollback` back to `hames-app:local` (and
`hames-app:dev-rollback` back to `hames-app:dev` for the other clone), then
`docker compose up -d --no-build --force-recreate app` (also `app-dev` when
enabled). For clones, use the following immediately before recreation, with the
deployment's production/clone Compose files and profile; failed validation must
prevent startup. Never print or save the rendered configuration:

```bash
set -o pipefail
docker compose config --format json | node scripts/validate-clones.mjs &&
  docker compose up -d --no-build --force-recreate app app-dev
```

The single-app command above is unchanged. Do not rebuild over the retained
image. Repeat the full smoke before reopening ingress; do not roll back a leaked
credential.

If compatibility is uncertain, keep writers stopped. Restore the pre-upgrade
dump into an isolated database using the matching pgvector/Postgres image and
role setup, check it with the old application and matching keys, then plan an
explicit cutover. PREVIEW §9 describes the restore drill. Restoring loses all
post-dump writes; the operator must accept that before replacing any live data.
Changes to shared Neo4j/Redis require both clones stopped and a coordinated
restore; never downgrade a Neo4j store in place. PREVIEW §10's pre-#260 warning
still applies: old binaries without decryption support can overwrite ciphertext.
