# models/

GGUF weights for the local llama-servers. The weights are gitignored; this file
and `embedder.lock` are tracked. For the CPU embedder, run from the repo root:

```bash
python3 scripts/prepare-embedder.py models
```

The bootstrap's `boot` stage runs this automatically before starting services.
The lock pins the Hugging Face repository, full revision commit, filename,
SHA-256 and 1024 dimensions. Its checksum comes from the file's [LFS metadata
at that revision](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/blob/370f27d7550e0def9b39c1f16d3fbaa13aa67728/Qwen3-Embedding-0.6B-Q8_0.gguf).
Downloads use a temporary file and are renamed only after verification. Re-runs
verify the existing file without downloading; symlinks, non-regular inputs and
checksum mismatches refuse (remove the incorrect GGUF and retry). Before every
start, including restarts, the compose entrypoint copies the input without
following symlinks into a container-private regular snapshot, verifies that
snapshot and passes it to the server. Host-side renames or writes cannot change
the verified copy. Each restart replaces the previous snapshot; allow disk space
for that additional GGUF copy. `boot` waits for embedder health and `smoke` makes one
internal `/v1/embeddings` request and requires 1024 finite numbers. No model port
is published. CPU RSS, latency, ingest time and the 2 GiB limit remain unmeasured;
measure on the deployment before choosing capacity. Other GGUFs are supplied
manually; the `Makefile` targets at the repo root run them.

| File                             | Served by                                                                                        | Port | Role                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------ |
| `Qwen3-Embedding-0.6B-Q8_0.gguf` | `make embed`, or the compose `embedder` service (mounts `./models` read-only; no published port) | 8090 | Data Stash embeddings (1024-dim) — see [`docs/DATA_STASH.md`](../docs/DATA_STASH.md) |
| `Qwen3.5-4B-Instruct-Q8_0.gguf`  | `make llm-small`                                                                                 | 8095 | describe/summarization role (`LocalQwenSmall`) (the private tier)                    |

The chat model on port 8080 (GLM-4.7-Flash, `pnpm dev:llama`) is not served from
here: it lives in llama.cpp's own cache, and `app/package.json` points at it
directly.

## Running either model on a REMOTE endpoint instead

Neither model is pinned to this machine. Both speak the OpenAI-compatible wire
format and both are addressed by URL, so pointing them at a hosted endpoint is
**env-vars-only** — no code change, no rebuild, no `pnpm baml-generate`. Set the
pair for whichever you are moving (values go in `app/.env`, documented in
[`app/.env.example`](../app/.env.example)):

| Model                               | URL                    | Bearer token               |
| ----------------------------------- | ---------------------- | -------------------------- |
| small summarizer (`LocalQwenSmall`) | `SMALL_LLM_BASE_URL`   | `SMALL_LLM_API_KEY`        |
| embedder (Data Stash)               | `EMBEDDINGS_LOCAL_URL` | `EMBEDDINGS_LOCAL_API_KEY` |

- **Include the `/v1` suffix** in both URLs. `/chat/completions` and
  `/embeddings` are appended verbatim, so a bare host 404s on every call.
- **The private tier requires `SMALL_LLM_API_KEY`.** It is shared by the
  summarizer and the systemone endpoint at `SMALL_LLM_DECISIONS_URL` (a full
  URL ending in `/v1/systemone`), even when a local llama-server accepts
  unauthenticated summarization. The embedding key is optional for a server
  without authentication. Keys are sent as `Authorization: Bearer <key>`.
- `SMALL_LLM_*` has **no in-code default** — set the base URL in the env file.
  `LocalQwenSmall` already serves the private tier's `describe` role through
  the per-call override in `packages/harness-baml/clients.server.ts`; the
  Anthropic BAML chain declarations stay unchanged. The whole tier requires
  all five values listed in [`docs/PREVIEW.md` §6](../docs/PREVIEW.md#6-boot),
  as specified in `CLAUDE.md`.
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
- **From a git worktree** only the README and lock travel. Fetch the embedder as
  above, or point the target at a checkout that already has the weights:
  `make embed MODELS_DIR=/Users/you/Code/hames-playground/models`.
- A missing file makes the target fail with `model file missing: <path>` before
  llama-server starts, rather than leaving a dead port for the harness to find.
