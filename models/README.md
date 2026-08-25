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
