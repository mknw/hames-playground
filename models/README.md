# models/

GGUF weights for the local llama-servers. **Everything in this directory except
this file is gitignored** — the weights are hundreds of MB to several GB and are
never committed. Drop the files in by hand; the `Makefile` targets at the repo
root do the rest.

| File                             | Served by        | Port | Role                                                                                 |
| -------------------------------- | ---------------- | ---- | ------------------------------------------------------------------------------------ |
| `Qwen3-Embedding-0.6B-Q8_0.gguf` | `make embed`     | 8090 | Data Stash embeddings (1024-dim) — see [`docs/DATA_STASH.md`](../docs/DATA_STASH.md) |
| `Qwen3.5-4B-Instruct-Q8_0.gguf`  | `make llm-small` | 8095 | describe/summarization role (`LocalQwenSmall`) — **not present yet**                 |

The chat model on port 8080 (GLM-4.7-Flash, `pnpm dev:llama`) is not served from
here: it lives in llama.cpp's own cache, and `app/package.json` points at it
directly.

## Running either model on a REMOTE endpoint instead

Neither model is pinned to this machine. Both speak the OpenAI-compatible wire
format and both are addressed by URL, so pointing them at a hosted endpoint is
**env-vars-only** — no code change, no rebuild, no `pnpm baml-generate`. Set the
pair for whichever you are moving (values go in `app/.env`, documented in
[`app/.env.example`](../app/.env.example)):

| Model                               | URL                    | Optional bearer token      |
| ----------------------------------- | ---------------------- | -------------------------- |
| small summarizer (`LocalQwenSmall`) | `SMALL_LLM_BASE_URL`   | `SMALL_LLM_API_KEY`        |
| embedder (Data Stash)               | `EMBEDDINGS_LOCAL_URL` | `EMBEDDINGS_LOCAL_API_KEY` |

- **Include the `/v1` suffix** in both URLs. `/chat/completions` and
  `/embeddings` are appended verbatim, so a bare host 404s on every call.
- **The keys are optional.** llama-server authenticates nothing; leave them
  unset locally. When set they are sent as `Authorization: Bearer <key>`.
- `SMALL_LLM_*` has **no in-code default** — a BAML option takes a bare `env.X`
  reference, so the localhost value has to come from the env file. That is
  inert today: `LocalQwenSmall` is in no chain until the describe role is
  re-pointed at it (see `app/baml_src/local-client.baml`).
- **The embedding model must not change with the host.** Vectors are only
  comparable inside one model's space, so a remote embedder has to serve the
  _same_ Qwen3-Embedding-0.6B or the existing index is invalidated — see
  [`docs/DATA_STASH.md`](../docs/DATA_STASH.md).

## Notes

- **The embedding GGUF used to live in `~/Code/h9s/models/`.** It was moved here
  so there is exactly one copy on the machine; h9s's own `make embed` now points
  at this directory by absolute path.
- **A different filename** is fine — override the variable rather than renaming
  the file: `make llm-small LLM_SMALL_MODEL=<file>.gguf`.
- **From a git worktree** this directory is empty (it is gitignored, so it does
  not travel). Point the target at the main checkout:
  `make embed MODELS_DIR=/Users/you/Code/kg-agent/models`.
- A missing file makes the target fail with `model file missing: <path>` before
  llama-server starts, rather than leaving a dead port for the harness to find.
