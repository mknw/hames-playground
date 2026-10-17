# Deployment alerting and external liveness

#432 G20 row 12. The operator chooses the monitoring service, destination and
responders privately (ADR-0008). This checklist does not install an agent,
configure a provider account or authorize a live probe. Measure the actual
deployment before choosing thresholds; the names below are **unassigned
placeholders**, not env variables or recommended numbers.

## External uptime probe

Run the repo's probe from an independent machine or monitoring runner, outside
the deployment's host, Docker network and failure domain. Python 3's standard
library is sufficient; no `.env`, provider credential or Docker daemon is used.
Pass only the public HTTPS origin, with no path, query, fragment or credentials:

```sh
python3 scripts/check-uptime.py https://preview.example.invalid
```

The probe makes one GET to `/api/health`, verifies TLS normally, refuses
redirects and ignores proxy environment settings. It requires HTTP 200 and the
health JSON shape; DNS, TLS, connection, status, body and timeout failures exit
`1`. Success exits `0`. Output is a fixed PASS/FAIL label; no target or exception is
printed. A supervising process enforces a ten-second whole-attempt execution
budget, including DNS resolution, opening, headers and body, and kills and reaps
the attempt if it expires. The socket also has a ten-second blocking-operation
timeout and the response is capped at 4096 bytes. This execution budget is
separate from the measurement-dependent service-level and alert thresholds below.

This proves public DNS/TLS/Caddy/app **liveness only**. The route deliberately
does not query data services or inference (app/src/routes/api/health.ts:1).
It cannot prove sign-in, persistence, the relay, embeddings or private inference.
Never point it at an inference endpoint or use a model completion as an uptime
check; a periodic check must not keep a metered box awake. Verda remains paused.

Configure the independent scheduler to invoke the command at
`<UPTIME_INTERVAL>`, alert after `<UPTIME_FAILURE_WINDOW>`, and recover after
`<UPTIME_RECOVERY_WINDOW>`. Add a missing-run signal at `<MONITOR_STALE_WINDOW>`:
a dead runner must not look healthy. Route to `<ALERT_DESTINATION>`, owned by
`<PRIMARY_RESPONDER>` with `<ESCALATION_WINDOW>` and a backup responder. Record the
selected values privately after measurement. For two published clone hostnames,
configure one target per origin. No scheduler, paging integration or working
off-box monitor is claimed by shipping this command.

## Checklist before enabling alerts

| Signal                          | Measure and wire                                                                                                                                | Unassigned threshold                                              | Response                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| External liveness               | Independent runner exit status, consecutive failures and missing runs; include DNS and certificate failures                                     | `<UPTIME_FAILURE_WINDOW>`, `<MONITOR_STALE_WINDOW>`               | Check public path, then on-box liveness and Caddy/app state                                                     |
| TLS and Entra credential expiry | Certificate remaining lifetime and `AZURE_CLIENT_SECRET` expiry; assign a renewal owner                                                         | `<TLS_RENEWAL_LEAD>`, `<ENTRA_RENEWAL_LEAD>`                      | Check ACME; use [key rotation](secret-rotation.md) before expiry                                                |
| Disk bytes and inodes           | Docker data-root, volumes, model files, logs, build cache and retained upgrade dumps; measure growth during a build                             | `<DISK_FREE_BYTES>`, `<DISK_FREE_INODES>`, `<DISK_GROWTH_WINDOW>` | Halt upgrades/ingests; reclaim reviewed expendable cache only, never data volumes or retained rollback material |
| Memory and swap                 | Host available memory, swap usage, OOM events and per-container RSS/restarts under steady traffic, ingestion and builds                         | `<MEMORY_AVAILABLE>`, `<SWAP_PRESSURE>`, `<OOM_WINDOW>`           | Stop the competing build/dev workload; investigate killed data services; size swap/limits after measurement     |
| Container health                | Health transitions and restart counts for app, Postgres, Neo4j, Redis and embedder; running/exited state for relay, gateway, renderer and Caddy | `<RESTART_WINDOW>`, `<UNHEALTHY_WINDOW>`                          | Inspect privately, then use PREVIEW §8's dependency checks; app liveness alone is insufficient                  |
| CPU embedder                    | RSS, ingest throughput/latency and dimension-check failures                                                                                     | `<EMBEDDER_LATENCY>`, `<EMBEDDER_MEMORY>`                         | Inspect local embedder health and pinned GGUF; no remote provider fallback                                      |
| Logs                            | Rotated log size/retention, collection delivery and collector silence if shipping is enabled                                                    | `<LOG_DISK_BUDGET>`, `<LOG_DELIVERY_WINDOW>`                      | Restore collection; prevent disk exhaustion; redact credentials and user content before export                  |
| Optional backup jobs            | If later enabled: job exit, age of last completed manifest and any `INCOMPLETE` marker, delivered externally even without an MTA                | `<BACKUP_MAX_AGE>`, `<BACKUP_FAILURE_WINDOW>`                     | Treat as failed; repair and run the restore drill; a local marker alone is no off-box alert                     |

Backups and their off-box bucket are deferred by G20 row 9. This checklist adds
no schedule, bucket or log shipping; same-disk pre-upgrade dumps are required by
the [upgrade gate](app-upgrade.md), but do not survive losing the host.
Do not choose memory limits or swap size from an unmeasured example: collect
steady-state, cold-start, embedder-ingest and two-clone/build peaks first.
Container health semantics and limits are in docker-compose.yaml; the existing
backup failure markers are in scripts/backup-preview.sh:128.

Rehearse delivery before relying on the monitor: a synthetic failed target, an
expired/invalid certificate fixture and a stopped runner must each page the
intended responder; recovery must clear the alert. Exercise disk/memory signals
with collector fixtures, not by exhausting the live host. Retain timestamps,
acknowledgment and recovery evidence privately. Repeat after routing changes.
