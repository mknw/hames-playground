# Sandbox smoke scripts

Live-container smoke checks for `withSandbox(actorCritic(...))`. Complement
the hermetic vitest tests under `app/src/__tests__/lib/sandbox/` — those mock
`node:child_process.spawn` and the MCP SDK at the lowest seam to stay
CI-friendly. These scripts spin up **real Docker containers** and prove the
chain works for real.

## When to run

After any change to the sandbox lane (`DockerBackend`, the ALS scope, the
`withSandbox` wrapper, the controller/adapter dispatch wiring) and before
opening a PR. The vitest suite catches most regressions; smoke scripts catch
the ones the mocks would mask — anything that depends on the actual docker
engine, the real `rust-mcp-filesystem` binary, or stdio handshake details
that the SDK mocks gloss over.

## Prerequisites

- Docker engine running (colima on macOS).
- `kg-sandbox:base` image built:
  ```sh
  cd rootfs && docker build -t kg-sandbox:base .
  ```
- Nix-shell users: the flake's `shellHook` bridges `~/.docker/contexts` into
  `$DOCKER_CONFIG/contexts` so colima resolves. If you see
  `context "colima": context not found`, re-enter `nix develop` (the
  symlink only gets created on shell entry) or consult `rootfs/README.md`
  → "Inside the nix shell".

## The two scripts

| File                | Driven by                                                      | Cost        | Typical runtime                            |
| ------------------- | -------------------------------------------------------------- | ----------- | ------------------------------------------ |
| `smoke-scripted.ts` | hand-scripted actor + critic, **runs twice to prove pool hit** | none        | ~1.5s (1 cold boot + 1 pool hit + 1 reset) |
| `smoke-llm.ts`      | real Anthropic via BAML adapters                               | a few cents | ~4–5s (2× Anthropic calls)                 |

Run from `app/`:

```sh
pnpm dlx tsx src/lib/sandbox/scripts/smoke-scripted.ts
pnpm dlx tsx --env-file=.env src/lib/sandbox/scripts/smoke-llm.ts
```

`smoke-llm.ts` needs `ANTHROPIC_API_KEY` — the only provider key the app
needs (see `CLAUDE.md` → "Client routing"). The `--env-file=.env` flag lets
the script pick up the repo's
`.env` without a separate `dotenv` import.

Each script's file header documents its own actor/critic logic, the
expected event log, and any quirks. Read those before extending.

## What "passing" looks like

Both scripts print:

1. A header — the sentence + the expected count.
2. A boot/run note.
3. The event log — one line per `controller_action`, `tool_result`, and
   `critic_result`, plus any `error`.
4. The final `result` from `scope.data`.
5. Elapsed wall-clock time.

For the word-count task, the result's `stdout` ends with `"9\n"`. The
scripted run takes the deterministic write-then-run path (`sandbox_write`
then `sandbox_bash`); the LLM run picks its own — the verified run went
straight to `sandbox_bash` with a `python3 -c` one-liner.

`smoke-scripted` additionally asserts that `bootCount === 1` after two
invocations of the same wrapper, sharing one `WarmPool(caps: { base: 1 })`.
The first run cold-boots, the second hits the pool. The script throws if
either invocation cold-booted independently — a regression in the wrapper's
acquire/release wiring would show up here before it reaches production.

## Cleanup

`DockerBackend` boots containers with `docker run --rm`, and the
`withSandbox` `finally` block calls `backend.destroy()` on exit — including
on inner-pattern throws and `connectMcp` failures. So normal exits never
leak.

On SIGKILL or harness crash, leftover sandboxes carry the `kg-sandbox=1`
label. Reap them with:

```sh
docker ps -a --filter label=kg-sandbox=1 -q | xargs -r docker rm -f
```
