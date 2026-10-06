# #418 spike — run log

**Status: NOT RUN. The model servers were not reachable at spike time.**

`spike.mjs` performs a bounded preflight (`GET {base}/health`, then `/v1/models`,
10 s) and, per the task rule, **skips the spike and exits 2** when the server is
not up. It never starts or stops a model. The script is kept on this branch so
the measurement can be produced the moment a box is available.

## Reachability, measured

| Target                                                                  | Probe                           | Result                                                       |
| ----------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------ |
| `http://127.0.0.1:8890` (cygnet, `gemma-4-12B-it-GGUF:Q8_0`, ctx 16384) | `GET /health`, `GET /v1/models` | connection refused (`curl` exit 7); `lsof` shows no listener |
| `http://127.0.0.1:8095` (the `LocalQwenSmall` 4B, `make llm-small`)     | `GET /v1/models`                | connection refused (exit 7)                                  |
| `http://127.0.0.1:8080` (`pnpm dev:llama`, GLM-4.7-Flash)               | `GET /v1/models`                | connection refused (exit 7)                                  |
| `http://127.0.0.1:8090` (`make embed`)                                  | `GET /v1/models`                | connection refused (exit 7)                                  |

Observed from this worktree on 2026-10-06, twice (initial pass and revision
pass). No listener on any of the four ports. The script's own preflight printed:

```
#418 cygnet spike — http://127.0.0.1:8890 — 2026-10-06T22:23:12.068Z
server not reachable: unreachable (fetch failed) — skipping the spike per the task rules.
```

The owner reports the cygnet weights were still downloading when this was run.

## Revision, 2026-10-07 (review F8/F9 + owner direction 6026685965)

- **`K_LABELS` now matches the spec**: `episodic | semantic | preference | trait`
  (the old `| none` is gone; "none" lives on `memory.target`, and the kind field
  is skipped for `target = 'none'` cases).
- **`top_logprobs` aligned to 20** — the production `LocalQwenSmallDecide`
  declaration, not the 30 that the (now-refused) 24-letter joint product needed.
- **Endpoint-agnostic.** `--url` targets any OpenAI-compatible logprob endpoint
  (llama.cpp, vLLM, Ollaya) via `/v1/chat/completions`; `--readout raw` uses the
  llama.cpp `/completion` endpoint; `--readout systemone` uses a
  `/v1/systemone` decision server (best-effort schema, since that is the
  server's); `--key`/`--model` cover a hosted endpoint. It runs the moment the
  owner's cygnet or any other decision server is up.
- **`RESULTS.md` carries the published local-model numbers** (below), so the
  escalation ranking is reproducible without a run.

## What the script measures when a box is up

`node scripts/spike-418-cygnet/spike.mjs [--url …] [--readout chat|raw|systemone] [--key …] [--model …] [--small …]`

- 22 synthetic cases (within the 20–40 asked for): 12 memory cases scored across
  the three hook fields (`memory.target` 3 labels, `memory.confirm` 2,
  `memory.kind` 4 → 36 rows, less the inapplicable kind rows) and 10 injection
  cases for the merged `document.injection` question (2 labels → 10 rows).
- Readout: `max_tokens: 1`, `logprobs: true`, `top_logprobs: 20`, one letter.
  Every top-k token that trims to a bare `A`..`Z` is summed (vocabularies carry
  `A`, ` A`, `(A`), then renormalised over the label set; the leftover mass is
  reported as `coverage`. Thinking off per request, with a raw `/completion`
  fallback if the chat coverage is below 0.05.
- Raw probabilities and cygnet's fitted calibration (`T = 3.4`) are both scored:
  accuracy, ECE (10 equal-confidence buckets), Brier, mean latency, mean
  coverage. (`jevk5`'s published SemIf temperature, `T = 1.532`, is noted in
  the script but not applied.)
- Multi-field cost: **N single passes, shared state prefix, issued in parallel**
  versus **one combined pass over the 3 × 2 × 4 = 24-letter product**.
- Optional 4B comparison on `--small`.

## Published local decision models (research; no run required)

All figures as published by ollaya.dev (its search/library pages and the
`ollaya-dev/ollaya` README), reproduced exactly. Latency is per five questions
on an RTX 4090. **Only `jevk5` states an open licence on those pages.**

| Model                           | Size        | Typed-decision accuracy             | Calibration            | Latency (5q, 4090) | Licence        |
| ------------------------------- | ----------- | ----------------------------------- | ---------------------- | ------------------ | -------------- |
| `winnow:e4b`                    | 4B-class    | **0.722** (Ollaya's recommendation) | not stated             | **89 ms**          | not published  |
| `kev:9b` / `kev:4b`             | 7.9b / 4.2b | 0.722 / 0.669                       | Kev's own temperature  | 354 ms             | not published  |
| `cygnet`                        | 12b         | 0.683                               | one fitted temperature | 202 ms             | not published  |
| `decider:4b` / `:2b`            | 4.2b / 2.2b | 0.680 / 0.591                       | not stated             | 520 ms             | not published  |
| `jevk5`                         | 4b          | 0.625                               | SemIf, T = 1.532       | 105 ms             | **Apache-2.0** |
| `von`                           | 395m        | 0.447                               | input-conditioned      | 23 ms              | not published  |
| `laya:en` / `laya:multilingual` | 421m / 322m | 0.361                               | "calibrated answers"   | 9.6 ms             | not published  |

Per the ≤ 1 GB spike allowance, only `laya` (322m/421m) could be downloaded here;
its 0.361 accuracy makes it a CPU-latency floor, not a production gate. The
escalation ranking and the "what I would want" list are in the #418 decision
record, D4.

## What each leg gates (review F9)

- **The 4B leg gates T3.** T3 merges only after this ran against the **real
  `make llm-small` server** (the tracked flags; the four-slot discovery at
  `Makefile:59-67` matters when describe and decide share the box). The
  throwaway llama-server on port 18095 under a Metal-error sandbox proved
  feasibility, not production behaviour.
- **The memory-field rows gate #419 M2's thresholds.**
- **The cygnet leg gates only a D4 escalation**, never the v1 default.
