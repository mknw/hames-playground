# Serving the small models on Modal

**Audience:** someone running the hames app who wants its private tier's two small models
on a GPU that scales to zero, instead of on a machine of their own. This page is about
running the app, not about building on the packages. You need a terminal and a credit card;
you do not need to know Modal.

**What you get:** one GPU container on [Modal](https://modal.com) that serves both small
models from one process:

- the **summarizer** (Qwen3.5-4B), which the app's `describe` role calls as `SmallQwen`;
- the **decision model** (H2O-Lightning-4B, a LoRA adapter on the same base), behind H2O's
  `systemone` API.

It costs nothing while idle. The first request after idle wakes it from a memory snapshot in
about 30 seconds, but that request itself gets an error: Modal does not hold requests while
the box starts. The app does not yet wake the box before using it (step 7 says what to do
meanwhile).

**Words this page uses:**

- **box**: the one GPU container this page deploys.
- **private tier**: the app's setting under which no model call goes to a public AI provider;
  its calls go to models you run yourself. Its two small models are the ones served here.
- **summarizer**: the small model the app uses for short jobs such as summarizing a tool's
  result or titling a conversation (the app's `describe` role, client `SmallQwen`).
- **decision model**: the small model that answers multiple-choice and yes/no questions
  about a piece of text with a probability for each answer, through H2O's `systemone` API.
- **LoRA adapter**: a small set of extra weights that turns the summarizer's base model into
  the decision model, so one GPU serves both.
- **vLLM**: the open-source server that runs the models inside the box.
- **processor**: a company that handles your users' data on your behalf, in the data
  protection sense.

**Where to run the commands:** everything below runs from the `deploy/modal/` directory of
your hames checkout.

**The code:** [`deploy/modal/`](../../deploy/modal/README.md). That directory's README is the
reference: every route, the boot sequence and what is logged. This page walks you through it
once, start to finish.

---

## 1. Set up Modal

1. Create an account at [modal.com](https://modal.com). A personal workspace is enough.
2. **Set a spend limit first**, on the dashboard's Usage & Billing page. A first run of
   everything on this page costs well under $5; a $20 limit leaves room for mistakes. When
   the limit is reached, Modal stops the workloads that would cost more.
3. Install [uv](https://docs.astral.sh/uv/), the Python package runner this directory uses.
   It installs the pinned Modal client for you; nothing goes into your system Python. (No uv?
   `nix run nixpkgs#uv -- …` works in its place.)
4. From `deploy/modal/`, log the Modal client in. This opens a browser and writes
   `~/.modal.toml`:

   ```bash
   cd deploy/modal
   uv run modal token new
   ```

## 2. Choose where it runs

Copy the example settings file. Your copy is git-ignored (`deploy/modal/*.local.*`), so
nothing you put in it can reach the repository:

```bash
cp deploy.env.example deploy.local.env
```

Fill in the two required values. `COMPUTE` is where the GPU runs; `ROUTING` is where
requests enter Modal before they reach it. Use the same region for both unless you have a
reason not to, so a request does not cross regions on its way in. For example:

```bash
HAMES_MODAL_COMPUTE_REGION=eu-west
HAMES_MODAL_ROUTING_REGION=eu-west
```

Which region is your decision. [Modal's region list](https://modal.com/docs/guide/region-selection)
has the names and prices. A _narrow_ region pins the box to one area, such as `eu-west`,
`eu-north` or `eu-south`, at 1.75× the base GPU price. A _broad_ region such as `eu` lets
Modal place it anywhere in that area, at 1.15×. Everything else in `deploy.env.example` has a
working default: one L4 GPU, one replica, a 300-second idle window before it scales to zero,
and memory snapshots on (`HAMES_MODAL_SNAPSHOT=1`; set it to `0` to boot from scratch every
time, which is only useful for comparison).

## 3. Deploy

```bash
uv run --env-file deploy.local.env modal deploy hames_small_models.py
```

The **first deploy takes 10–20 minutes.** Modal builds the image on its side: it pulls the
vLLM image and downloads about 9.6 GB of public model weights. Each file is checked against a
pinned hash, and a mismatch fails the build. Later deploys reuse those layers and finish in
seconds. The output ends like this (this run reused layers from an earlier build, hence
two minutes):

```text
✓ Created objects.
├── ✓ Uploaded …/deploy/modal/hames_small_models.py
├── ✓ Created Function download_public_weights.
├── ✓ Uploaded …/deploy/modal/Caddyfile
└── ✓ Created Server SmallModels
    └── https://<workspace>--hames-small-models-smallmodels.<region>.modal.direct 🔑
✓ App deployed in 121.966s! 🎉
```

**No GPU is running yet.** Deploying creates the app; a container starts on the first request.
The 🔑 means the URL accepts only requests that carry a token, which you create next.

## 4. Create a token and save the URL

In Modal's dashboard, go to Settings → Proxy Tokens and create one. It comes as two parts, an
ID (`wk-…`) and a secret (`ws-…`); copy both when Modal shows them. Join them with a period
into one value, and add these two lines (the URL and the token) to `deploy.local.env`:

```bash
HAMES_MODAL_URL=https://<the .modal.direct URL from step 3>
HAMES_MODAL_PROXY_TOKEN=wk-<id>.ws-<secret>
```

The URL is the one `modal deploy` printed, with no path and no trailing slash. The token is
also the key the app will send, so keep it like any other secret. A request with a missing or
wrong token is refused at Modal's edge with a 401, and no GPU starts.

## 5. Check both models

```bash
uv run --env-file deploy.local.env smoke.py
```

This sends both models the same requests the app sends, and checks the answers the way the
app reads them. It prints PASS or FAIL per check and exits non-zero if any fails.

**The first run after a deploy waits 8–10 minutes** with no output after its first line.
That first boot loads the models, warms them, checks that the decision adapter is really
active (that whole boot takes about 6.5 minutes), then saves a memory snapshot. Every later cold start restores
that snapshot instead, in about 30 seconds.

Captured from a run (the first boot was already paid, so this one waited for a restore):

```text
PASS  no token is refused at Modal's edge  status 401
…
PASS  summarize: keeps the number  "In Warehouse B, a stock count of 412 units yielded 3 damaged and 0 missing items."
PASS  decide: 200, native probabilities  1.95s
PASS  decide: choice parses and picks billing  {"billing": 0.9721691390793451, "shipping": 0.015072372797138613, "other": 0.012758488123516258}
…
PASS  /sleep is not reachable  status 404
PASS  /collective_rpc is not reachable  status 404
PASS  /v1/completions is not reachable  status 404
PASS  an image URL is refused without a fetch  status 422

15/15 passed
```

**Passing every check is the signal that the app can use the box.** The closed-route and image checks matter as
much as the model answers: they check, on the live box, that the server's internal control
routes are closed and that nothing in it fetches a URL a request names.

To watch a boot as it happens, stream the logs in a second terminal:

```bash
uv run modal app logs hames-small-models
```

Look for `hames: boot {…}` (the first boot, before the snapshot) and `hames: ready {…}` (the
box is serving). The logs carry startup lines and throughput statistics, never request
content.

## 6. Measure it (optional)

```bash
uv run --env-file deploy.local.env measure.py --samples 3
```

For each sample this waits for the box to scale to zero, times a cold start the way the app's
wake does (`GET /health` every 5 seconds until a 200), and times one warm call per model.
Results go to `measurements.local.jsonl` (git-ignored). Three samples take about 10 minutes.

What a reference run measured on one L4:

|                                                                              |                                     |
| ---------------------------------------------------------------------------- | ----------------------------------- |
| Cold start, from a snapshot (first request to first answer)                  | 21–31 s                             |
| Cold start without a snapshot (`HAMES_MODAL_SNAPSHOT=0`), the box's own boot | about 6.5 minutes (388 s and 398 s) |
| First request after a deploy (boot, then the snapshot is saved)              | 8–10 minutes                        |
| Warm summary of a long tool result / a one-line input                        | about 5 s / about 1 s               |
| Warm decision, two questions                                                 | about 0.9 s                         |

## 7. Point the app at it

Three settings in the app's `.env` (`app/.env`, or the host's environment). Restart the app
after changing them.

| Setting                   | Value                                        |
| ------------------------- | -------------------------------------------- |
| `SMALL_LLM_BASE_URL`      | `<HAMES_MODAL_URL>/v1`                       |
| `SMALL_LLM_API_KEY`       | the token from step 4, `wk-<id>.ws-<secret>` |
| `SMALL_LLM_DECISIONS_URL` | `<HAMES_MODAL_URL>/v1/systemone`             |

> **Not yet complete in the app.** The summarizer works today with the first two settings.
> The third is safe to set now, but nothing reads it yet: connecting the decision model, and
> having the app wake this box before a turn, are follow-up work. Until then a summary
> requested while the box is asleep fails, so start the box before you use the app and let
> it go afterwards:
>
> ```bash
> uv run --env-file deploy.local.env ops.py prewarm   # before
> uv run --env-file deploy.local.env ops.py release   # after; until then it bills by the hour
> ```
>
> The app's cost display also shows the summarizer's calls as free until the follow-up
> prices them by GPU time.

**Before any real user's data goes to it**, decide whether Modal is acceptable as a processor
for your private tier. Wherever the GPU runs, Modal stores images, snapshots and container
logs in the United States. This setup keeps request content out of all three: the snapshot
holds public weights and synthetic warm-up text, and nothing logs requests. Which country
backs a narrow EU region is not published, so ask Modal if residency matters to you. That is
your decision; nothing in `deploy/modal/` makes it.

## Running it day to day

From `deploy/modal/`, with `--env-file deploy.local.env` on each `uv run`:

| Command                                | Does                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ops.py status`                        | how many containers are up. The only check that does not start one: any HTTP request, `GET /health` included, wakes the box |
| `ops.py prewarm`                       | starts it now and keeps it up, for example before a demo                                                                    |
| `ops.py release`                       | back to scale-to-zero; do not forget this after `prewarm`                                                                   |
| `ops.py stats`                         | recent load statistics                                                                                                      |
| `modal app history hames-small-models` | which version is deployed, and from which commit                                                                            |

**Every redeploy that changes the code throws the snapshot away.** The next cold start pays
the 8–10-minute first boot again. Run `smoke.py` right after a redeploy so that wait is yours,
not a user's.

**Cost:** you pay while a container exists, including its boot and the 300-second idle window
after its last request. At list prices, an L4 with 2 CPU cores and 24 GiB of memory in a narrow
region is about $1.80–1.90 per hour. Nothing is billed at zero containers.

## Troubleshooting

| You see                                                                                | It means                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HAMES_MODAL_COMPUTE_REGION is required (see deploy.env.example); refusing to deploy.` | `deploy.local.env` is missing a region, or you left out `--env-file deploy.local.env`.                                                                                                                                                                                                                                                                                                                          |
| `smoke.py` or `measure.py`: `401: the proxy token is wrong`                            | The token is not `wk-<id>.ws-<secret>` joined with a period, or it belongs to another workspace. No GPU was started.                                                                                                                                                                                                                                                                                            |
| `smoke.py` waits more than about 15 minutes, then times out                            | Look at `modal app logs hames-small-models`. A startup failure there stopped the boot; child-process tracebacks are reduced to exception classes.                                                                                                                                                                                                                                                               |
| `… after restore moved 0.250 probability (> 0.1)` in the logs                          | After a restore, a model no longer answers a reference prompt the way it did before the snapshot. The container stops instead of serving changed answers, and Modal starts another. The log line shows both readings; if it keeps happening, open an issue with it rather than loosening the check. A deterministically failing snapshot can incur a GPU restore on each wake poll throughout the 600 s budget. |
| `… answers exactly like … the adapter is not active`                                   | vLLM loaded the decision adapter but is not applying it. The container refuses to serve; do not work around this check.                                                                                                                                                                                                                                                                                         |
| A 503 from the URL right after idle                                                    | The box is starting. Modal does not hold requests for a server with no running container; retry, or poll `GET /health` until it answers 200.                                                                                                                                                                                                                                                                    |

## Related

- [`deploy/modal/README.md`](../../deploy/modal/README.md): routes, boot sequence, what leaves
  the region, the file layout.
- [`deploy/modal/deploy.env.example`](../../deploy/modal/deploy.env.example): every setting,
  with its default.
- [ADR-0008](../adr/0008-deployment-guidance-is-provider-neutral.md): why the files in the
  repository are generic and your deployment's values stay with you.
