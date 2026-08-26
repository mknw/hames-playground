# Local model servers — the on-machine half of the owned-inference tier.
#
# Three llama-servers, three ports, and mixing them up is the trap:
#
#   8080  chat, GLM-4.7-Flash              `pnpm dev:llama` from app/ (no target here)
#   8090  embeddings, Qwen3-Embedding-0.6B `make embed`     — Data Stash
#   8095  chat, small summarizer           `make llm-small` — describe role (LocalQwenSmall)
#
# The GGUF weights live in models/, which is gitignored — see models/README.md.
# Both targets run in the FOREGROUND: one server per terminal.

.PHONY: embed llm-small

# Where the GGUF files are. Relative to the repo root by default; a git worktree
# has no models/ of its own, so point it at the main checkout instead:
#   make embed MODELS_DIR=/Users/you/Code/kg-agent/models
MODELS_DIR ?= models

EMBED_MODEL ?= Qwen3-Embedding-0.6B-Q8_0.gguf
EMBED_PORT ?= 8090

# Bind address. llama-server already defaults to 127.0.0.1, so the flag changes
# nothing on the default path — but an explicit --host OVERRIDES LLAMA_ARG_HOST,
# so hardcoding it would remove the only knob the containerized path has:
# docker-compose.yaml points the app at host.docker.internal:8090, which a
# loopback-bound server never answers. `make embed EMBED_HOST=0.0.0.0`.
EMBED_HOST ?= 127.0.0.1

# The describe/summarization model. The file is NOT in the repo yet — drop a
# Qwen3.5-4B-class GGUF into models/ under this name, or override it:
#   make llm-small LLM_SMALL_MODEL=<file>.gguf
LLM_SMALL_MODEL ?= Qwen3.5-4B-Instruct-Q8_0.gguf
LLM_SMALL_PORT ?= 8095
# Bind address — see EMBED_HOST above.
LLM_SMALL_HOST ?= 127.0.0.1

# A missing GGUF must fail here, loudly, rather than as a half-started server or
# a connection-refused three layers up in the harness. One message, both targets.
define require_model
@test -f "$(1)" || { echo "model file missing: $(1) — see models/README.md"; exit 1; }
endef

# --ctx-size 8192 handles long doc chunks; the default is too small and crashes
# the server on inputs above a few hundred tokens. Qwen3 supports up to 32k.
embed:
	$(call require_model,$(MODELS_DIR)/$(EMBED_MODEL))
	llama-server --embedding -m $(MODELS_DIR)/$(EMBED_MODEL) --host $(EMBED_HOST) --port $(EMBED_PORT) --ctx-size 8192

# --ctx-size 32768: generous headroom, not a fitted number. compactBulkData
# truncates each tool result at `maxResultForSummary` (3000 chars, settings.ts)
# and derives the batch from the describe OUTPUT cap — `maxBatchItems()` returns
# floor(2048 * 0.5 / 200) = 5 at LocalQwenSmall's max_tokens 2048, not the
# ceiling of 8 — so the real worst case is ~5 x 3000 chars, about 3.7k tokens.
# Note the behaviour that 2048 cap carries: it re-imposes the batch-of-5 floor
# compactBulkData.server.ts records from the removed mixed chains, so a turn's
# tool results cost more describe calls here than on Haiku's 16384.
# Keep this number in step with MODEL_CONTEXT_WINDOWS.LocalQwenSmall in
# app/src/lib/settings.ts — client-context-windows.test.ts parses this line and
# fails if the two drift. No --parallel: one slot gets the whole window.
# --chat-template-kwargs disables Qwen3.5's thinking mode server-side. Without
# it the model spends the ENTIRE completion budget in reasoning_content and
# returns empty content at describe-sized caps (verified live 2026-08-25;
# --reasoning-budget 0 does NOT prevent it). Same stance as the measured
# no-thinking describe/controller finding in CLAUDE.md.
llm-small:
	$(call require_model,$(MODELS_DIR)/$(LLM_SMALL_MODEL))
	llama-server -m $(MODELS_DIR)/$(LLM_SMALL_MODEL) --host $(LLM_SMALL_HOST) --port $(LLM_SMALL_PORT) --ctx-size 32768 --chat-template-kwargs '{"enable_thinking":false}'
