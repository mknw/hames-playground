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
