# Key rotation

Operator runbook for #432 G20 row 7 (SD-17, SD-18). Use the pinned checkout
and the production Compose overlay. Keep a private change record with key names,
owners, expiry dates and verification results; never record values in tickets,
shell arguments, logs or this public repository. Disable shell tracing and
terminal recording; use a protected editor or secret manager, never `printenv`,
`cat .env` or a rendered Compose config on screen. Keep files mode 0600.

Before a rotation, stop ingress and every affected writer, including `app-dev`
when enabled, routines and unattended clients. Confirm the separate key escrow
([PREVIEW §7](../PREVIEW.md#7-escrow-the-three-keys--do-this-now-not-later)) and
take the [local pre-change dumps](app-upgrade.md). Keep the old value in protected
escrow until the rollback window closes; a leaked credential must be revoked,
not restored to service. Coordinate every consumer before restarting. With two
clones, edit each affected app-only runtime file as well as root Compose inputs;
never copy one clone's independent application keys into the other.

After any of the three application keys changes, escrow the new key set and
re-attest it with bootstrap's `--only env --keys-escrowed` stage, using the same
hostname and ACME arguments as the deployment. The marker hashes the current
three root keys for a single app, or all six keys from both app-only runtime
files in clone mode; an old attestation cannot unlock boot after any runtime key
changes (`scripts/bootstrap-vps.sh`, `keys_fingerprint` / `escrow_recorded`). Keep
a separate escrow record for each clone's key set. Boot also requires the
owner-supplied settings in each runtime file. Recreate containers to load changed environments; `restart` retains the old
environment. For **every manual clone-enabled recreate**, including rollback, use PREVIEW
§12's preflight below with the deployment's production/clone Compose files and
profile. Bootstrap now reads that complete ordered file list from the release
checkout's root `.env` and runs the validator itself before clone operations;
`--only boot` preserves both apps and never orphan-prunes in clone mode. A failed render or validator must
prevent startup: keep `set -o pipefail` and connect validation to the recreate
(or bootstrap `boot` command with its existing arguments) using `&&`. Never save
or print rendered configuration; pipe it directly to the validator.

```bash
set -o pipefail
docker compose config --format json |
  docker run --rm -i --network none --read-only --cap-drop ALL --entrypoint node \
    -v "$PWD":"$PWD":ro -v "$DEV_CLONE_PATH":"$DEV_CLONE_PATH":ro \
    hames-app:local "$PWD/scripts/validate-clones.mjs" &&
  docker compose up -d --no-build --force-recreate app app-dev
```

The validator runs inside the release app image: mount the §12 dev checkout
path from `.env` at its own path as shown (and each `*_SANDBOX_DOCKER_TLS_*`
file the same way when a VM overlay is selected); the host needs no Node
(#681). A missing image refuses until `--only images` builds it.

After recreation, bootstrap `--only smoke --no-seed` also compares both running
clone environments with the validated config and checks their limited Postgres
roles with read-only TCP logins. Repeat browser authentication checks for each
hostname; this does not replace the §12 cross-database grant checks.

For a single app, keep the existing `docker compose up -d --no-build
--force-recreate app` procedure. Finish with the affected checks below and
[PREVIEW §8](../PREVIEW.md#8-smoke-checklist).

## AUTH_SESSION_SECRET

Generate a new independent secret in the secret manager and replace
`AUTH_SESSION_SECRET` in the affected runtime file. Recreate that app and test a
fresh sign-in, denied allow-list account and sign-out. In-flight OAuth handshakes
must restart: this key signs that short-lived cookie
(app/src/lib/auth/cookie-signing.server.ts:33). **Changing it does not revoke
durable sessions**: their cookies are opaque database IDs
(app/src/lib/auth/session-store.server.ts:145). For a compromise requiring global
logout, stop the app and explicitly delete `auth_sessions` rows in its database
through a private administrator session before reopening ingress. Repeat for
each affected database. Preserve `DATA_ENCRYPTION_KEY` throughout.

Set `TOKEN_ENCRYPTION_KEY` explicitly before rotating this key. If it was unset,
the token cache used a derivation of the old session secret; switching keys
then costs reauthentication too (app/src/lib/auth/secret-crypto.server.ts:40).
Rollback restores the previous secret and recreates the app, but deleted
sessions stay deleted and users must sign in again.

## TOKEN_ENCRYPTION_KEY

Replace `TOKEN_ENCRYPTION_KEY` with an independent generated secret, escrow and
recreate the affected app. Old caches become unreadable and are treated as
absent (app/src/lib/auth/user-tokens.server.ts:87); require every affected user
to sign in again, then verify a delegated connector operation and any background
routine before resuming it. A still-valid browser session alone does not refresh
the durable token cache. Never rotate `DATA_ENCRYPTION_KEY` with it.

For suspected token theft, revoke affected Microsoft sessions/refresh tokens
at the identity provider too: changing the encryption key cannot revoke a token
already copied by an attacker. Rollback must restore the matching pre-change
cache dump and old key while writers are stopped; once new caches exist, simply
restoring the old key makes those new rows unreadable.

## DATA_ENCRYPTION_KEY — WAIT for the re-encrypt tool

There is **no supported in-place rotation**. Keep `DATA_ENCRYPTION_KEY` unchanged
and separately escrowed. A different or missing key fails reads instead of
recovering content (app/src/lib/db/crypto.server.ts:208). The re-encrypt tool
is deferred by G20; this step does not build it. If compromised, stop access,
preserve the matching dumps/key and escalate for an owner-approved migration
plan. Do not generate a replacement over existing rows, delete volumes, or
assume the `v1.` envelope provides a key ring. Resume only after a separately
reviewed migration/restore drill. A disposable reset requires explicit acceptance
of data loss and is not a rotation procedure.

## POSTGRES_PASSWORD and clone database credentials

Changing `POSTGRES_PASSWORD` in `.env` changes client configuration, not an
existing database role's password (docker-compose.prod.yaml:51). With writers
stopped, open an interactive administrator session:

```sh
docker compose exec postgres psql -U postgres -d postgres
```

Use [psql's password prompt](https://www.postgresql.org/docs/16/app-psql.html)
(`\password postgres`) to set the new administrator password;
never put a password in SQL text or command arguments. Update the root
`POSTGRES_PASSWORD` securely (keep the URL-safe format bootstrap requires),
then recreate `postgres` and the single-clone `app` without rebuilding data
volumes. With the separate database/role policy enabled, rotate each affected
role with `\password` and update the matching `RELEASE_DATABASE_URL` or
`DEV_DATABASE_URL`; the administrator password is not an app credential there
(docker-compose.clones.yaml:16). Recreate affected apps, verify a fresh TCP
password login for each role without printing the URL, then sign in and persist
and reload a synthetic conversation. Local socket access alone proves no
password. For rollback, change the role back through the same protected prompt,
restore its matching configuration and recreate consumers; never reset a volume.

## NEO4J_PASSWORD

`NEO4J_PASSWORD` feeds initial `NEO4J_AUTH` and the app/gateway clients; editing
it alone does not change an existing store (docker-compose.yaml:27). Keep both
apps and the gateway stopped. Run
`docker compose exec neo4j cypher-shell -u neo4j --change-password`
and enter the old and new passwords at its hidden prompts. The
[Cypher Shell password-change option](https://neo4j.com/docs/operations-manual/current/cypher-shell/)
exits after changing the password. Update the root input securely;
do not use `-p` or an `ALTER ... PASSWORD` command containing literal secrets.
Recreate `neo4j`, rerun the `mcp-config` one-shot renderer, then recreate
`mcp-gateway` and both affected apps, in dependency order. Verify the relay
round trip and tool surface with bootstrap `--only smoke --no-seed`, then a
graph read in each app. Restore both the database password and all consumer
settings together if rolling back. Keep the graph volume.

## AZURE_CLIENT_SECRET

Track `AZURE_CLIENT_SECRET` expiry and renewal ownership outside the repo.
Create an overlapping replacement in the same Entra app registration, store its
**value** privately and update every runtime file using that registration.
Recreate affected apps; test fresh sign-in/callback, sign-out and a delegated
connector call on each hostname. Revoke the old credential only after success;
on failure before revocation, restore the previous value and recreate. After
revocation, issue another replacement rather than restoring a revoked secret.
Source: app/src/lib/auth/entra-config.server.ts:113.

## ANTHROPIC_API_KEY

Issue an overlapping `ANTHROPIC_API_KEY`, update affected runtime files and
recreate apps. Verify a synthetic Anthropic-tier turn only in an authorized live
window, then revoke the old provider key. Record failure without switching a
private conversation to a public provider. Before revocation, rollback restores
the old value and recreates; afterwards, issue a new credential. No live check
is authorized by this document. Source: packages/harness-baml/baml_src/clients.baml:15.

## LARGE_LLM_API_KEY

The variable name `LARGE_LLM_API_KEY` survives a provider change; rotate
it at the operator's current private chat endpoint, then update all affected app
runtime files and recreate them. If overlapping keys are supported, verify the
replacement before revocation; otherwise keep ingress closed throughout cutover.
Check a synthetic private-tier turn in an authorized live window, with no public
fallback. Rollback coordinates endpoint and consumers together. **Verda is
paused: never wake or probe it.** Deferred verification means the rotation is
unverified, not passed. Source: packages/harness-baml/baml_src/large-client.baml:178.

## SMALL_LLM_API_KEY

Rotate `SMALL_LLM_API_KEY` at **both** the summarizer (`SMALL_LLM_BASE_URL`) and
systemone (`SMALL_LLM_DECISIONS_URL`) services, then every affected app runtime
file. Recreate apps and, only in an authorized window, check the opt-in private
health probe, a describe result and a private systemone decision. One endpoint
working is insufficient. Revoke the old key at both services after success;
rollback before revocation restores both services and consumers together.
Never verify against paused infrastructure. Sources:
packages/harness-baml/jev-decide.server.ts:326 and
scripts/check-vps.py:213.

## Optional credentials and credentials not shipped

- `JEV_DECISIONS_API_KEY`: rotate at the configured Anthropic-tier decisions
  provider, update/recreate consumers, verify a synthetic decision in an
  authorized window, then revoke the old key. Keep `JEV_DECISIONS_URL` and
  provider key issuance matched; no fallback provider is implied. Roll back
  before revocation by restoring the previous value and recreating
  (packages/harness-baml/jev-decide.server.ts:326).
- `OPENROUTER_API_KEY`: unused while boot refuses that embedding backend.
  Rotate at its provider, update/recreate consumers, verify a synthetic embedding
  in an authorized window and revoke the old key. Do not change embedding space
  as part of rotation. Roll back before revocation using the old key
  (packages/harness-patterns/stash/embeddings.server.ts:145).
- `EMBEDDINGS_LOCAL_API_KEY`: stock CPU embedder needs none. For an explicitly
  configured authenticated endpoint, rotate the server credential and every
  consumer together, recreate apps, verify a synthetic embedding in an
  authorized window and retire the old key. Keep model/dimensions unchanged;
  before revocation, restore both server and consumer settings on rollback
  (packages/harness-patterns/stash/embeddings.server.ts:138).
- `REDIS_PWD`: stock Compose has no Redis password. If an operator adds one,
  coordinate its server-side ACL/configuration and all Redis consumers during
  downtime, verify authenticated stash upload/download, then retire the old
  credential. Restore server and clients together on rollback. This repo ships
  no Redis ACL rotation automation (docker-compose.yaml:188).
- **Gateway token: WAIT**, tracked by #392/#417; no token is shipped by the
  current gateway. Do not invent a gateway-token env setting. Rotate only after
  that authentication mechanism and its consumer contract land. Current gateway
  command: docker-compose.prod.yaml:109.
- Unattended action-token maps are refused by bootstrap smoke; do not enable
  one as a rotation workaround (scripts/bootstrap-vps.sh:1739).

These optional provider paths use the same overlap/verify/revoke order. A revoked
or leaked credential is never a rollback target. SSH access keys and provider
account recovery remain the operator's separate access runbook.
