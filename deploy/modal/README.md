# Small models on Modal

First time? [Serving the small models on Modal](../../docs/tutorials/serving-the-small-models-on-modal.md) walks the whole setup once; this page is the reference.

The private tier's two small roles on one scale-to-zero GPU container: the Qwen3.5-4B summarizer the app reaches as `LocalQwenSmall`, and the H2O-Lightning-4B decision LoRA (same base) behind H2O's `systemone` shim. One vLLM process serves both; a Caddy route list is the only public surface.

## Quick start

```bash
cd deploy/modal
cp deploy.env.example deploy.local.env       # fill in the two regions; git-ignored
uv run modal token new                       # once per machine; opens the browser
uv run --env-file deploy.local.env modal deploy hames_small_models.py
```

`modal deploy` prints the URL (the `….modal.direct` one). Create a Proxy Token in Modal's dashboard (Settings → Proxy Tokens), put `wk-….ws-…` and the URL into `deploy.local.env`, then:

```bash
uv run --env-file deploy.local.env smoke.py                 # both models, in the app's request shapes: PASS/FAIL
uv run --env-file deploy.local.env measure.py --samples 3   # cold starts + warm calls, synthetic inputs
```

`smoke.py` passing is the signal the app can be pointed at the box: the summarizer answers `LocalQwenSmall`'s exact body, every decision answer parses the way the app's systemone transport parses it, and the closed routes and the image-URL lock are checked on the live box rather than only in the file.

No `uv`? `nix run nixpkgs#uv -- …` works in place of `uv …`.

## What the app needs from it

| App setting               | Value                        |
| ------------------------- | ---------------------------- |
| `SMALL_LLM_BASE_URL`      | `<URL>/v1`                   |
| `SMALL_LLM_DECISIONS_URL` | `<URL>/v1/systemone`         |
| `SMALL_LLM_API_KEY`       | the Proxy Token, `wk-….ws-…` |

The chat client sends `model: qwen3.5-4b-instruct`, which vLLM enforces, so the base is served under exactly that alias. The shim ignores `model`. The first request after idle is a 503 until the container is ready (Modal servers do not queue); the app's wake-then-run poll treats a 5xx as "starting" and retries, so point it at `GET /health`.

## Routes

| Path                        | Upstream | Used by                                                          |
| --------------------------- | -------- | ---------------------------------------------------------------- |
| `POST /v1/chat/completions` | vLLM     | `describe` (summaries, titles, compaction)                       |
| `GET /v1/models`            | vLLM     | smoke checks                                                     |
| `POST /v1/systemone`        | shim     | `decide`                                                         |
| `GET /health`               | shim     | the wake poll; re-checks the adapter is served                   |
| `GET /status`               | file     | boot facts: restored-from-snapshot, phase timings, adapter check |

Everything else is a 404 at Caddy. vLLM's dev-mode routes (`/sleep`, `/wake_up`, `/collective_rpc`, cache controls), which `VLLM_SERVER_DEV_MODE=1` registers unauthenticated, and the raw `/v1/completions` + `/tokenize` the shim uses, are reachable only on loopback inside the container. `app/src/__tests__/deploy/modal-pins.test.ts` pins the route list.

## Boot sequence and the snapshot

`hames_small_models.py` is the whole thing. With `HAMES_MODAL_SNAPSHOT=1` (the default):

1. **Before the snapshot** (`@modal.enter(snap=True)`): start vLLM with the base plus the LoRA, confirm both names are served, start the shim, warm both with the literal synthetic prompts in the file, record top-5 logprobs for one reference prompt on each name, assert the two differ (the model card's adapter-active check), then `POST /sleep?level=1`.
2. Modal snapshots CPU and GPU memory.
3. **After a restore** (`snap=False`): `POST /wake_up`, re-read the reference prompt on both names, require each to keep its pre-sleep top token and move no shared top-5 token by more than 0.1 in probability, run the adapter-active check again on these fresh readings, then start Caddy. A failure stops the container rather than serving a box whose adapter silently stopped applying. Each restore records the drift it measured in `/status` (`reference_drift`); the bound is in probability because restores of one snapshot differ by a few hundredths of a logprob from run to run, which is noise rather than damage.

With `HAMES_MODAL_SNAPSHOT=0` the same steps run in one `@modal.enter`, with no sleep. That is the baseline `measure.py` compares against.

GPU snapshots are a Modal **alpha** feature. vLLM 0.30's source keeps a LoRA through level-1 sleep, but hybrid linear-attention models (Qwen3.5 is one) are listed as a coverage gap in vLLM's own sleep/wake tracking — which is why step 3 re-checks the distribution instead of trusting `/health`.

## What leaves the compute region, and what does not

Modal pins compute and routing to the configured regions and never moves a pinned container. Modal stores **images, memory snapshots, Secrets and container logs in the United States** regardless. So:

- The image and the snapshot hold public weights (Apache-2.0, pinned to a commit and a hash), code, and the synthetic warm-up state. No request has run before the snapshot is taken, by construction.
- Request and response bodies are proxied to the container and not stored by Modal.
- Outbound requests: none on a request's behalf. vLLM reads no images (`--limit-mm-per-prompt` 0 refuses an image part before anything is fetched), and the shim, whose pinned config enables an image path that would fetch an image named by URL, runs with its own `LIGHTNING_IMAGE_URLS=off` lock.
- Logs: vLLM 0.30 does not log requests unless asked (`--enable-log-requests` is never passed); its dev-mode default of logging exception stacks is turned off (`--no-log-error-stack`); uvicorn's access log is off; Caddy writes no access log; the shim's stderr passes through an allow-list that reduces any traceback to its exception class.

Those are mechanisms. Whether Modal is an acceptable processor for the private tier, and whether a narrow EU region satisfies a residency requirement when Modal does not publish which country backs it, are the operator's decisions. The pointers: Modal's trust center (DPA, subprocessors), `modal.com/docs/guide/data-residency`, and Modal themselves for the country question.

## Operator commands

```bash
uv run --env-file deploy.local.env ops.py status    # containers up — the only check that does not start one
uv run --env-file deploy.local.env ops.py prewarm   # boot it now (min_containers=1), e.g. before a demo
uv run --env-file deploy.local.env ops.py release   # back to scale-to-zero
uv run --env-file deploy.local.env ops.py stats     # last hour's engine stats
uv run modal container list                         # the CLI equivalent of status
uv run modal app logs <app-name>
```

Any HTTP request, a `GET /health` included, starts a cold container; `ops.py status` is the one that does not.

## Reference measurements

Taken on 2026-10-15 with the defaults above (one L4, 2 cores, 24 GiB) in a narrow EU region, synthetic inputs only. "Cold start" is what the app's wake sees: first request to first `200` through the public URL, polled every 5 s, so each figure is up to 5 s high.

**Cold start**

| Path                                                                                        | Readings                                  |
| ------------------------------------------------------------------------------------------- | ----------------------------------------- |
| From the snapshot (`measure.py`, three samples)                                             | 21.1 s, 26.7 s, 26.7 s                    |
| From the snapshot (`smoke.py`, two runs)                                                    | 26.3 s, 31.4 s                            |
| Without a snapshot: the box's own boot until both models are warm and checked (two deploys) | 388 s, 398 s (vLLM ready at 378 s, 388 s) |
| First request after a deploy: that boot, then the snapshot is saved and restored            | about 8–10 minutes                        |
| Inside the box after a restore: `/wake_up` plus the post-restore checks                     | 1.94 s, 2.32 s, 2.21 s                    |

The no-snapshot row comes from first boots, which run exactly the `HAMES_MODAL_SNAPSHOT=0` path plus a 4 s sleep step; no separate `SNAPSHOT=0` deploy was measured.

**Warm calls** (`measure.py`, same three samples)

| Call                                                        | Readings                                          |
| ----------------------------------------------------------- | ------------------------------------------------- |
| Summarize a 400-row synthetic tool result, 67 output tokens | 4.99 s, 4.78 s, 5.07 s                            |
| Decide, two questions: client / shim-reported               | 1.01 s / 591 ms, 0.81 s / 519 ms, 0.85 s / 615 ms |
| Summarize a one-line input (`smoke.py`)                     | 1.10–1.20 s                                       |

**Post-restore drift** (probability; the bound is 0.1)

| Restore       | Summarizer       | Decision adapter                      |
| ------------- | ---------------- | ------------------------------------- |
| Five restores | 0.0 on every one | 0.001, 0.0006, 0.0129, 0.0143, 0.0016 |

Scale to zero after the last request took about 2 minutes, as configured.

## Cost

Billed while a container exists: boot, the snapshot creation, serving, and the scaledown window after the last request. Per Modal's list prices, an L4 with 2 cores and 24 GiB pinned to a narrow EU region is about $1.8 per active hour, $0 at zero containers. Set a workspace spend limit in Modal's dashboard before the first deploy; `HAMES_MODAL_MAX_CONTAINERS=1` caps the box at one replica.

## Before any real traffic reaches it

The deploy above serves synthetic data. Pointing a real user's `.env` at the URL is a separate step gated on the operator's own governance decision (processor, region, log and snapshot placement). Nothing in this directory makes that decision.

## Layout

| File                       | Tracked | Holds                                                  |
| -------------------------- | ------- | ------------------------------------------------------ |
| `hames_small_models.py`    | yes     | the Modal app: image pins, boot sequence, server shape |
| `Caddyfile`                | yes     | the public route list                                  |
| `ops.py`, `measure.py`     | yes     | operator commands; the measurement run                 |
| `smoke.py`                 | yes     | the pass/fail check before the app is pointed at it    |
| `deploy.env.example`       | yes     | every instance variable, documented                    |
| `deploy.local.env`         | **no**  | this deployment's regions, URL and proxy token         |
| `measurements.local.jsonl` | **no**  | `measure.py` output                                    |

Per [ADR-0008](../../docs/adr/0008-deployment-guidance-is-provider-neutral.md), the tracked files are generic: anyone with a Modal workspace can run them, and nothing in them names a deployment. The `*.local.*` pattern is git-ignored at the repo root.
