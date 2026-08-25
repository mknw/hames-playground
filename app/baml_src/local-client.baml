// Local llama-server — GLM 4.7 Flash (OpenAI-compatible API)
// Start with: pnpm dev:llama
// Not used in any fallback chain — available for manual wiring only.
client<llm> LocalGLM {
  provider openai-generic
  options {
    base_url "http://127.0.0.1:8080/v1"
    model "glm-4-flash"
    api_key "local"
    max_tokens 2048
  }
}

// Local llama-server — small summarizer (Qwen3.5-4B class), `make llm-small`
// on port 8095.
//
// This is the designated describe-role replacement under the owned-inference
// tier: the describe work (compactBulkData batches, run titles, compactIntent)
// runs on AnthropicHaiku45 via the DescribeAnthropic chain today, and flips to
// this client when the tier is switched on. resolveClientForRole is
// deliberately NOT re-pointed yet — the flip lands with the Verda-hosted 27B
// that takes the heavy roles.
//
// No caching options: llama-server has no prompt cache to address, and
// Anthropic-style cache_control means nothing to an openai-generic endpoint.
// max_tokens 2048 is the describe tier's output size (same as LocalGLM);
// mirrored in CLIENT_MAX_OUTPUT_TOKENS, and MODEL_CONTEXT_WINDOWS carries the
// 32768 --ctx-size the Makefile target serves it with.
client<llm> LocalQwenSmall {
  provider openai-generic
  options {
    base_url "http://127.0.0.1:8095/v1"
    model "qwen3.5-4b-instruct"
    api_key "local"
    max_tokens 2048
  }
}
