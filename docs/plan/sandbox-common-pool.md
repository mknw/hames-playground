# Common-pool sandbox VM mode (Design note)

> **Status: Not built; no build until the owner reads this.** Design only, for [#648](https://github.com/mknw/hames-playground/issues/648) Q6 as the owner answered it ([comment 6269961143](https://github.com/mknw/hames-playground/issues/648#issuecomment-6269961143)): per-environment VMs, plus a **common-pool** mode with one VM for both environments and a broker inside it, chosen by a setting. Q3 (gVisor) is still open and appears here only as options. Nothing was run against Docker, Incus or any host. Every `file:line` refers to `main` at `a95aa44b`. SD-19, SD-20 and SD-21 apply. The posture described below comes from the source, not from the brief, which is stale on these points ([#648 §6 finding 2](https://github.com/mknw/hames-playground/issues/648)).

## The decision in one paragraph

The setting is `SANDBOX_VM_MODE`, with the values `per-env` (the default) and `common-pool`. It belongs to the operator-side provisioner in `@hames-ai/sandbox`. The app never reads it.

- **`per-env`** is what `createIncusEnvironment` builds today: one restricted Incus project and one VM per environment. The VM's dockerd listens on TLS, and the app holds root inside its own environment's VM.
- **`common-pool`** builds one project and one VM for both environments. dockerd inside that VM listens only on a unix socket, and only the broker can reach it. The broker is a small Go service, built from a pinned, reviewed commit. It terminates one mTLS client identity per environment and accepts only the six operations from #648 §1. Each environment's labels, name prefix, quotas and image allowlist come from that identity.

The app's code path does not change in either mode: the same four `SANDBOX_DOCKER_*` settings point either at a VM's dockerd or at the broker. The cost of common-pool is stated plainly in [§2](#blast-radius-stated-plainly): **a broker bug, or root inside the shared VM, crosses environments.** Per-env has no such crossing, because a VM boundary separates the environments.

## 1. The setting

| Item           | Value                                                                                                                                                                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Name           | `SANDBOX_VM_MODE` (operator environment) → `mode` option on the provisioner                                                                                                                                                                                                                                              |
| Values         | `per-env` \| `common-pool`; anything else is refused before any Incus request                                                                                                                                                                                                                                            |
| Default        | `per-env`. An absent value keeps today's behaviour byte-for-byte.                                                                                                                                                                                                                                                        |
| Where it lives | The type and default go beside `DEFAULT_SANDBOX_SETTINGS` in `packages/sandbox/settings.ts` (`SANDBOX_VM_MODES`, `SandboxVmMode`, `DEFAULT_SANDBOX_VM_MODE`). That module is the package's client-safe settings module (`settings.ts:15-18`). The consumer is `createIncusEnvironment` in `incus-environment.server.ts`. |
| Who reads it   | The operator process that calls the provisioner, never the app. Compose passes the resulting endpoint settings through to the app (§4.3).                                                                                                                                                                                |

**Why the app does not read it.** The mode decides how strongly the environments are isolated. If the app could select the mode, it could select the weaker one. The four settings the app does read are mode-agnostic by construction: the CLI cannot tell a VM's dockerd from the broker, and that is the point.

**What each value provisions:**

|                          | `per-env` (today, `incus-environment.server.ts:173-732`)                                                                 | `common-pool` (proposed)                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Incus project            | `sandbox-<environment>`, one per environment (`:199`)                                                                    | `sandbox-pool`, one in total. The environment slug `pool` is refused in both modes, so the two project names cannot collide. |
| VMs                      | one per project (`'limits.virtual-machines': '1'`, `:418`)                                                               | one, under the same restrictions (`restrictions()`, `:409-440`)                                                              |
| dockerd listener         | `tcp://<guest address>:2376` with `tlsverify` and no unix socket (`:494-501`, pinned by `incus-environment.test.ts:558`) | `unix:///run/docker.sock` only. The socket is owned by root and not shared with any group. There is no TCP listener.         |
| TLS listener             | dockerd                                                                                                                  | the broker, on the same guest address and port                                                                               |
| Credentials              | one CA, one server leaf and **one** client leaf per environment (`:372-404`)                                             | one pool CA, one broker server leaf, and **one client leaf per environment** (`client-<env>.pem`, CN `sandbox-<env>`)        |
| Returned to the operator | one `dockerEnv` (`:678-685`)                                                                                             | one `dockerEnv` per environment, each naming only that environment's client key                                              |

## 2. Topology in each mode

```
per-env                                     common-pool
app (release) ──mTLS──▶ VM release:dockerd  app (release) ──mTLS id=release──┐
app (dev)     ──mTLS──▶ VM dev:dockerd      app (dev)     ──mTLS id=dev─────┤
                                                                            ▼
                                                     VM pool: broker ──unix──▶ dockerd
```

|                           | `per-env`                                                                                                                                                                       | `common-pool`                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What the app holds        | A client certificate that dockerd accepts. That is **root inside its own environment's VM**: any create body, any bind of the guest filesystem, `--privileged` (README `:307`). | A client certificate that only the broker accepts. That is **the six operations, on boxes labelled with its own environment**, under the forced posture in §3. It is narrower than per-env.                                        |
| Who holds dockerd         | each app, over TCP                                                                                                                                                              | the broker only, over the unix socket. Sandbox containers get no socket, because the rebuilt create body has no binds (§3.2).                                                                                                      |
| Between environments      | separate VMs, and separate CAs in separate state directories                                                                                                                    | one guest kernel and one dockerd. Separation comes from the broker's identity map and the runc boundary (or gVisor, §7). Both apps reach the same TCP endpoint, so network rules cannot separate them; the certificate alone does. |
| Shared regardless of mode | the data tier: Neo4j, Redis stash keys and the gateway memory volume (`docs/PREVIEW.md:1300-1302`), and the gateway's own host socket (`docker-compose.yaml:132`)               | same                                                                                                                                                                                                                               |

### Blast radius, stated plainly

- **Per-env.** A compromised app, or code escaping a box, gets root in **that environment's VM**. That reaches only that environment's boxes, whose data the app can already read through its own stash. The other environment sits behind a VM boundary.
- **Common-pool.** A compromised app gets only what the broker allows. That is less than per-env grants, **provided the broker is correct**. But two failures cross environments:
  1. **A broker bug.** A field the rebuild lets through, an ownership check that is skipped, or an exec id that is not bound to its creator would let dev act on release boxes, or start a container that is root in the shared VM.
  2. **Root in the shared VM.** A runc escape from any box lands next to both environments' boxes, their `/work` tmpfs contents, their live exec streams, dockerd and the broker's server key. The client keys stay with the operator and the apps; the VM never holds them.
- So common-pool trades a VM boundary between environments for a narrower per-app capability, plus one VM's overhead saved. That saving is unmeasured: the only figure is a bare-metal forum report cited in #648 comment F. **Choose common-pool only where a dev compromise reaching release boxes is acceptable, or once gVisor is forced (§7).**

## 3. Broker contract

v1 accepts exactly #648 §1 rows 1-6. Rows 7-9 (networks, egress proxy, cache volume) are refused, because every sandbox route pins `egress: 'mcp-only'` (`packages/agents/agents/sandbox.server.ts:200,213,221`; `general-next.server.ts:102`). That profile maps to `--network none` (`docker-backend.server.ts:670-671`).

### 3.1 Allowed requests

| Row | CLI (source)                                                                                                          | Engine API accepted                                                                                 | Broker action                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | `run -d --rm --name sbx-<8 hex>` (`docker-backend.server.ts:629`)                                                     | `POST /containers/create`, `POST /containers/{id}/start`                                            | create: rebuild (§3.2). start: ownership check (§3.3).                               |
| 2   | `rm -f <id>…` (`:484-493`, `:608-615`, `:563`)                                                                        | `DELETE /containers/{id}?force=1`                                                                   | ownership check; `v=1` and `link=1` refused                                          |
| 3   | `inspect -f {{.State.Status}}` (`:596-606`)                                                                           | `GET /containers/{id}/json`                                                                         | ownership check; responds with a reduced body (`Id`, `Name`, `State`)                |
| 4   | `exec -i <id> /opt/mcp/init.sh serve …` (`:304-317`; `types.ts:212,223`)                                              | `POST /containers/{id}/exec`, `POST /exec/{id}/start` (upgraded), `GET /exec/{id}/json` (exit code) | §3.4                                                                                 |
| 5   | `exec -it <id> bash` (`pty-manager.server.ts:161-166`)                                                                | as row 4, plus `POST /exec/{id}/resize`                                                             | §3.4                                                                                 |
| 6   | `ps -aq --filter label=kg-sandbox=1 --filter label=kg-sandbox-environment=<env>` (`docker-backend.server.ts:542-552`) | `GET /containers/json?all=1&filters=…`                                                              | filters replaced (§3.3)                                                              |
| —   | version negotiation                                                                                                   | `GET`/`HEAD /_ping`                                                                                 | answered by the broker itself, with its pinned API version; dockerd is not contacted |

Requests are accepted only under the broker's pinned `/v1.NN/` prefix. The exact request set the CLI sends for each row is still unrecorded (#648 §7). The layer-1 CLI-contract test in §6 records it.

### 3.2 Create: rebuild, not filter

The broker decodes the create request into a typed struct with **unknown fields refused at any depth**. It then builds a fresh body from that struct and sends only the fresh body. It never forwards the client's bytes. **Write it in Go.** dockerd decodes with Go `encoding/json`, which matches field names case-insensitively, so a check written in another language can read `hostconfig.privileged` differently from the daemon (#648 §3). With the same decoder on both sides, that mismatch cannot arise.

| Field                                      | Rebuilt value                                                                                                                                                                                                                                    | Today's source of the value                                                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Image`                                    | The client's tag must be exactly one of `kg-sandbox:{base,data,office,image-processing}` in **this identity's** allowlist. It is replaced by the pinned config ID recorded for that identity. Digests, registries and case variants are refused. | `imageForRootfs` (`:850-855`). `SANDBOX_IMAGE` can override the base tag (`:60`), so a non-allowlisted override is refused.                                                              |
| `CapDrop`, `ReadonlyRootfs`, `SecurityOpt` | `["ALL"]`, `true`, `["no-new-privileges"]` plus the broker's own seccomp profile, if one is configured                                                                                                                                           | `hardeningArgs` (`:80-113`). A client `seccomp=`/`apparmor=` value (`:108-111`) is **refused rather than ignored**, so `unconfined` cannot be sent and a misconfigured app fails loudly. |
| `PidsLimit`, `Tmpfs`                       | the client's value only if it is ≤ the per-box ceiling, else refused; `Tmpfs` must be exactly the `/tmp`, `/work` and `/skills` set with today's options                                                                                         | `:87-88`, `:93-106`                                                                                                                                                                      |
| `Memory`, `MemorySwap`                     | required and ≤ the ceiling; `MemorySwap = Memory`                                                                                                                                                                                                | `:633`; default 512 MB (`settings.ts:68`)                                                                                                                                                |
| `NanoCpus`                                 | the client's value if it is ≤ the ceiling, else the broker's default. A box always gets a CPU limit, because the app never sets one by default.                                                                                                  | `:632`; `with-sandbox.server.ts:447` passes `cpus` through unset                                                                                                                         |
| `NetworkMode`, `AutoRemove`                | `none`, `true`                                                                                                                                                                                                                                   | `:629`, `:670-671`                                                                                                                                                                       |
| `Labels`                                   | `kg-sandbox=1`, `kg-sandbox-environment=<identity>`, `kg-sandbox-id=<client name>`                                                                                                                                                               | `:698-704`                                                                                                                                                                               |
| name                                       | `<identity>-<client name>`; the client name must match `^sbx-[0-9a-f]{8}$`                                                                                                                                                                       | `:473`                                                                                                                                                                                   |
| `Runtime`                                  | absent, or `runsc` if Q3 lands (§7). The client's value is refused.                                                                                                                                                                              | none                                                                                                                                                                                     |
| anything else                              | absent: no `Binds`, `Mounts`, `Privileged`, `CapAdd`, `Devices`, `DeviceRequests`, host or `container:` PID/IPC/UTS/user/cgroup namespaces, `PortBindings`, `Sysctls`, `VolumesFrom`, `Env`, `Cmd`, `Entrypoint` or `User`                       | the app sends none of these on `mcp-only` (`:629-706`)                                                                                                                                   |

### 3.3 Identity, labels, names and ownership

- **Identity comes only from the certificate.** The certificate must chain to the pool CA, **and** its SHA-256 fingerprint must appear in the broker's identity map. The map value is the environment. The broker does not use the CN, any header or any label as the identity.
- **The environment label is forced.** If the client's `kg-sandbox-environment` label, or its list filter, names a different environment, the request is **refused, not rewritten**. An app whose `SANDBOX_ENVIRONMENT` disagrees with its certificate therefore fails at its first boot, instead of running under a label it does not know about (`docker-backend.server.ts:458-465`).
- **The name prefix** stops one environment squatting another's names, which would block the other's boots with name conflicts. The app is unaffected: it addresses boxes by the id that `run` returns (`:474`) and reuses the client name on reset (`:616`).
- **Ownership check** on start, exec, inspect and delete: the broker first inspects the target over the unix socket. It requires `kg-sandbox=1`, the identity's environment label and the identity's name prefix. On any mismatch it answers **404**, sends nothing on to dockerd, and does not confirm that the box exists.
- **List.** The broker discards the client's filters and applies `label=kg-sandbox=1` and `label=kg-sandbox-environment=<identity>` itself. This turns the reaper's environment label into a boundary, where today it only prevents accidental cleanup (README `:384-385`; `docs/PREVIEW.md:1311-1312`).

### 3.4 Exec and upgraded streams

- **Exec create.** The ownership check runs first. Then the broker rebuilds the body: `AttachStdin/Stdout/Stderr`, `Tty` and `Cmd` only, with `Privileged: false` and **no `User`**, so the exec runs as the image's `USER sandbox` (`rootfs/Dockerfile:103`). A request with `Privileged`, `User`, `Env` or `WorkingDir` set is refused. `Cmd` is not allowlisted, because the box runs arbitrary agent code by design. What exec must not do is escape the image user.
- **Exec ids are daemon-global.** The broker records exec id → identity at create, and refuses start, resize or inspect of an exec id it did not record for that identity (404). After a broker restart the map is empty, so an exec stream that was in flight must be re-opened. The app already re-opens transports on a new attachment.
- **Upgraded connections.** `exec start` is answered with `101`, and the broker then proxies the hijacked raw stream in both directions. It honours half-close (`CloseWrite`), so stdin EOF reaches the box, and it tears the stream down when either side closes or the box is deleted. Resize is an ordinary POST.

### 3.5 Per-environment quotas

The broker holds four ceilings per identity: **live box count, Σ `Memory`, Σ `NanoCpus`, Σ `PidsLimit`**. It also holds per-box ceilings for the fields in §3.2. tmpfs pages are charged to the container's memory cgroup, so `Memory` also bounds `/work`.

- **Counting.** Usage is counted from dockerd's own state (a label-filtered list) under a per-identity lock at each create. A broker restart therefore cannot reset the counts, and concurrent creates cannot overshoot.
- **Refusals.** A create over quota is **refused**, not queued. The app sees `SandboxBootError` (`docker-backend.server.ts:710-717`). The quota must therefore cover the app's own bounds. In-flight boxes are capped at `globalCap` 16 (`settings.ts:56`). Parked attachments are capped separately at `maxAttachments` 8 (`settings.ts:61`) and hold no scheduler slot (`attachment-table.server.ts:213-216`). The pool's parked boxes are capped at the sum of the `warmPool` caps, 4 (`settings.ts:62`). The Shell path acquires without the scheduler (`pty-manager.server.ts:144`). No single app-side number bounds the live boxes, so the broker quota is the only hard per-environment count.
- **Starvation.** Dev cannot starve release, because the partition is static: at load, the broker refuses any configuration in which Σ of the environment quotas plus a fixed reserve for dockerd and the broker exceeds the VM's CPU and memory. Whether to allow bursting instead is open question CP2.

### 3.6 Refused

Everything not listed in §3.1 is refused with 403, or with 404 for object lookups, and nothing reaches dockerd. That includes:

- `/images/*` (pull, build, load, tag, inspect, remove) and `/build`. When an image is missing, `docker run` pulls it, so that request is refused too.
- `/containers/{id}/archive` (cp), `/commit`, `/attach`, `/logs`, `/export`, `/top`, `/stats`, `/changes`, `/events`.
- `/containers/{id}/update`, which would lift memory and pids limits after create.
- `/rename`, `/pause`, `/kill`, `/restart`, `/stop`, and every `/prune`. The reaper's `network prune` (`:571-581`) is refused, which is harmless: its failure is swallowed (`:591`).
- `/networks/*`, `/volumes/*`, `/info`, `/system/*`, `/auth`, swarm, plugins, secrets, configs and session.
- A generic `inspect` falls back to image and network lookups for a missing id. The broker answers those with 404, which `health()` already reads as `gone` (`:602-605`).

### 3.7 Failure policy

**Fail closed everywhere, with no silent clamping.** When the broker is down, every sandbox operation fails; the connection never retries against another endpoint (README `:209-210`). Unknown fields, out-of-ceiling values, an environment mismatch, a refused route or an exceeded quota each produce a named error and an audit line (identity, route, reason, and never a body). A value is never quietly lowered to fit. A box that runs with a weaker posture than the app asked for is the silent degradation SD-19 warns about.

### 3.8 Build and provenance

- **Source.** The broker source goes in `packages/sandbox/broker/`, a Go module. It stays outside the npm tarball, which ships only `*.ts` (`packages/sandbox/package.json` `files`), the same way `scripts/vm-image/` does.
- **Pinning.** The binary is built from a pinned, reviewed commit and enters the VM image as a hashed input in the image lock, next to the flavours (`scripts/vm-image/README.md`, "Local lock schema"). The Incus image fingerprint therefore covers it. It is **never built from the dev checkout**.
- **Where the policy lives.** The parts fixed at image-build time are baked into the image: the binary, its systemd unit, and each tag's config ID. Note that the lock today carries `base`, `data` and `office`, but not `image-processing`. The per-provisioning parts arrive by cloud-init, as `daemon.json` does today (`incus-environment.server.ts:475-523`): the listen address, the TLS material, the identity map and the quotas.

## 4. How the existing code reaches it

### 4.1 App side: no code change

- **The trap.** The MCP SDK passes the exec child only an allowlisted environment, so `DOCKER_HOST` never reached row 4 (#648 §1).
- **How #651 solved it.** The fix used argv flags, **not a Docker context**:
  - `dockerConnectionFromEnv` turns the four `SANDBOX_DOCKER_*` settings into `--host`, `--tlsverify` and the three file flags (`docker-connection.server.ts:16-71`).
  - `dockerInvocation` prepends those flags to every child's argv, and strips `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_TLS`, `DOCKER_TLS_VERIFY` and `DOCKER_CERT_PATH` from the child's environment (`:74-94`). The MCP streams keep the SDK allowlist (`docker-backend.server.ts:317`), and the flags travel in argv.
  - The backend captures the connection once (`:444-447`), and the PTY reuses the handle's copy (`pty-manager.server.ts:158-166`).
- **Common-pool** is therefore four values: the broker address and this environment's CA, client certificate and key. A restart applies them (README `:215-217`).
- **App settings that become refusals in common-pool.** The broker owns these, so a non-default value now fails loudly, where per-env would accept it: `SANDBOX_SECCOMP_PROFILE` and `SANDBOX_APPARMOR_PROFILE`, any `SANDBOX_PIDS_LIMIT` or `SANDBOX_WORK_TMPFS_MB` above the ceiling, a `SANDBOX_IMAGE` outside the allowlist, and a `SANDBOX_ENVIRONMENT` that differs from the certificate's identity.

### 4.2 Provisioner: what changes in `incus-environment.server.ts`

**Changes**, all behind `mode: 'common-pool'`:

- **Options.** The options become a discriminated union. Common-pool takes `environments: [{ name, quota: { boxes, memoryMiB, cpu, pids } }]` (at least two distinct slugs, `pool` refused) in place of the single `environment`. The project name becomes `sandbox-pool`. `binding` (`:201-209`) gains `mode` and the environment list, so a state directory written by one mode is refused by the other.
- **Credentials.** `credentials()` (`:334-407`) issues one client leaf per environment in place of the single `client` role at `:372`.
- **Cloud-init.** `cloudConfig()` (`:475-523`) writes `daemon.json` with `hosts: ["unix:///run/docker.sock"]` and no TLS keys. It adds the broker's configuration and enables its unit. The Docker server leaf becomes the broker's.
- **Return value.** `reconcile()` returns `connections: Record<env, dockerEnv>`. Each entry is validated through `dockerConnectionFromEnv`, as at `:684`, and each names only its own key. Per-env keeps its `dockerEnv`, so existing callers are unchanged.
- **Teardown.** Teardown removes every client leaf. Its file sweep (`:727-728`) already matches them.

**Stays as it is:**

- every project restriction (`:409-440`) and the ownership checks (`:441-474`);
- the bridge and address checks (`:528-546`), NIC MAC/IP filtering (`:590-601`) and seeding by MAC (`:636-670`);
- the operation journal (`:225-292`), `exclusive` (`:213-224`), the image-server and port checks (`:176-189`), and the teardown order (`:687-730`);
- `limits.virtual-machines: 1`. The manager and project certificates never reach an app (README `:307-311`).

### 4.3 Compose and the clone validator

These apply to **both** modes before either can reach the two-clone deployment.

- **The current overlay is single-app.** `docker-compose.sandbox-vm.yaml` defines only `app` (`:4-15`).
- **The validator refuses it.** The clone validator refuses any bind other than `/configs` and the socket (`scripts/validate-clones.mjs:28-36`), and therefore refuses that overlay's three TLS file binds. Checked against a synthetic config: it throws `No checkout or runtime env bind mounts`.

The proposal is one clones-aware overlay. It sets the four settings for both `app` and `app-dev`, and declares `x-sandbox-vm-mode: per-env | common-pool` the same way `x-clone-dev-docker-socket` is declared (`docker-compose.clones.yaml:15`). The validator reads that declaration and nothing in the app does. Owner answer Q2 (comment 6269961143) says the release app keeps its host socket until its VM lands. Under per-env, release can move on its own. Under common-pool, release loses the socket at the same cutover as dev.

## 5. Switching modes

A mode switch is a cutover, not a live migration. Box state is tmpfs, and the attachment table, pool and scheduler are per-process singletons (`with-sandbox.server.ts:217-221`).

1. **Provision the target topology alongside the current one.** The project names differ (`sandbox-<env>` against `sandbox-pool`), so both can exist together. The host needs capacity for both.
2. **Drain sandbox turns, then repoint and restart each app.** Its four settings change. Durable files live in the stash (`settings.ts:63-65`), so only an in-flight turn's unpromoted `/work/out` is lost, as with any restart.
3. **The reaper runs once per process, against the new endpoint** (`with-sandbox.server.ts:223-258`). It never sees boxes left in the old VM. Those go when the old topology is torn down: `teardown()` deletes the VM (`incus-environment.server.ts:699-711`).
4. **Credentials do not carry over.** A per-env leaf chains to its own environment's CA, which is neither the pool CA nor in the identity map, so the broker refuses it. Old leaves stop meaning anything once their dockerd is gone. Teardown deletes their files.
5. **Labels are unchanged** (`kg-sandbox-environment=<env>`). The warm pool starts empty in the new process and refills by parking released boxes. `prewarm` has no production caller. In common-pool, parked boxes count against that environment's quota (§3.5).
6. **The reverse switch (common-pool → per-env)** is the same procedure. A transient mixed state, with one environment per-env and the other in the pool, works technically, but the validator's `x-sandbox-vm-mode` must describe it truthfully. Leaving that state for long would mean running under two modes, so this note does not propose making it a supported value.

## 6. Pins and tests

The house rule applies: each pin ships with the mutation that turns it red. Layer 1 is the only merge gate. The CI job runs the sandbox package suite with its coverage floor (`.github/workflows/ci.yml:210-212`) and the app suite. Python script tests run with `--mutations` (`ci.yml:88-93`). The VM-image tests (`build.test.py`, with `--mutations`) already run there, through the package suite's `__tests__/scripts/vm-image.test.ts`.

| #   | Pin                                                                                                                                                                                                                                           | Layer and suite                                                                               | Mutation that reddens it                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| P1  | The default mode is `per-env`, and unknown modes are refused before any request                                                                                                                                                               | 1, `packages/sandbox/__tests__/incus-environment.test.ts`                                     | default to `common-pool`; accept `'pool'`                   |
| P2  | In common-pool, `daemon.json` has the unix socket only, with no `tcp` host and no TLS keys. This is the inverse of the current `:558` test.                                                                                                   | 1, same                                                                                       | add `tcp://…:2376` to `hosts`                               |
| P3  | The broker identity map has exactly one fingerprint per environment, each equal to that environment's generated leaf                                                                                                                          | 1, same                                                                                       | map both leaves to `release`; swap them                     |
| P4  | Each returned `dockerEnv` names only its own key, and no path names another environment's                                                                                                                                                     | 1, same                                                                                       | return dev's key for release                                |
| P5  | `pool` is refused as a slug in both modes, and a state directory from the other mode is refused                                                                                                                                               | 1, same                                                                                       | drop either refusal                                         |
| P6  | Per-env output is unchanged: the existing suite passes unedited                                                                                                                                                                               | 1, same                                                                                       | none needed: the unchanged suite is the characterisation    |
| P7  | Σ environment quotas plus the reserve must fit the project quota                                                                                                                                                                              | 1, same                                                                                       | remove the check                                            |
| P8  | The clones validator accepts exactly three read-only `/run/sandbox-tls/*.pem` binds per app, and refuses a socket mount once `x-sandbox-vm-mode` is set                                                                                       | 1, `app/src/__tests__/lib/config/compose-clones.test.ts`                                      | allow any `/run/` bind; drop `read_only`                    |
| P9  | The two apps' certificate and key sources differ. Hosts are equal under common-pool and differ under per-env.                                                                                                                                 | 1, same                                                                                       | the same key file for both                                  |
| P10 | The rebuild refuses unknown fields at any depth, including `hostconfig.privileged`, `HostConfig.PRIVILEGED` and nested unknown fields                                                                                                         | 1, new `go test` in `packages/sandbox/broker/` (a new CI step, same `--mutations` convention) | turn off `DisallowUnknownFields`; filter instead of rebuild |
| P11 | Each forced field in §3.2 is present whatever the client sends                                                                                                                                                                                | 1, broker                                                                                     | remove any one force (one mutation per field)               |
| P12 | The image allowlist matches exactly, per identity, and the forwarded `Image` is the pinned config ID                                                                                                                                          | 1, broker                                                                                     | a prefix match; forward the client's tag                    |
| P13 | The identity comes from the fingerprint map, and a mismatched label or filter is refused                                                                                                                                                      | 1, broker                                                                                     | take the identity from the CN or the label                  |
| P14 | Ownership: start, exec, inspect and delete on another environment's box return 404, with zero upstream calls (counted by a fake dockerd)                                                                                                      | 1, broker                                                                                     | skip the pre-inspect                                        |
| P15 | Exec id binding: start, resize and inspect of another identity's exec id return 404                                                                                                                                                           | 1, broker                                                                                     | drop the exec map                                           |
| P16 | Exec `Privileged`, `User` and `Env` are refused                                                                                                                                                                                               | 1, broker                                                                                     | allow `User`                                                |
| P17 | Every refused route in §3.6 is refused with zero upstream calls (table-driven)                                                                                                                                                                | 1, broker                                                                                     | default-allow fallthrough                                   |
| P18 | Quotas: N parallel creates leave exactly the quota running, counted after a simulated broker restart                                                                                                                                          | 1, broker                                                                                     | remove the lock; count in memory                            |
| P19 | The hijacked stream carries bytes both ways, passes half-close, and ends when upstream closes                                                                                                                                                 | 1, broker                                                                                     | no `CloseWrite`                                             |
| P20 | **CLI contract.** The real `docker` CLI binary, run against the broker in front of a recording fake dockerd, completes rows 1-6 as `DockerBackend` and the PTY spawn them. This records the exact request set (#648 §7). No daemon is needed. | 1, broker (the CLI must be present on the runner)                                             | refuse `/_ping`; refuse exec inspect                        |
| P21 | The broker binary hash is a required lock input, and the build refuses a lock without it                                                                                                                                                      | 1, `scripts/vm-image/build.test.py` (runs in CI via the package suite)                                                 | make the input optional                                     |

**No layer can see this yet (pyramid rule 7):** the broker in front of a real dockerd inside a real VM, including long-lived exec, resize, cross-environment refusal and a quota under load. That is operator evidence in the spike harness (`scripts/sandbox-vm-spike.sh`), alongside the spike items already owed (#648 comment D). It is never per-PR. Layers 2 and 3 fake the inference endpoint and the gateway, not the sandbox, so neither is the right place.

## 7. Interaction with Q3 (gVisor), as options

|                      | `per-env`                                                                                                                      | `common-pool`                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How it would be set  | `runtimes.runsc` plus `default-runtime: runsc` in the VM's `daemon.json` (`cloudConfig`)                                       | the same daemon config, **and** the broker forces `HostConfig.Runtime: runsc` on every rebuilt create                                                             |
| Can the app opt out? | **Yes.** It holds dockerd and can pass `--runtime runc`. gVisor protects the guest kernel from sandbox code, not from the app. | **No.** The client's `Runtime` is refused (§3.2).                                                                                                                 |
| What it protects     | box ↔ box and box ↔ guest kernel within one environment                                                                        | the same, **and the cross-environment case**: it is the layer between a box escape and the VM that holds both environments                                        |
| Options              | (a) spike, then the daemon default; (b) defer; (c) no                                                                          | (a) common-pool forces runsc from v1; (b) common-pool runs runc, with gVisor added later; (c) common-pool carries owner and demo traffic only until Q3 is settled |

The issue's spike items apply unchanged to both: long-lived `exec -i`, `exec -it` with resize, tmpfs, the read-only root and pids under runsc, and the flavour workloads. gVisor's DNS caveat on user-defined bridges does not apply while v1 forces `NetworkMode: none`.

## 8. Open owner questions

**CP1. Must gVisor be in place before common-pool carries release traffic?**

- **Plain words.** In common-pool, the only thing between a box escape and the other environment's boxes is the container runtime. gVisor would add a second layer there.
- **Implication.** Without it, a runc escape from a dev box reaches release boxes. With it, common-pool waits on the Q3 spike.
- **Options.** (a) Require runsc, forced by the broker, for common-pool. (b) Allow runc now and add gVisor later. (c) Common-pool for owner and demo traffic only, until Q3 is settled.
- **Recommendation.** (c) now, then (a) if the Q3 spike passes.
- **What it blocks.** Whether broker v1 forces `Runtime`, and when common-pool may carry release.

**CP2. Quotas: a fixed share each, or a shared pool with a guaranteed minimum?**

- **Plain words.** Either each environment gets a hard slice of the VM, or dev may borrow release's idle capacity.
- **Implication.** Fixed slices cannot starve release, but leave capacity idle. Borrowing needs pre-emption or reservation logic in privileged code.
- **Options.** (a) A static partition. (b) A reserved minimum for release, with dev bursting above it.
- **Recommendation.** (a) for v1.
- **What it blocks.** The broker's quota code (§3.5).

**CP3. Is a Go broker, with a Go toolchain in CI and the image pipeline, acceptable?**

- **Plain words.** The broker should be written in the same language as Docker's own request decoder. That adds Go to the repo.
- **Implication.** It needs a pinned Go toolchain in CI and in the broker build, plus a reviewed binary per release. A TypeScript broker would have to reproduce Go's case-insensitive decoding exactly, which is the class of bug the rebuild exists to remove.
- **Options.** (a) Go. (b) TypeScript in the package.
- **Recommendation.** (a).
- **What it blocks.** Any broker code.

**CP4. Should per-env also put the broker in front of each VM's dockerd?**

- **Plain words.** The same broker could run inside each environment's VM. Each app would then hold only the six operations, instead of root in its VM.
- **Implication.** It narrows per-env further at no new code cost once the broker exists. It also adds the broker's failure modes to per-env, which today has none.
- **Options.** (a) Not now: two values, as ruled. (b) Later, as an option on `per-env`, after the broker has been reviewed in common-pool.
- **Recommendation.** (a).
- **What it blocks.** Nothing in v1.

## Not confirmed

- **The exact Engine API requests** for each row: `_ping`, exec inspect, and the fallbacks generic `inspect` tries. P20 records them. Until then, §3.1 is the contract as read from the CLI's documented behaviour.
- **Hijacked exec through the Go reverse proxy**, including half-close on long-lived MCP stdio. Covered by P19 and P20 and by the spike.
- **Whether `MemorySwap = Memory` and the tmpfs charge** behave as stated inside a nested-KVM guest's cgroup v2.
- **The memory saved by one VM instead of two.** Unmeasured.
