# Branch-following deploys

Two branches drive two environments. `main` is the integration branch and drives
**DEV**; `release` drives **RELEASE**. Feature branches reach `main` through a pull
request and the full CI gate; `release` only ever takes a commit that is already on
`main`, as a fast-forward. Nothing pushes a deployment: each environment's host
polls its branch and deploys a new head itself, once that commit's checks are green.

| Step                          | Who approves                                     | What happens                                                    |
| ----------------------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| feature branch → `main`       | the owner or the general coordinator, via the PR | DEV deploys the new head on its next poll                       |
| `main` commit → `release`     | the owner only, with `deploy/follow/promote.py`  | RELEASE deploys the new head on its next poll                   |
| a head that needs env changes | DEV applies the mechanical ones; RELEASE asks    | the running version keeps serving while a change is outstanding |

The host needs no GitHub credential and GitHub never reaches the host: the
repository is public, so the poll reads the branch head with `git ls-remote` and the
commit's checks from the unauthenticated REST API. No deploy key lives in Actions.

## One tick

`deploy/follow/deploy-follow.py tick` runs once per timer firing, for one
environment, under a host-wide lock shared by both environments.

1. **Head.** `git ls-remote` reads the branch head. If the environment's checkout is
   already there, the tick ends.
2. **CI.** The commit's check runs from its `push` workflow runs must include every
   required check, each one's latest run completed with `success`. The default list
   is `main`'s ruleset (`typecheck · lint · test · build`, `changeset · version
intent`) plus `docker image · build · boot`, the job that boots the image being
   deployed; the general coordinator keeps the ruleset in step with it.
   `changeset · version intent` runs only on pull requests, so `skipped` is accepted
   for it alone. Runs from a pull request whose head is the same commit are ignored:
   they would otherwise decide a verdict about the pushed commit. RELEASE also
   requires the `release-check` commit status (below). A check that has not reported
   is pending, never green; a red one holds the head until it changes or turns green.
   The config refuses an empty check list, the wrong branch for its environment, and
   a RELEASE config without `release-check`.
3. **Main and fast-forward.** RELEASE fetches `main` and holds a head that is not
   `main`'s head or an ancestor of it, however the branch moved; an error reading
   either fails closed. The new head must also descend from the deployed commit.
4. **Settings.** The target commit's `deploy/follow/env-keys.conf` is compared with
   the key names of the environment's app runtime env file (rules below).
5. **Infra.** Paths that only shared services or separately built images read
   (`configs/Caddyfile*`, the gateway config and catalogs, `docker/`, `rootfs/`,
   `models/`, …) cannot be applied by an app-only deploy. DEV deploys the app and
   journals the paths as not applied; RELEASE holds and asks. The Compose render is
   compared too: if any service other than the environment's app changes definition,
   the head is held. RELEASE, whose checkout is the Compose project, renders both
   commits in a scratch worktree with the live `.env`, so this hold never moves the
   live tree; DEV renders its unchanged project after its own checkout moves, and
   puts everything back on a difference.
6. **Dump.** RELEASE dumps its own Postgres database (`pg_dump --format=custom`,
   checked with `pg_restore --list`) to `<state dir>/dumps/`, mode 0600, before
   anything moves, and keeps the newest `FOLLOW_DUMP_KEEP` (default 5). A failed dump
   holds the head and is retried next tick. A RELEASE config without
   `FOLLOW_DB_NAME` is refused, so the timer cannot run without it.
7. **Deploy.** The running container's image is tagged
   `<image>:follow-rollback-<env>`, an in-flight record is written, the checkout
   moves (DEV also updates `DEV_REF` in the root `.env`; each backup is recorded
   before its file changes). Then `docker compose build <service>` and
   `docker compose up -d --no-deps <service>`. Never a full `up`: that re-runs shared
   one-shots and can recreate shared services.
8. **Health.** The new container must reach `healthy` from the image just built,
   within `FOLLOW_HEALTH_TIMEOUT` (default 600 s). An image without a healthcheck
   is not healthy.
9. **Rollback.** On any failure after the checkout moves (a failed build, health
   check, Compose or Docker error), the env files, the checkout and the image tag are
   restored inline and the service recreated from the previous image, with the real
   reason recorded. The failed head is not retried until a newer head arrives or an
   operator runs `clear`. If the rollback itself is unhealthy, the environment stops
   acting until `clear`.

Every step goes to the systemd journal (with a priority) and to `journal.log` in
the environment's state directory. Neither ever contains an env value: the settings
check reads key names only, and Compose's own error output, which can carry
interpolated values, is never printed.

## The settings rule

The manifest has three kinds of line. Boot validation is what decides which keys
belong in it, and `app/src/__tests__/deploy/env-keys-manifest.test.ts` pins every
line against the code that enforces it.

| Line                | Meaning                                              | DEV                 | RELEASE        |
| ------------------- | ---------------------------------------------------- | ------------------- | -------------- |
| `retired KEY`       | boot refuses while `KEY` is set                      | unsets it, restarts | stops and asks |
| `default KEY VALUE` | `KEY` must be present; `VALUE` is its safe default   | adds it, restarts   | stops and asks |
| `required KEY`      | boot cannot run without it and nothing can invent it | stops and asks      | stops and asks |

A `default` can never name a secret. "Stops and asks" means the head is held, the
reason is journaled at warning priority with key names only, and the old version
keeps serving. A held or failed head is recorded in the journal and in `status`;
the general coordinator reads `status` as part of its routine, and nothing else
notifies anyone. Fix the runtime file by hand and the next tick re-checks it and
proceeds. When a commit retires a key or makes one mandatory, the same commit edits
the manifest.

## Promotion

From a checkout signed in to `git` and `gh` as the owner:

```bash
pnpm release:check                       # from app/, on a clean tree at the commit
deploy/follow/promote.py record-go app/evals/reports/<run>-release-check.md
deploy/follow/promote.py promote <full-sha>
```

`record-go` accepts only a full **GO** report from a clean tree (the report records
its commit) and sets the `release-check` commit status on that commit. `promote`
refuses a commit that is not on `main`, one that `release` does not fast-forward to,
and one whose required checks or `release-check` status are not green; then it asks
for the SHA to be typed and pushes `<sha>:refs/heads/release` without force. The
RELEASE host checks again that the head is on `main`, fast-forwards and has green
checks and a recorded GO before deploying.

`release` is derived from `main` and never diverges from it: there are no fixes made
directly on `release`. A fix lands on `main` first and is then promoted. The branch
does not exist until the first promotion creates it, at a `main` commit and under the
same checks.

The `Release guard` workflow covers the other path: a pull request into `release`
fails its `release · source is main` check unless its head is this repository's
own `main`. It runs on `pull_request_target`, so the workflow file comes from the
base branch and a pull request cannot edit the check into passing; it checks out
nothing and holds no permission. A merged pull request still produces a merge or
rebased commit that is not on `main`, which the RELEASE host holds, and `release`
would then have diverged. The better guard is the ruleset: restrict updates to
`release` to the owner, and do not use the pull-request path at all.

## Install on a host

Per environment, a config file without secrets (see `deploy/follow/example.conf`)
and two systemd units. The script runs from an installed copy, so a commit on a
branch never changes the deployer that deploys it; updating the deployer is an
operator step.

```bash
sudo install -d -m 0755 /usr/local/lib/hames-deploy-follow /etc/hames-deploy-follow
sudo install -d -o <deploy-user> -m 0700 /var/lib/hames-deploy-follow
sudo install -m 0755 deploy/follow/deploy-follow.py /usr/local/lib/hames-deploy-follow/
sudo install -m 0644 deploy/follow/systemd/hames-deploy-follow@.service \
  deploy/follow/systemd/hames-deploy-follow@.timer /etc/systemd/system/
sudo install -m 0644 <dev.conf> /etc/hames-deploy-follow/dev.conf
sudo install -d /etc/systemd/system/hames-deploy-follow@.service.d
printf '[Service]\nUser=<deploy-user>\n' | sudo tee /etc/systemd/system/hames-deploy-follow@.service.d/user.conf
sudo systemctl daemon-reload
sudo systemctl start hames-deploy-follow@dev.service   # one supervised tick
journalctl -u hames-deploy-follow@dev.service
sudo systemctl enable --now hames-deploy-follow@dev.timer
```

The deploy user needs Docker access and write access to its checkout, the runtime
env file and (DEV) the root `.env`. The script refuses to run as root, so without the
`User=` drop-in every tick fails rather than leaving root-owned files in a checkout.
For RELEASE, set `FOLLOW_MANAGED_FILES=configs/mcp-config.yaml` (bootstrap keeps
that file skip-worktree), `FOLLOW_REQUIRED_STATUSES=release-check` and
`FOLLOW_DB_NAME` (its own database). The RELEASE timer is enabled only once that
dump has run: start one supervised tick first and check the `DUMP` line.

**Manual work on the same checkout takes the lock.** The gated upgrade, bootstrap
and any hand edit move the same checkouts and run Compose without the timer knowing.
Either stop both timers first
(`sudo systemctl stop hames-deploy-follow@dev.timer hames-deploy-follow@release.timer`)
or run the work under the same lock: `flock <FOLLOW_LOCK> <command>`.

`deploy-follow.py status --config <file>` prints the recorded state (held or failed
head and why); `clear` forgets a held or failed head so the next tick re-evaluates it.

## Failure modes

- **Red CI.** The head is held and re-checked each tick; a re-run that turns green
  deploys. A newer head replaces it.
- **Failed health check.** Automatic rollback to the previous image and checkout; the
  head is marked failed and not retried.
- **A needed env change.** DEV applies the mechanical ones; RELEASE, and a missing
  required key anywhere, holds with the old version serving.
- **Host reboot.** The timer fires 5 minutes after boot. An in-flight record left by
  an interrupted deploy is rolled back first and the head retried; a head interrupted
  twice is marked failed.
- **Two heads in quick succession.** Ticks never overlap (the interval counts from
  the end of the previous tick, and both environments share one lock). Each tick
  deploys the head it read; a head that lands mid-deploy is picked up next tick, and
  intermediate heads are skipped. CI's own concurrency cancels the older run on
  `main`, which leaves that commit red and unpromotable.
- **Remote access.** The timer uses only outbound HTTPS to GitHub. It does not use,
  need or notice any SSH session to the host.

## What it does not do

- It never restores a dump by itself. RELEASE's dumps are there for an operator;
  image rollback relies on the additive schema
  (`app/src/__tests__/lib/db/schema-additive.test.ts`), and a change that needs more
  is a [gated upgrade](app-upgrade.md), done by hand. DEV takes no dump.
- It never applies infra. A change to a shared service, Caddy, the gateway or the
  sandbox images goes through the [gated upgrade](app-upgrade.md); once the release
  checkout sits at the branch head, the timer has nothing left to do.
- DEV's Compose definition comes from the release checkout (`docker-compose.clones.yaml`
  extends it), so a Compose change on `main` reaches DEV only when it reaches RELEASE.
