# Postgres → pgvector: the one-time dump-and-restore

**Who runs this: the operator, by hand, once per database** (the laptop stack, the
preview VM — each has its own `hames_postgres_data` volume). Nothing in the repo
runs it for you, and CI never does. This is the runbook for #419 M8; the design
reasoning is in that issue's decision record.

## Why a dump and restore, not an image swap

`withMemory` stores embeddings in a `vector(1024)` column, so Postgres needs the
`vector` extension. `postgres:16-alpine` cannot load it. The image that can is
`pgvector/pgvector:0.8.0-pg16-bookworm`, and it is **Debian (glibc), not Alpine
(musl)**: the two order text differently, so every b-tree index on a `TEXT`
column (each `id TEXT PRIMARY KEY`, the share-token index) built on the old
volume is **wrong under the new image**. Starting the new image on the old
volume would run, and quietly return rows in a different order and miss rows on
index lookups. A restore rebuilds every index under the new collation; that is
the reason for the dump, and it is why the old volume must never be mounted by
the new image.

The image is pinned by **manifest-index digest** in `docker-compose.yaml`, and
it is the **same digest `.github/workflows/ci.yml` tests against**, so the
laptop, the compose stack and CI are one image (`postgres-image-pin.test.ts`
fails when they part). Do not edit one without the other.

## Before you start

- **`DATA_ENCRYPTION_KEY` is escrowed off the box.** A dump of this database is
  ciphertext in every personal column and unreadable without it
  ([`PREVIEW.md` §7](../PREVIEW.md)). The migration dump lands in `backups/`
  beside the nightly ones and is as sensitive: it never leaves the machine and
  is deleted by you when you are done.
- Free disk for roughly three copies of the database (the live volume, the dump,
  the volume backup).
- `docker compose` resolves the stack from the repo root. On the VM that is
  `/opt/hames` and `COMPOSE_FILE=docker-compose.yaml:docker-compose.prod.yaml`
  comes from `.env`; on a laptop it is the base file. Run every command from the
  repo root so the script and compose agree on the project (`hames`).
- The new image is not pulled until you check out the commit that carries it
  (step 4), so the downtime includes that pull. `docker pull` the digest from
  `docker-compose.yaml` beforehand to keep it short.

## The sequence

```bash
# 0. Stop writers. The dump is a moment in time; the script re-counts after it
#    and refuses a dump taken while rows were changing.
docker compose stop app            # skip if the app is not a compose service on this box

# 1. Dump + verify, from the OLD (alpine) Postgres, still running on the OLD image.
#    Writes backups/pgvector-migration/<ts>/ and prints that path. Row counts of
#    every table, the old collation and a pg_restore --list check are in it.
./scripts/migrate-postgres-pgvector.sh dump

# 2. Stop Postgres cleanly and copy the old volume aside. The copy is the
#    rollback; the dump is the migration.
docker compose stop postgres
./scripts/migrate-postgres-pgvector.sh volume-backup     # -> hames_postgres_data_alpine_backup

# 3. The ONLY destructive step, and it is yours to type. Remove the old
#    container and the old volume so the new image initialises a fresh cluster.
#    Check step 2 said "volume backup OK" first.
docker compose rm -f postgres
docker volume rm hames_postgres_data

# 4. Bring up the NEW image on the empty volume, then restore into it.
git pull                           # the commit that carries the pgvector image (and `docker pull` it)
docker compose up -d --wait postgres
./scripts/migrate-postgres-pgvector.sh restore backups/pgvector-migration/<ts>
#    exit 0 == every table's row count matches the dump. Anything else: stop,
#    do not start the app, see Rollback.

# 5. Start the rest. The first memory call runs CREATE EXTENSION vector itself
#    (memories.server.ts's own ensure); nothing else to do.
docker compose up -d
```

`restore` refuses a Postgres that has no `vector` extension, and refuses a
database that already holds tables — so running it twice, or against the old
image, stops with a message instead of doing anything.

## Rollback

Before step 3 nothing has changed: `docker compose start postgres` brings the
old stack back. After it, the old cluster is in the `_alpine_backup` volume the
script reported. To go back: `git checkout` the previous `docker-compose.yaml`,
remove the new (empty or partial) `hames_postgres_data`, create it again from the
backup volume (`docker run --rm -v <backup>:/from:ro -v hames_postgres_data:/to
postgres:16-alpine sh -c 'cp -a /from/. /to/'`) and start the old image on it.
That is a copy of the cluster under its own collation, so it is consistent.

## When you are done

Keep the dump and the `_alpine_backup` volume until the app has run a few days
on the new image, then delete both **yourself**. Until then they are a plaintext
copy of every memory embedding (the data map's backup row,
[`data-privacy/plan.md`](../data-privacy/plan.md)), on the same disk as the
data.

## Verifying the procedure

The restore path was exercised end to end on a throwaway project holding a
seeded database, never on a real one: dump on `postgres:16-alpine`,
`volume-backup`, fresh volume on the pinned pgvector digest, `restore` (counts
matched, `CREATE EXTENSION vector` then succeeded at 0.8.0). A restore against a
dump whose counts had been altered exited non-zero with the diff; a restore into
a populated database and a `volume-backup` over an existing backup each refused.
Re-run that drill on a scratch compose project after changing the script.
