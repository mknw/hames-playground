# #418 spike — run log

**Status: NOT RUN. The model servers were not reachable at spike time.**

`spike.mjs` performs a bounded preflight (`GET {base}/health`, 10 s) and, per the
task rule, **skips the spike and exits 2** when the server is not up. It never
starts or stops a model. The script is kept on this branch so the measurement can
be produced the moment a box is available.

## Reachability, measured

| Target | Probe | Result |
| --- | --- | --- |
| `http://127.0.0.1:8890` (cygnet, `ggml-org/gemma-4-12B-it-GGUF:Q8_0`) | `GET /v1/models`, `POST /v1/chat/completions` | connection refused (`curl` exit 7); `lsof` shows no listener |
| `http://127.0.0.1:8095` (the `LocalQwenSmall` 4B, `make llm-small`) | `GET /v1/models` | connection refused (exit 7) |
| `http://127.0.0.1:8080` (`pnpm dev:llama`, GLM-4.7-Flash) | `GET /v1/models` | connection refused (exit 7) |
| `http://127.0.0.1:8090` (`make embed`) | `GET /v1/models` | connection refused (exit 7) |

Observed from this worktree on 2026-10-06T22:23Z. No listener on any of the four
ports. The script's own preflight then printed:

```
#418 cygnet spike — http://127.0.0.1:8890 — 2026-10-06T22:23:12.068Z
server not reachable: unreachable (fetch failed) — skipping the spike per the task rules.
```

## What the script measures when a box is up

`node scripts/spike-418-cygnet/spike.mjs [--url http://127.0.0.1:8890] [--small http://127.0.0.1:8095]`

- 22 synthetic cases (within the 20–40 asked for): 12 memory cases scored
  across the three hook fields (`memory.target` 3 labels, `memory.confirm` 2,
  `memory.kind` 4 → 36 scoring rows) and 10 injection cases for the merged
  `document.injection` question (2 labels → 10 scoring rows).
- Memory kind uses the owner's 2026-10-03 wording (`episodic | semantic | …`);
  the case set is the two-tier `episodic | semantic | preference | none` shape
  this lane proposes for the kind field.
- Readout: `max_tokens: 1`, `logprobs: true`, `top_logprobs: 30`, one letter.
  Every top-k token that trims to a bare `A`..`Z` is summed (vocabularies carry
  `A`, ` A`, `(A`), then renormalised over the label set; the leftover mass is
  reported as `coverage`.
- Thinking off per request (`chat_template_kwargs { enable_thinking: false }`),
  with a raw `/completion` fallback (`n_probs`, `n_predict: 1`) if the chat
  readout's letter coverage is below 0.05.
- Raw probabilities and cygnet's fitted calibration (`T = 3.4` applied to the
  letter probabilities) are both scored: accuracy, ECE (10 equal-confidence
  buckets), Brier, mean latency, mean coverage.
- Multi-field cost: **N single passes, shared state prefix, issued in parallel**
  versus **one combined pass over the 3 × 2 × 4 = 24-letter product**. Reports
  wall time and all-fields-correct for both.
- Optional 4B comparison on `--small` (the `LocalQwenSmall` box).
- Writes `results-<timestamp>.json` plus a Markdown digest beside this file.
  All data is synthetic; no real names.

## Design reading while the measurement is owed

The recommendation in #418's decision record (own `decide` role; private tier on
`LocalQwenSmall` first, a `/v1/systemone` decision server as the measured
escalation) does **not** depend on this spike. It rests on measurements already in
the issue (the 4B round trip through BAML on `llama-server`, the tokenisation of
label names, the unconstrained top-k) and on the fact that a 12B cygnet box is
not deployed here. The spike is what would change that ranking, and it is the
first thing to run if a cygnet endpoint is ever up.
