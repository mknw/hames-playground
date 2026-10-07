# Postgres → pgvector: the one-time dump-and-restore

**Who runs this: the operator, by hand, once per database** (the laptop stack, the
preview VM — each has its own volume). Nothing in the repo runs it for you, and
CI never does. This is the runbook for #419 M8; the design reasoning is in that
issue's decision record.

## Why a dump and restore, not an image swap

`withMemory` stores embeddings in a `vector(1024)` column, so Postgres needs the
`vector` extension. `postgres:16-alpine` cannot load it. The image that can is
`pgvector/pgvector:0.8.0-pg16-bookworm`, and it is **Debian (glibc), not Alpine
(musl)**: the two order text differently, so every b-tree index on a `TEXT`
column (each `id TEXT PRIMARY KEY`, the share-token index) built on the old
cluster is **wrong under the new image**. Starting the new image on the old
cluster would run, log `ready to accept connections` with no warning, and
quietly return rows in a different order and miss rows on index lookups. A
restore rebuilds every index under the new collation; that is the reason for the
dump, and it is why the old cluster must never be mounted by the new image.

**The compose file enforces that, not this runbook:** the pgvector cluster lives
in a NEW volume, `pg16_glibc_data` (`hames_pg16_glibc_data` on disk). The
alpine-era `hames_postgres_data` is no longer referenced by any compose file, so
pulling this commit and running any `docker compose up` — `up -d --build`, `up -d
app`, a `bootstrap-vps.sh` re-run — can only ever create an EMPTY cluster next to
the old one, never re-point the old one. The old volume stays exactly as it was
until you remove it yourself, after a verified restore.

The image is pinned by **manifest-index digest** in `docker-compose.yaml`, and
it is the **same digest `.github/workflows/ci.yml` tests against**, so the
laptop, the compose stack and CI are one image (`postgres-image-pin.test.ts`
fails when they part). Do not edit one without the other.

## Before you start

- **`DATA_ENCRYPTION_KEY` is escrowed off the box.** A dump of this database is
  ciphertext in every personal column and unreadable without it
  ([`PREVIEW.md` §7](../PREVIEW.md)). The migration dump lands in
  `pgvector-migration-dump/` at the repo root — **not** under `backups/`, whose
  directories `backup-preview.sh` deletes after `RETENTION_DAYS` — and is as
  sensitive: it never leaves the machine, nothing rotates it, and you delete it
  yourself when you are done.
- **The cluster must hold only the `hames` database** (plus the `postgres` one).
  `dump` refuses otherwise, because a dump of one database leaves any other
  behind. Dump or drop the other yourself first.
- Free disk for roughly three copies of the database (the live volume, the dump,
  the optional volume backup).
- `docker compose` resolves the stack from the repo root. On the VM that is
  `/opt/hames` and `COMPOSE_FILE=docker-compose.yaml:docker-compose.prod.yaml`
  comes from `.env`; on a laptop it is the base file. Run every command from the
  repo root so the script and compose agree on the project (`hames`).
- `docker pull` the digest from `docker-compose.yaml` beforehand: the downtime
  includes that pull.

## The sequence

```bash
# 0. Get the commit that carries the script and the new compose file. The old
#    postgres container keeps running on the old volume: git does not touch it.
#    DO NOT `docker compose up` anything until step 4.
git pull

# 1. Stop writers. The dump is a moment in time; the script re-counts after it
#    and refuses a dump taken while rows were changing.
docker compose stop app            # skip if the app is not a compose service on this box

# 2. Dump + verify, from the OLD (alpine) Postgres, still running on the OLD image.
#    Writes pgvector-migration-dump/<ts>/ and prints that path: the old
#    collation and libc, and per table its exact row count and a content checksum
#    (collation-independent), plus a pg_restore --list check. Refuses if the
#    cluster holds any other database.
./scripts/migrate-postgres-pgvector.sh dump

# 3. Stop the old Postgres cleanly. OPTIONAL: copy its volume aside. The old
#    volume is not touched by anything below, so this is a second copy, not the
#    rollback — it is verified (clean shutdown, same file count and bytes).
docker compose stop postgres
./scripts/migrate-postgres-pgvector.sh volume-backup     # -> hames_postgres_data_alpine_backup

# 4. Bring up the NEW image on its NEW, empty volume, then restore into it.
docker compose up -d --wait postgres
./scripts/migrate-postgres-pgvector.sh restore pgvector-migration-dump/<ts>
#    exit 0 == every table's row count AND content checksum match the dump, and
#    the restore ran in one transaction. Anything else: stop, do not start the
#    app, see Rollback.

# 5. Start the rest. The first memory call runs CREATE EXTENSION vector itself
#    (memories.server.ts's own ensure); nothing else to do.
docker compose up -d
```

`restore` refuses a Postgres that is not running on the new volume, that has no
`vector` extension, or whose database already holds tables — so running it twice,
or against the old image, stops with a message instead of doing anything. It
restores in a single transaction: if it fails, the database is still empty.

## Rollback

The old cluster is still in `hames_postgres_data`, untouched. To go back:
`docker compose stop`, `git checkout` the commit from before this change, and
`docker compose up -d` — the old compose file mounts the old volume under the old
image, exactly as it was. Nothing to copy, nothing to repair.

**Rolling back discards every write made after the migration**: the new cluster
is a separate volume, the old one never saw those writes, and nothing carries them
back. If the new stack has been live for more than a moment, take a `backup-preview.sh`
dump first and decide what to do with the rows written since.

## When you are done

Run the stack on the new image for a few days. Then, **yourself** (the script has
no mode that removes anything, and neither does CI):

```bash
docker volume rm hames_postgres_data                  # the old cluster
docker volume rm hames_postgres_data_alpine_backup    # the copy, if you made one
rm -r pgvector-migration-dump/<ts>
```

Until you do, each of those is a full copy of the database as it was before
memory existed — ciphertext in the personal columns, but ids, owner ids and
timestamps in plain — on the same disk as the live data (the data map's
migration-copies row, [`data-privacy/plan.md`](../data-privacy/plan.md)). None of
them holds a vector: that Postgres could not store the column.

## Verifying the procedure

`scripts/migrate-postgres-pgvector.test.sh` runs in CI against a docker shim that
allow-lists the calls the script may make, and holds each refusal above. The
restore path was also exercised end to end on a throwaway project holding a
seeded database, never on a real one: dump on `postgres:16-alpine`,
`volume-backup`, a fresh volume on the pinned pgvector digest, `restore` (counts
matched, `CREATE EXTENSION vector` then succeeded at 0.8.0). A restore against a
dump whose counts had been altered exited non-zero with the diff; a restore into
a populated database and a `volume-backup` over an existing backup each refused.
Re-run that drill on a scratch compose project after changing the script.
