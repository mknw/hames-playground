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

# The describe/summarization model. The file is NOT in the repo yet — drop a
# Qwen3.5-4B-class GGUF into models/ under this name, or override it:
#   make llm-small LLM_SMALL_MODEL=<file>.gguf
LLM_SMALL_MODEL ?= Qwen3.5-4B-Instruct-Q8_0.gguf
LLM_SMALL_PORT ?= 8095

# A missing GGUF must fail here, loudly, rather than as a half-started server or
# a connection-refused three layers up in the harness. One message, both targets.
define require_model
@test -f "$(1)" || { echo "model file missing: $(1) — see models/README.md"; exit 1; }
endef

# --ctx-size 8192 handles long doc chunks; the default is too small and crashes
# the server on inputs above a few hundred tokens. Qwen3 supports up to 32k.
embed:
	$(call require_model,$(MODELS_DIR)/$(EMBED_MODEL))
	llama-server --embedding -m $(MODELS_DIR)/$(EMBED_MODEL) --host 127.0.0.1 --port $(EMBED_PORT) --ctx-size 8192

# --ctx-size 32768: compactBulkData batches up to 8 tool results of
# maxResultChars each (~16k tokens) into one describe call, so 32k leaves
# headroom. Keep it in step with MODEL_CONTEXT_WINDOWS.LocalQwenSmall in
# app/src/lib/settings.ts. No --parallel: one slot gets the whole window.
llm-small:
	$(call require_model,$(MODELS_DIR)/$(LLM_SMALL_MODEL))
	llama-server -m $(MODELS_DIR)/$(LLM_SMALL_MODEL) --host 127.0.0.1 --port $(LLM_SMALL_PORT) --ctx-size 32768
