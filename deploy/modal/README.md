# Private-tier models on Modal

Two Modal apps, each one scale-to-zero GPU box: the small models (below) and [the 27B](#the-27b-hames_private_27bpy), the private tier's capable model. They are separate apps because a memory snapshot is discarded whenever its app's code changes; what they share is `vllm_box.py`.

First time? [Serving the small models on Modal](../../docs/tutorials/serving-the-small-models-on-modal.md) walks the whole setup once; this page is the reference.

The private tier's two small roles on one scale-to-zero GPU container: the Qwen3.5-4B summarizer the app reaches as `SmallQwen`, and the H2O-Lightning-4B decision LoRA (same base) behind H2O's `systemone` shim. One vLLM process serves both; a Caddy route list is the only public surface.

## Quick start

```bash
cd deploy/modal
cp deploy.env.example deploy.local.env       # fill in the two regions; git-ignored
# HAMES_MODAL_SMALL_COMPUTE_REGION overrides the shared region for the small box only; unset shares the 27B's.
uv run modal token new                       # once per machine; opens the browser
uv run --env-file deploy.local.env modal deploy hames_small_models.py
```

`modal deploy` prints the URL (the `….modal.direct` one). Create a Proxy Token in Modal's dashboard (Settings → Proxy Tokens), put `wk-….ws-…` and the URL into `deploy.local.env`, then:

```bash
uv run --env-file deploy.local.env smoke.py                 # both models, in the app's request shapes: PASS/FAIL
uv run --env-file deploy.local.env measure.py --samples 3   # cold starts + warm calls, synthetic inputs
```

`smoke.py` passing is the signal the app can be pointed at the box: the summarizer answers `SmallQwen`'s exact body, every decision answer parses the way the app's systemone transport parses it, and the closed routes and the image-URL lock are checked on the live box rather than only in the file.

No `uv`? `nix run nixpkgs#uv -- …` works in place of `uv …`.

## What the app needs from it

| App setting               | Value                        |
| ------------------------- | ---------------------------- |
| `SMALL_LLM_BASE_URL`      | `<URL>/v1`                   |
| `SMALL_LLM_DECISIONS_URL` | `<URL>/v1/systemone`         |
| `SMALL_LLM_API_KEY`       | the Proxy Token, `wk-….ws-…` |

The chat client sends `model: qwen3.5-4b-instruct`, which vLLM enforces, so the base is served under exactly that alias. The shim ignores `model`. The first request after idle is a 503 until the container is ready (Modal servers do not queue); the app's wake-then-run poll treats a 5xx as "starting" and retries, so point it at `GET /health`.

## Routes

| Path                        | Upstream | Used by                                                               |
| --------------------------- | -------- | --------------------------------------------------------------------- |
| `POST /v1/chat/completions` | vLLM     | `describe` (summaries, titles, compaction)                            |
| `GET /v1/models`            | vLLM     | smoke checks                                                          |
| `POST /v1/systemone`        | shim     | `decide`                                                              |
| `GET /health`               | shim     | the wake poll; re-checks the adapter is served                        |
| `GET /status`               | file     | boot facts: restored-from-snapshot, phase timings, adapter check, GPU |

Everything else is a 404 at Caddy. vLLM's dev-mode routes (`/sleep`, `/wake_up`, `/collective_rpc`, cache controls), which `VLLM_SERVER_DEV_MODE=1` registers unauthenticated, and the raw `/v1/completions` + `/tokenize` the shim uses, are reachable only on loopback inside the container. `app/src/__tests__/deploy/modal-pins.test.ts` pins the route list.

## Boot sequence and the snapshot

`hames_small_models.py` is the whole thing. With `HAMES_MODAL_SNAPSHOT=1` (the default):

1. **Before the snapshot** (`@modal.enter(snap=True)`): start vLLM with the base plus the LoRA, confirm both names are served, start the shim, warm both with the literal synthetic prompts in the file, record top-5 logprobs for one reference prompt on each name, assert the two differ (the model card's adapter-active check), then `POST /sleep?level=1`.
2. Modal snapshots CPU and GPU memory.
3. **After a restore** (`snap=False`): `POST /wake_up`, re-read the reference prompt on both names, reject nonfinite readings, require each to keep its pre-sleep argmax token and move no shared top-5 token by more than 0.1 in probability, run the adapter-active check again on these fresh readings, then start Caddy. A failure stops the container rather than serving a box whose adapter silently stopped applying. Each restore records the drift it measured in `/status` (`reference_drift`); the bound is in probability because restores of one snapshot differ by a few hundredths of a logprob from run to run, which is noise rather than damage.

With `HAMES_MODAL_SNAPSHOT=0` the same steps run in one `@modal.enter`, with no sleep. That is the baseline `measure.py` compares against.

GPU snapshots are a Modal **alpha** feature. vLLM 0.30's source keeps a LoRA through level-1 sleep, but hybrid linear-attention models (Qwen3.5 is one) are listed as a coverage gap in vLLM's own sleep/wake tracking — which is why step 3 re-checks the distribution instead of trusting `/health`.

## GPU fallbacks

`HAMES_MODAL_GPU` takes one type or an ordered list, e.g. `L4,A10`: Modal starts a container on the first listed type with capacity ([GPU fallbacks](https://modal.com/docs/guide/gpu#gpu-fallbacks)). One app, one URL, and no app setting changes. Three consequences:

- **Snapshots are per GPU type.** Each type in the list takes its own ([2–3 per type](https://modal.com/docs/guide/memory-snapshots)), so the first cold starts that land on a type are full boots, however warm the other type is. Changing the list obsoletes every snapshot, as any redeploy does. The pre-sleep reference that step 3 compares against is in the snapshot, so a restore is always checked against a boot on its own GPU type.
- **`/status` names the GPU** the container landed on (`gpu`, from `nvidia-smi`), and `smoke.py` prints it, so a measurement records which type it timed.
- **Each type bills at its own rate**, and since #848 the app prices the box by the GPU actually served: it samples the `gpu` field `/status` reports (once per wake, then at most once per scale-down window), `SMALL_LLM_EUR_PER_HOUR` is the L4 rate, and each other family needs a row in `app/src/lib/inference/small-gpu.server.ts`'s table plus its override var (`SMALL_LLM_EUR_PER_HOUR_A10` for the A10) — a type in the fallback list that the table does not know prices at the highest rate the table knows. A call served on a cheaper type than the fallback showed used to read low; that is what per-GPU pricing fixes.

## What leaves the compute region, and what does not

Modal pins compute and routing to the configured regions and never moves a pinned container. Modal stores **images, memory snapshots, Secrets and container logs in the United States** regardless. So:

- The image and the snapshot hold public weights (Apache-2.0, pinned to a commit and a hash), code, and the synthetic warm-up state. No request has run before the snapshot is taken, by construction. The vLLM image is pinned by index digest, and the base model, adapter and card files are verified by sha256 at build time.
- Request and response bodies are proxied to the container and not stored by Modal.
- Outbound requests: the known media-fetch paths are disabled in the processes. vLLM reads no images (`--limit-mm-per-prompt` 0 on the small box, `--language-model-only` on the 27B), and the shim runs with `LIGHTNING_IMAGE_URLS=off`. **Container egress remains open**; see the limitation and compensating checks below.
- Usage reporting is disabled with `VLLM_NO_USAGE_STATS=1` and `DO_NOT_TRACK=1`; these are process settings, not a network policy. `HF_HUB_OFFLINE=1` applies after the build-time downloads, and media redirects are disabled.
- Logs: vLLM request/output and uvicorn access logging are off. `--no-log-error-stack` disables the registered handlers' stacks; a shared reducer also reduces streaming tracebacks to a validated exception class and truncates WARNING/ERROR/CRITICAL lines at their source tag. INFO lines pass. The shim's startup lines pass only before the public listener starts; afterwards only synthesized exception metadata passes. Caddy writes no access log, and its error-log filter deletes request URIs, headers and client addresses.

Those are mechanisms. Whether Modal is an acceptable processor for the private tier, and whether a narrow EU region satisfies a residency requirement when Modal does not publish which country backs it, are the operator's decisions. The pointers: Modal's trust center (DPA, subprocessors), `modal.com/docs/guide/data-residency`, and Modal themselves for the country question.

## Outbound restriction: Server API limitation (#635, acceptance b)

Checked 2026-10-18 against Modal's [Server API](https://modal.com/docs/sdk/py/latest/App#server) and the **1.6.1 SDK pinned here**: `App.server` has neither `block_network` nor a CIDR allowlist. Its implementation (`modal/app.py:1294–1331,1471–1508` in the pinned wheel) constructs the internal function without a network restriction; `_Function._from_local` defaults `block_network` to `False` (`modal/_functions.py:717`) and serializes it as such (`:1080`). Reproduce against the [official wheel](https://files.pythonhosted.org/packages/d2/3c/6b7d9a15dab9af2833ce674bbc72b5654d4099d5b088f1cc1eda3f8249ca/modal-1.6.1-py3-none-any.whl), whose SHA256 is recorded in `uv.lock`.

Functions/classes expose `block_network`; [Sandboxes](https://modal.com/docs/sdk/py/latest/Sandbox#create) expose an outbound CIDR allowlist. Those are different APIs. The documented Server `experimental_options` provides no supported network-policy key; guessing one would not establish enforcement. Modal's [GPU-snapshot Server example](https://modal.com/docs/examples/lfm_snapshot) supports the snapshot pattern used here, but does not demonstrate it with blocked egress. Thus compatibility with Server ingress, health probes and snapshot restore **has not been established**. Neither app receives an unsupported option or changes serving primitives.

The [Servers guide](https://modal.com/docs/guide/servers#defining-a-server) identifies `@modal.web_server` as the analogous Function primitive: `@app.cls(block_network=True)` plus `@modal.web_server` is accepted client-side in the pinned SDK (`modal/app.py:1077–1085,1266`; `modal/_partial_function.py:497–548`), but ingress, health checks and GPU snapshots with that block remain unverified (the Sandbox API explicitly refuses open ports with `block_network`, `modal/sandbox.py:896–897`). Moving off `@app.server` would also change proxy authentication from the current Bearer header to `Modal-Key`/`Modal-Secret` and the [503/no-queue behavior](https://modal.com/docs/guide/servers#zero-to-one-scaling) the app relies on. A synthetic-only throwaway compatibility spike is a proposed follow-up requiring the owner's decision and authorization; none was built or run here.

Both apps bake weights and Caddy during image build, before `HF_HUB_OFFLINE=1`; their vLLM argv uses local model directories (`hames_small_models.py:166–193,201–229`; `hames_private_27b.py:187–224`). Local health, sleep/wake and Caddy upstreams use loopback. These remove known runtime download needs, but do not prove that every dependency can boot offline.

**Compensating check, not network containment (SD-14):** `modal-pins.test.ts` pins both vLLM media refusals, the shim's effective URL lock, offline/telemetry settings, build-time model pins and Caddy's loopback route list. `smoke.py` probes small-box chat `image_url` and `video_url` parts, plus the decision shim's top-level `image_url` and an image part nested in structured `state`; `smoke_27b.py` probes a chat `image_url` part. The structured-state shape follows the [pinned shim](https://huggingface.co/h2oai/h2o-lightning-4b/blob/b43f759b6385d21182f87c3829931ec3d4dfa98a/h2o_lightning_shim.py#L506) (`:506–528,547–597`), whose SHA256 matches `CARD_FILES_SHA256`. All probes use the shared `PROBE_URL` on a reserved `.invalid` HTTPS host: a fetch must fail, so fetch-then-refuse cannot pass as pre-fetch refusal. They require each specific pre-fetch refusal, rather than treating a generic error from a failed download as success. `test_behaviour.py` validates the outgoing requests and exercises those real smoke entry points with independent fixed HTTP fixtures, wrong statuses and each fetch-failure indicator separately. These checks cover the listed paths; they cannot contain arbitrary future outbound code or a compromised process. Reassess the Server API on an SDK upgrade (the `uv.lock` Modal 1.6.1 pin forces this review) or a documented Modal-supported solution.

**Owner verification after an authorized deploy** (not run by this change): from this directory, with synthetic inputs and operator-local configuration only:

```bash
uv run --env-file deploy.local.env smoke.py
uv run --env-file deploy.local.env smoke_27b.py
uv run --env-file deploy.local.env measure.py --box small --samples 1
uv run --env-file deploy.local.env measure.py --box 27b --samples 1
```

Run each smoke after a confirmed full boot and again after a confirmed snapshot restore. Each measure waits for scale-to-zero before waking the box; repeat until both report `box.restored: true`, then rerun the smokes while warm. Correlate with lifecycle logs because `restored` is inferred from snapshot age. Require both smokes to exit 0, successful health/model routes, the small-box adapter check, and the 27B answer/MTP and reference checks. Retain the results locally. This verifies the compensating behavior through boot and restore; it is **not evidence of blocked egress**. No deploy, Modal API call, or live smoke was made for this change.

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

## The 27B (`hames_private_27b.py`)

Qwen3.8-27B-FP8 for the app's `LargeQwen` client, a drop-in for the Verda deployment: the same model name (vLLM enforces it), a 131072-token window and an OpenAI-compatible `/v1`. `modal-pins.test.ts` pins the name and the window against the client's own files.

```bash
uv run --env-file deploy.local.env modal deploy hames_private_27b.py
uv run --env-file deploy.local.env smoke_27b.py                         # PASS/FAIL, in LargeQwen's request shape
uv run --env-file deploy.local.env measure.py --box 27b --stop --samples 3
HAMES_MODAL_SERVER=Qwen27B uv run --env-file deploy.local.env ops.py status   # every ops.py command, for this box
```

Then, from `app/`, the app's own checks against it: `smoke-self-deployed.ts` and `smoke-large-load.ts` (`src/lib/inference/scripts/`), with the endpoint and key in an overlay env file.

**Switching the app to it is env-only, and these move together:**

| App setting                   | Value                                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LARGE_LLM_BASE_URL`          | `<27B URL>/v1`                                                                                                                                           |
| `LARGE_LLM_API_KEY`           | the Proxy Token, `wk-….ws-…`                                                                                                                             |
| `LARGE_LLM_EUR_PER_HOUR`      | this box's rate, not Verda's (an H100 below is ≈ 7.00)                                                                                                   |
| `LARGE_LLM_SCALEDOWN_SECONDS` | `HAMES_MODAL_27B_SCALEDOWN_S`, 300 by default                                                                                                            |
| `LARGE_LLM_WAKE_TIMEOUT_MS`   | `1200000` for as long as the endpoint points here: a full boot (next paragraph) takes 8–15 minutes, past the 600 s default, and one can come unannounced |

**The processor.** Modal is an approved processor for the private tier: G15 (#567 comment 6194622280) approved it, and its company-data condition, a DPA with Modal, is met (owner, 2026-10-18). The approval holds on two conditions the code enforces: snapshots hold public weights and synthetic warm-up only, and no request or response content reaches a log; a change that breaks either reopens it. Modal's answer on which country backs the narrow EU region is still owed to the record. On this host the transfer picture differs from Verda's (`docs/data-privacy/plan.md`, finding 1, update of 2026-10-17).

**When a cold start is a full boot.** Most cold starts restore the snapshot. Three things make one a full boot instead, which is why the wake budget above is longer than any restore: the first few cold starts after a deploy (Modal takes 2–3 snapshots per GPU type, one per worker type it lands on; in both measured runs the SECOND cold start after a deploy was one), Modal re-taking snapshots for its own runtime updates, and any change to what is baked into its image: `hames_private_27b.py`, `vllm_box.py`, `log_filter.py` or `Caddyfile.27b`. After a deploy, run `measure.py --box 27b --stop` until a sample reports `restored` from a snapshot that is not the one being created, so no turn meets those boots.

**What differs from the small box:**

- Thinking. vLLM runs the `qwen3` reasoning parser, so the model can think and its reasoning arrives in the response's `reasoning` field (and counts in `completion_tokens`); `LargeQwen` turns it off per request with `chat_template_kwargs`. `smoke_27b.py` checks both: with thinking off, `content` is non-empty and parses and `reasoning` is empty; with it on, nothing leaks into `content`.
- Text only (`--language-model-only`): no vision tower is loaded and an image part is a 400 before anything is fetched.
- Multi-token prediction (`HAMES_MODAL_27B_MTP_TOKENS`, 2 by default) drafts tokens with the model's own MTP head. A damaged draft head costs speed, never correctness, so the restore check reads its acceptance rate on a literal generation before the sleep and after the restore.
- After a restore, before Caddy listens: the reference distribution (as the small box), a literal question that must parse to the exact JSON answer with thinking off, and MTP acceptance within 0.15 of its pre-sleep value.
- Routes (`Caddyfile.27b`): `POST /v1/chat/completions`, `GET /v1/models`, `GET /health` (vLLM's, answered only once those checks passed) and `GET /status`. Everything else is a 404, including every dot-segment path that resolves off the list.
- Shape: 4 cores and 64 GiB (level-1 sleep holds the ~31 GB of weights in CPU RAM for the snapshot), `H100!` (the `!` stops Modal substituting an H200, which would need snapshots of its own), up to 8 requests in flight, 300 s idle.

**Reference measurements, 2026-10-17** (synthetic inputs; `eu-west`; the load figures are `smoke-large-load.ts`, 2.75k-token prompts, the same script Verda was measured with on 2026-08-25):

|                                                   | RTX PRO 6000, MTP 2 | **H100, MTP 2** (default) | H100, MTP off | Verda, 2026-08-25       |
| ------------------------------------------------- | ------------------- | ------------------------- | ------------- | ----------------------- |
| One in flight, p50                                | 3.9 s               | **2.0 s**                 | 3.2 s         | 4.1 s                   |
| One in flight, 550-token answer                   | 76 tok/s            | **137 tok/s**             | 78 tok/s      | —                       |
| Eight in flight, p50 / p95                        | 4.1 / 4.7 s         | 3.7 / 7.7 s               | 4.5 / 5.3 s   | 6.3 / 9.9 s             |
| Eight in flight, aggregate                        | 396 tok/s           | 357 tok/s                 | 388 tok/s     | 208 tok/s               |
| Controller envelopes parsed                       | 47/47               | 47/47                     | 47/47         | 47/47                   |
| Cold start, restored from a snapshot              | 110 s, 37 s         | 36 s, 62 s                | —             | 146–360 s (no snapshot) |
| Full boot (first after deploy; a second snapshot) | 575 s; 889 s        | 938 s; 513 s              | 505 s         | —                       |
| Inside the box after a restore (wake + checks)    | 2.0 s               | 2.5–2.7 s                 | —             | —                       |
| MTP acceptance, before → after restore            | 0.56 → 0.56         | 0.61 → 0.61               | —             | —                       |

Reference drift was 0.0 on every restore. The eight-in-flight p95 is two rounds of eight, so one slow round sets it.

**Cost.** Per Modal's list prices with the narrow-region multiplier (1.75×): H100 + 4 cores + 64 GiB ≈ $8.14 per active hour (≈ €7.00 at the app's `EUR_PER_USD`), an RTX PRO 6000 in the same shape ≈ $6.53 (≈ €5.62); $0 at zero containers. A full boot is ≈ $1.1–2 of that.

## Before any real traffic reaches it

The deploy above serves synthetic data. Pointing a real user's `.env` at the URL is a separate step gated on the operator's own governance decision (processor, region, log and snapshot placement). Nothing in this directory makes that decision.

## Local verification

`python3 deploy/modal/test_behaviour.py` from the repository root runs the stdlib-only behavior checks without Modal, a model, or a network request. The deploy Vitest suite invokes the same command in CI (`ubuntu-latest` supplies `python3`). It tests traceback and warning reduction, the public-listener event gate, exception-class validation, argmax preservation, refusal of nonfinite readings, and the smoke checks' pre-fetch URL refusals.

## Layout

| File                         | Tracked | Holds                                                          |
| ---------------------------- | ------- | -------------------------------------------------------------- |
| `hames_small_models.py`      | yes     | the small models' app: pins, boot sequence, server shape       |
| `hames_private_27b.py`       | yes     | the 27B's app: pins, boot sequence, server shape               |
| `vllm_box.py`                | yes     | what both share: vLLM and Caddy pins, image env, restore check |
| `Caddyfile`, `Caddyfile.27b` | yes     | each box's public route list                                   |
| `ops.py`, `measure.py`       | yes     | operator commands; the measurement run                         |
| `smoke.py`, `smoke_27b.py`   | yes     | the pass/fail check before the app is pointed at it            |
| `deploy.env.example`         | yes     | every instance variable, documented                            |
| `deploy.local.env`           | **no**  | this deployment's regions, URL and proxy token                 |
| `measurements.local.jsonl`   | **no**  | `measure.py` output                                            |

Per [ADR-0008](../../docs/adr/0008-deployment-guidance-is-provider-neutral.md), the tracked files are generic: anyone with a Modal workspace can run them, and nothing in them names a deployment. The `*.local.*` pattern is git-ignored at the repo root.
