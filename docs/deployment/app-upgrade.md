# Application upgrade and rollback gate

#432 G20 row 13. Operator procedure from the existing pinned release checkout,
with its production Compose files/profile and protected configuration. No step
authorizes an agent to access a live server or run providers. Schedule downtime
and review the full target commit SHA and migration diff first. Keep Engine and
database image changes separate; use the [Engine gate](docker-engine-upgrade.md)
for those. Never use `down -v`, reset data volumes or prune retained images.

## 1. Stop writers and take local dumps before changing the checkout

Hold public ingress for **both hostnames** at the operator's external maintenance
control and drain in-flight requests and background ingest. Stop external
writers. Stop only the release `app`; this stops its routine scheduler. In a
two-clone project, leave `app-dev` running with its ID and `StartedAt` unchanged:
disable its enabled routines across **all users** with the DEV database procedure
below, retain the exact enabled IDs privately for restoration afterward, and require zero
active dev turns before backup and again before boot. If any dev writer cannot
be drained, stop the release. Keep Caddy, the gateway and every other
long-running service running. Verify the maintenance hold before the dump and
keep it until the postboot checks pass. Keep
Postgres/Redis/Neo4j running for capture. Confirm that the matching application keys are escrowed **off the
host and separately from dumps** (SD-17). PREVIEW §12 records the approved two-clone
policy: dev has its own database and limited role, separate from release. Confirm
that both databases and their grants are provisioned before upgrading.

For two clones, export the existing `DEV_CLONE_PATH` and supply the actual
release and dev database names privately as `RELEASE_DB` and `DEV_DB`.
Use the Postgres administrator only through the local Compose service; the app
API is user-scoped and cannot drain other users' routines. The DEV database is
separate from release. After holding ingress and draining in-flight turns,
run this in the deployment user's shell from the release checkout root. The
private JSON file contains **only routine IDs**, including every user's enabled
routine; neither encrypted `input` nor `label` is read. Keep the directory
and file under `0700`/`0600`, outside the rotated backups tree, and do not print
or commit them. The lock and exact-set comparison refuse a changed enabled set
before the update; any failure is a stop. Do not restart `app-dev`.

```bash
dump_root="$PWD/upgrade-dumps/$(date -u +%Y%m%dT%H%M%SZ)"
( umask 077; mkdir -p -- "$PWD/upgrade-dumps" &&
  test ! -L "$PWD/upgrade-dumps" && chmod 700 -- "$PWD/upgrade-dumps" &&
  mkdir -m 700 -- "$dump_root" ) || exit 1
dev_psql() {
  docker compose exec -T postgres psql -U "${POSTGRES_USER:-postgres}" \
    -d "$DEV_DB" -X -v ON_ERROR_STOP=1 -qAt "$@"
}
if test -n "${DEV_CLONE_PATH:-}"; then
  test -n "${RELEASE_DB:-}" && test -n "${DEV_DB:-}" || exit 1
  dev_enabled_ids="$dump_root/dev-enabled-ids.json"
  ( umask 077; dev_psql -c "SELECT coalesce(jsonb_agg(id ORDER BY id), '[]'::jsonb) FROM routines WHERE enabled" > "$dev_enabled_ids" ) || exit 1
  test -s "$dev_enabled_ids" || exit 1
  dev_psql -v ids_json="$(cat "$dev_enabled_ids")" <<'SQL' || exit 1
BEGIN;
LOCK TABLE routines IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE saved_ids (id text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO saved_ids SELECT jsonb_array_elements_text(:'ids_json'::jsonb);
DO $$ BEGIN
  IF (SELECT coalesce(jsonb_agg(id ORDER BY id), '[]'::jsonb) FROM routines WHERE enabled)
     <> (SELECT coalesce(jsonb_agg(id ORDER BY id), '[]'::jsonb) FROM saved_ids)
  THEN RAISE EXCEPTION 'DEV enabled routine set changed during drain'; END IF;
END $$;
UPDATE routines SET enabled = FALSE, updated_at = NOW() WHERE id IN (SELECT id FROM saved_ids);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM routines WHERE enabled)
  THEN RAISE EXCEPTION 'DEV routines remain enabled'; END IF;
END $$;
COMMIT;
SQL
fi
```

With ingress still held, this read-only check must return
`0:0`; repeat it immediately before §3's preboot gate. An enabled routine or
running conversation is a stop, not a reason to stop/restart DEV:

```bash
check_dev_writers() {
  test -n "${DEV_CLONE_PATH:-}" || return 0
  test -n "${RELEASE_DB:-}" && test -n "${DEV_DB:-}" && test -s "${dev_enabled_ids:-}" || return 1
  dev_writers=$(docker compose exec -T postgres psql -U "${POSTGRES_USER:-postgres}" \
    -d "$DEV_DB" -X -Atqc "SELECT (SELECT count(*) FROM routines WHERE enabled) || ':' || (SELECT count(*) FROM conversations WHERE status = 'running')") || return 1
  test "$dev_writers" = '0:0'
}
check_dev_writers || exit 1
```

Run the following from the release checkout root as the deployment's Docker
user for either shape. Capture the §3 baseline **after** the dump, because the
backup script restarts Neo4j:

```sh
docker compose stop app || exit 1
neo4j_id=$(docker compose ps -q neo4j) || exit 1
test -n "$neo4j_id" || exit 1
neo4j_image=$(docker inspect --format '{{.Image}}' "$neo4j_id") || exit 1
neo4j_volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$neo4j_id") || exit 1
test -n "$neo4j_image" && test -n "$neo4j_volume" || exit 1
(
  umask 077
  BACKUP_DIR="$dump_root/release" POSTGRES_DB="${RELEASE_DB:-hames}" NEO4J_IMAGE="$neo4j_image" NEO4J_DATA_VOLUME="$neo4j_volume" \
    bash scripts/backup-preview.sh
) || exit 1
```

For two clones, capture the dev database without stopping its container:

```bash
if test -n "${DEV_CLONE_PATH:-}"; then
  ( umask 077; BACKUP_DIR="$dump_root/dev" POSTGRES_DB="$DEV_DB" \
      bash scripts/backup-preview.sh --no-neo4j ) || exit 1
fi
```

Keep §1 through §3 in the same operator shell so `dump_root` and
`check_dev_writers` remain available. The older generic backup/restore path may stop `caddy`, `mcp-gateway` and
`app-dev`. That state is **ineligible** for §3's full-boot gate: restarting
those services would change `StartedAt`. Do not combine the old stop sequence
with this procedure. The default `POSTGRES_USER` is the local administrator; keep database
names and dump records private. Do not assume a dump of one database covers the
other. Both dumps must succeed before either clone upgrades. The first capture
already covers shared Neo4j and Redis; repeating Redis capture is harmless while
all writers remain quiescent. Take the matching role/grant inventory privately
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

The release app is stopped, so use `ps -aq`, not the running-only selector. Record
the current commit and image IDs privately, then tag each actual container image
before any build can replace its mutable tag:

```sh
app_id=$(docker compose ps -aq app) || exit 1
test -n "$app_id" || exit 1
app_image=$(docker inspect --format '{{.Image}}' "$app_id") || exit 1
docker image tag "$app_image" hames-app:rollback || exit 1
```

With two clones, record `app-dev`'s current image ID privately but do not
rebuild or retag it in this release-app upgrade. Do not overwrite
an unresolved previous rollback point; choose an additional unique tag privately
and retain its matching dumps/configuration. A tag without its matching key set
and compatible data is insufficient. Never publish inspect output or env files.

## 3. Move the pin, build and verify before reopening ingress

Review the target's bootstrap arguments and release notes. This staged path
covers both a single app and two clones. Use the same existing hostname, ACME
and other operator arguments on each bootstrap invocation, and the reviewed
full release SHA on checkout. For clones, keep the dev checkout at its
separately reviewed full SHA, verify `DEV_REF` in the protected root `.env`
already equals that SHA before baseline capture, and keep its image/container unchanged. Bootstrap
refuses a dirty or mismatched dev checkout during clone operations. Never
select `--only checkout,env,images,boot` in one call: the comparisons occur
between those stages.

From the current release checkout root, after §1 and §2, capture the baseline
**before checkout**. Keep the gate script and JSON private in the retained dump
directory. Fetch the reviewed target under `022` without moving the checkout,
then copy the reviewed gate script from that SHA. A missing script or baseline
stops the release. Set `TARGET_SHA` to the reviewed full commit and replace the
example hostname and email below with the existing real values. Preserve any
other required bootstrap arguments on **every** call:

```bash
TARGET_SHA='<reviewed-full-40-character-target-sha>'
test "$(id -u)" -ne 0 && test "${#TARGET_SHA}" -eq 40 || exit 1
case "$TARGET_SHA" in *[!0-9a-f]*) exit 1 ;; esac
umask 022
( umask 022; git fetch --quiet --prune --tags origin ) || exit 1
git cat-file -e "$TARGET_SHA^{commit}" ||
  ( umask 022; git fetch --quiet origin "$TARGET_SHA" ) || exit 1
git cat-file -e "$TARGET_SHA^{commit}" || exit 1
gate_copy="$dump_root/app-upgrade-gate.py"
( umask 077; git show "$TARGET_SHA:scripts/app-upgrade-gate.py" > "$gate_copy" ) || exit 1
baseline="$dump_root/preboot-baseline.json"
python3 "$gate_copy" capture "$baseline" || exit 1
bash scripts/bootstrap-vps.sh --hostname app.example.invalid \
  --acme-email ops@example.invalid --ref "$TARGET_SHA" --only checkout --no-seed || exit 1
bash scripts/bootstrap-vps.sh --hostname app.example.invalid \
  --acme-email ops@example.invalid --ref "$TARGET_SHA" --only env --no-seed || exit 1
bash scripts/bootstrap-vps.sh --hostname app.example.invalid \
  --acme-email ops@example.invalid --ref "$TARGET_SHA" --only images --release-image-only --no-seed || exit 1
check_dev_writers || exit 1
python3 "$gate_copy" preboot "$baseline" || exit 1
bash scripts/bootstrap-vps.sh --hostname app.example.invalid \
  --acme-email ops@example.invalid --ref "$TARGET_SHA" --only boot --no-seed || exit 1
python3 "$gate_copy" postboot "$baseline" || exit 1
```

The release-only images option builds `app` without rebuilding Neo4j or
`app-dev`; the clone preflight still runs before the build. The gate records
every existing service's container ID, `StartedAt`, Compose
config-hash label, mounted volume names/identities and
`docker compose config --hash '*'` with the same
complete Compose files and `app` profile before checkout and at the target. Stop if
any shared service other than `embedder` has a changed target hash. The one
permitted shared change is `embedder`'s hash for the durable Compose 3 GiB
`mem_limit`: only its container may be recreated. With ingress still held, the
gate runs `docker compose --dry-run --progress json up -d` from the target
checkout using the same Compose files and profile as bootstrap, adding
`--remove-orphans` only for a single-app project. Any `app-dev` entry in the
clone prediction must be a non-mutating observation, with no start or
recreation.
It parses and lists every predicted create, recreate and start;
proceed only if they are the release app, that intended `embedder` recreation,
or the one-shot `mcp-config` rerun. Any other prediction or an unavailable dry
run is a stop. After boot, every other long-running shared container must keep
its ID and `StartedAt`, and every mounted volume identity/name must match the
preboot record. The gate also compares the running Caddy's actual bind-mounted
regular files with the target checkout **before boot**; unequal content stops
the release even if Compose hashes match. Verify `embedder` healthy, its cgroup limit at 3 GiB from
Compose without a temporary runtime override, and one successful embedding
request; retire the temporary override record only then.

The gate records the preboot `mcp-config` ID and exit status. That one-shot may
rerun only if its ID stays the same, it exits 0, and its actual rendered volume
file hash matches after boot; the gateway must keep its ID/`StartedAt`. A
missing baseline or unreadable rendered file stops the release. The script
hashes the file through `docker cp` and never prints or saves its contents.

For clones, bootstrap's own clone preflight validates the full Compose render
before images and boot, including the dev checkout
and both runtime files. It does not replace the baseline, Caddy comparison or
complete action prediction above. Never print or save the rendered
configuration; a failed render or validator must prevent boot.

```bash
set -o pipefail
docker compose config --format json |
  docker run --rm -i --pull never --network none --read-only --cap-drop ALL \
    --user "$(id -u):$(id -g)" --entrypoint node \
    -v "$PWD":"$PWD":ro -v "$DEV_CLONE_PATH":"$DEV_CLONE_PATH":ro \
    hames-app:local "$PWD/scripts/validate-clones.mjs"
```

The validator runs inside the release app image, as you, so the host needs no
Node (#681); export the §12 `DEV_CLONE_PATH` from `.env`. The block is for the
socket shapes only, run from real (non-symlink) checkout paths: it mounts the
two checkouts and nothing else. With a VM overlay selected, run bootstrap's own
preflight instead (`--only boot --dry-run` changes nothing), which resolves
every host path on the host before it mounts the checkouts and each TLS file.
A missing image refuses until the release-only images stage builds it.

If Caddyfile contents or imported sites changed, stop this restricted upgrade
and review a separate Caddy maintenance window. Generic bootstrap does this itself now
(#672): it compares the running Caddy's bind-mounted regular files against the
checkout and recreates only Caddy when one differs, and the smoke fails (check
1c) when the running Caddy still serves a file the checkout no longer holds.
This detects the checkout stage's own replace (a new inode); an in-place edit
of a mounted file (same inode, e.g. `cat >`) is NOT detected — the bind mount
shows the new content, so the comparison reads fresh, while Caddy keeps the
config it parsed at start. Comparing Caddy's loaded config is a follow-up.

No automatic update of the dev branch is implied. Generic boot can start
Caddy; keep ingress blocked by the operator's maintenance control until the
checks pass. Never run the seed stage as an upgrade mechanism. Build only after
checking measured capacity for the serving data tier plus embedder/build peak.

### Metadata policy upgrade

Check 10 compares `/usr/local/lib/vps-metadata-egress.py` byte-for-byte with the
new checkout. Every change to that script therefore requires this gap-free
refresh before the upgrade smoke. Persistence intentionally refuses to overwrite
different installed files. Never remove/reinstall the policy without interim
denies: that would expose metadata. Keep external ingress held closed and other
workloads/builds stopped; one healthy app is needed for smoke.

Before moving the pin, retain the old root-owned installed script (mode 0644)
at `/root/metadata-egress-before.py`. Create this root-owned helper at
`/root/metadata-egress-interim.py` (mode 0600) using the independent console.
It uses the old script's entire exact inventory, with a distinct interim tag,
including both families and WireServer when present. Never import a mutable
checkout for this root operation. Do not replace either backup until the
upgrade completes.

```sh
sudo install -o root -g root -m 0644 /usr/local/lib/vps-metadata-egress.py /root/metadata-egress-before.py
```

```python
import runpy
import sys

old = runpy.run_path('/root/metadata-egress-before.py')
mode = sys.argv[1]
assert mode in ('insert', 'delete')
for family in old['FAMILIES']:
    for owned in reversed(old['forwarded_rules'](family)):
        rule = ['vps-metadata-upgrade-interim-v1' if value == old['FORWARD_MARKER'] else value
                for value in owned]
        check = [family, '-w', '5', '-C', 'DOCKER-USER', *rule]
        if mode == 'insert':
            if not old['present'](family, rule):
                old['command']([family, '-w', '5', '-I', 'DOCKER-USER', '1', *rule])
            old['command'](check)
        else:
            old['command'](check)
            old['command']([family, '-w', '5', '-D', 'DOCKER-USER', *rule])
```

Run the following from `$APP_DIR` at the target merged commit. Stop at any
failure and keep interim denies installed. Use the **old** artifact for undo,
because its journal and persistence bytes describe the old version; use the
new checkout for reinstallation. If the old policy predates the seed service,
new persistence also installs/enables that pre-Docker unit.

<!-- metadata-upgrade-commands -->

```sh
set -e
cd "$APP_DIR"
sudo python3 -I /root/metadata-egress-interim.py insert
sudo python3 -I /root/metadata-egress-before.py --docker-user-only --apply --remove
sudo python3 -I scripts/metadata-egress.py --docker-user-only --apply --persist
sudo systemctl start vps-metadata-egress.service
sudo python3 -I scripts/metadata-egress.py --docker-user-only --check
sudo python3 -I scripts/metadata-egress.py --docker-user-only --smoke
sudo python3 -I /root/metadata-egress-interim.py delete
sudo python3 -I scripts/metadata-egress.py --docker-user-only --check
```

The probe must increment the **new tagged** IPv4 DROP counter by at least one;
BLOCKED without an increment fails as inconclusive. Both persistence units must
be enabled and their trusted root-owned files match the target. Complete the
normal bootstrap smoke below, including check 10, before reopening ingress.
If undo encounters a journal lock, resolve the active operation from the console
and retry; never bypass it or delete the journal. Console recovery restores the
interim denies **first**, before any intentional undo. Retain the old artifact,
helper and journal privately until both families and recovery have been verified.

Run bootstrap `--only smoke --no-seed` with the deployment's normal hostname and
ACME arguments. This covers the relay/isolation checks and the local CPU
embedder's `/v1/embeddings` response with **1024 finite dimensions**
(scripts/bootstrap-vps.sh:1769). Repeat app/auth checks for each enabled clone;
bootstrap's clone smoke also compares both running app environments with the
validated configuration and verifies each limited database role by a read-only
TCP login. The browser checks still need both hostnames. Run PREVIEW §8's browser
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
window closes. If a gate fails, keep ingress held and both writers quiescent, keep evidence
privately and follow the decision below. No automated rollback is shipped.
For clones, restore exactly the privately recorded dev routine enabled-set
after smoke and postboot identity checks pass, before reopening either hostname:

```bash
restore_dev_routines() {
  test -n "${DEV_CLONE_PATH:-}" || return 0
  test -s "${dev_enabled_ids:-}" || return 1
  dev_psql -v ids_json="$(cat "$dev_enabled_ids")" <<'SQL'
BEGIN;
LOCK TABLE routines IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE saved_ids (id text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO saved_ids SELECT jsonb_array_elements_text(:'ids_json'::jsonb);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM routines WHERE enabled)
     OR (SELECT count(*) FROM saved_ids) <> (SELECT count(*) FROM routines JOIN saved_ids USING (id))
  THEN RAISE EXCEPTION 'DEV restore precondition failed'; END IF;
END $$;
UPDATE routines SET enabled = TRUE, updated_at = NOW() WHERE id IN (SELECT id FROM saved_ids);
DO $$ BEGIN
  IF (SELECT coalesce(jsonb_agg(id ORDER BY id), '[]'::jsonb) FROM routines WHERE enabled)
     <> (SELECT coalesce(jsonb_agg(id ORDER BY id), '[]'::jsonb) FROM saved_ids)
  THEN RAISE EXCEPTION 'DEV enabled routine restore differs from saved set'; END IF;
END $$;
COMMIT;
SQL
}
restore_dev_routines || exit 1
```

If any stage fails or the window is aborted, keep both hostnames held and
`app-dev` running. Preserve the private file. If the disable transaction failed,
it rolled back; compare a fresh all-user enabled-ID query with the saved JSON
before deciding that the original set needs no restoration:

```bash
# shellcheck disable=SC2154 # set in the earlier drain step
( set -o pipefail; dev_psql -c "SELECT coalesce(jsonb_agg(id ORDER BY id), '[]'::jsonb) FROM routines WHERE enabled" |
    cmp - "$dev_enabled_ids" ) || exit 1
```

An unequal set requires manual reconciliation. After a successful drain, fix the failure,
verify zero DEV enabled routines and running conversations with
`check_dev_writers`, then run the same
`restore_dev_routines` function before reopening DEV. If the shell was lost,
set `DEV_DB`, `DEV_CLONE_PATH` and `dev_enabled_ids` to the recorded values and
redefine `dev_psql` and `restore_dev_routines` from this section. An absent or
unreadable file, missing saved ID or unexpected enabled routine is a stop for
manual reconciliation; never enable all routines as recovery.

## 4. Schema rollback decision

`SCHEMA_SQL` is additive/idempotent, pinned in #643 by the
[schema pin](../../app/src/__tests__/lib/db/schema-additive.test.ts#L123) (including exact legacy
exceptions). **There is no automatic down-migration.** An older compatible app
may ignore added columns/tables, but an image rollback leaves them in place;
never drop columns/tables to make the old image fit. Review data semantics,
encrypted-column inventories and dependencies too: the additive pin does not
prove old code can read new data or ciphertext.

For a compatible image-only rollback, use the deployment user's login shell,
never `sudo git` or a root shell. The backup's `umask 077` is confined to its
subshell above; keep 077 for dumps, env files and keys, but use 022 for Git
checkout. Record the full last-good SHA privately, then run this gate **before**
invoking the checkout stage or any boot script. It checks the current checkout
first and the restored checkout again. For two clones, replace the dev SHA
placeholder with the separately recorded full dev SHA, export the existing
`DEV_CLONE_PATH`, and set the protected root `.env`'s `DEV_REF` to that same SHA;
bootstrap refuses a dev HEAD that differs from `DEV_REF`. The checkout-mode gate
checks that DEV remains at this SHA before the release checkout moves.
The tracked MCP config is the sole
intentional exception to the clean-tree check: bootstrap restores and re-applies
it around checkout. Keep protected configuration, dumps, retained images and
separate key escrow; never discard them to make this gate pass.

For either shape, repeat §1's external ingress hold, release-app stop,
dev-writer check when applicable, and fresh backups, then capture a **new**
baseline from the current checkout before moving the release pin. Use the gate
script retained with the upgrade dumps; a missing script, baseline or 3 GiB
target cap stops this path. The dev checkout and image stay at their recorded
pin during a two-clone rollback; changing DEV requires a separate coordinated
release, not this app rollback.

```bash
APP_DIR=/opt/hames
GOOD_SHA='<recorded-full-40-character-good-sha>'
DEV_GOOD_SHA='<recorded-full-40-character-dev-sha>' # used only with two clones
gate_copy='<absolute-path-to-retained-app-upgrade-gate.py>'
rollback_baseline="$dump_root/rollback-preboot-baseline.json"
test "$(id -u)" -ne 0 && test "${#GOOD_SHA}" -eq 40 || exit 1
umask 022
case "$GOOD_SHA" in *[!0-9a-f]*) exit 1 ;; esac
test -f "$gate_copy" || exit 1
check_dev_writers || exit 1
python3 "$gate_copy" capture "$rollback_baseline" || exit 1

check_checkout_modes() {
  local root=$1 path rel mode
  test -d "$root/.git" && test ! -L "$root" || return 1
  test "$(stat -c %u "$root")" = "$(id -u)" &&
    test "$(stat -c %u "$root/.git")" = "$(id -u)" || return 1
  for rel in .git/HEAD docker-compose.yaml docker-compose.prod.yaml \
    docker-config.json scripts/bootstrap-vps.sh scripts/validate-clones.mjs \
    scripts/check-vps.py scripts/render-mcp-config.sh configs/Caddyfile \
    configs/catalog.yaml configs/custom-catalog.yaml configs/mcp-config.yaml; do
    path="$root/$rel"
    test -f "$path" && test ! -L "$path" && test -r "$path" &&
      test "$(stat -c %u "$path")" = "$(id -u)" || return 1
    mode=$(stat -c %a "$path") || return 1
    case "$rel" in
      .git/HEAD) (( (8#$mode & 022) == 0 )) || return 1 ;;
      scripts/bootstrap-vps.sh|scripts/render-mcp-config.sh) test "$mode" = 755 || return 1 ;;
      *) test "$mode" = 644 || return 1 ;;
    esac
  done
  if test "$root" = "$APP_DIR" && test -n "${DEV_CLONE_PATH:-}"; then
    path="$root/configs/Caddyfile.dev"
    test -f "$path" && test ! -L "$path" && test -r "$path" &&
      test "$(stat -c %u "$path")" = "$(id -u)" &&
      test "$(stat -c %a "$path")" = 644 || return 1
  fi
  for path in "$root"/docker-compose*.yaml; do
    test -f "$path" && test ! -L "$path" && test -r "$path" &&
      test "$(stat -c %u "$path")" = "$(id -u)" &&
      test "$(stat -c %a "$path")" = 644 || return 1
  done
}

check_checkout_modes "$APP_DIR" || { echo 'Checkout ownership/modes need manual repair; stop.' >&2; exit 1; }
dirty=$(git -C "$APP_DIR" status --porcelain --untracked-files=no) || exit 1
test -z "$(printf '%s\n' "$dirty" | sed '/ configs\/mcp-config.yaml$/d')" || exit 1
if test -n "${DEV_CLONE_PATH:-}"; then
  test -n "${DEV_GOOD_SHA:-}" && test "${#DEV_GOOD_SHA}" -eq 40 || exit 1
  case "$DEV_GOOD_SHA" in *[!0-9a-f]*) exit 1 ;; esac
  check_checkout_modes "$DEV_CLONE_PATH" || exit 1
  dirty=$(git -C "$DEV_CLONE_PATH" status --porcelain --untracked-files=no) || exit 1
  test -z "$dirty" && git -C "$DEV_CLONE_PATH" cat-file -e "$DEV_GOOD_SHA^{commit}" || exit 1
  check_checkout_modes "$DEV_CLONE_PATH" &&
    test "$(git -C "$DEV_CLONE_PATH" rev-parse HEAD)" = "$DEV_GOOD_SHA" || exit 1
  dirty=$(git -C "$DEV_CLONE_PATH" status --porcelain --untracked-files=no) || exit 1
  test -z "$dirty" || exit 1
fi
( umask 022; bash "$APP_DIR/scripts/bootstrap-vps.sh" --hostname app.example.invalid \
    --acme-email ops@example.invalid --ref "$GOOD_SHA" --only checkout --no-seed ) || exit 1
check_checkout_modes "$APP_DIR" &&
  test "$(git -C "$APP_DIR" rev-parse HEAD)" = "$GOOD_SHA" || exit 1
dirty=$(git -C "$APP_DIR" status --porcelain --untracked-files=no) || exit 1
test -z "$(printf '%s\n' "$dirty" | sed '/ configs\/mcp-config.yaml$/d')" || exit 1
```

Replace the example hostname and ACME email with the deployment's existing
arguments; retain any other required bootstrap arguments. The unchanged dev
checkout retains untracked runtime files; keep its protected
configuration and separate key escrow. Stop for targeted manual repair if any
ownership, mode, pin or tree check
fails; do not apply recursive `chown`/`chmod`. Only then tag
`hames-app:rollback` back to `hames-app:local`, leaving the dev image alone.
Perform the full preboot gate, boot and postboot gate in that order for either
shape; do not rebuild over the retained image:

```bash
check_dev_writers || exit 1
python3 "$gate_copy" preboot "$rollback_baseline" || exit 1
bash scripts/bootstrap-vps.sh --hostname app.example.invalid \
  --acme-email ops@example.invalid --ref "$GOOD_SHA" --only boot --no-seed || exit 1
python3 "$gate_copy" postboot "$rollback_baseline" || exit 1
```

Replace the example hostname and email with the deployment's existing values
and retain other required operator arguments. Repeat the full smoke before
reopening ingress; do not roll back a leaked
credential.

If compatibility is uncertain, keep writers stopped. Restore the pre-upgrade
dump into an isolated database using the matching pgvector/Postgres image and
role setup, check it with the old application and matching keys, then plan an
explicit cutover. PREVIEW §9 describes the restore drill. Restoring loses all
post-dump writes; the operator must accept that before replacing any live data.
Changes to shared Neo4j/Redis require both clones stopped and a coordinated
restore; never downgrade a Neo4j store in place. PREVIEW §10's pre-#260 warning
still applies: old binaries without decryption support can overwrite ciphertext.
