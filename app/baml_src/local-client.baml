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

// Small summarizer (Qwen3.5-4B class) — the describe role's designated
// owned-inference replacement. Served locally by `make llm-small` on port 8095,
// or remotely: see "WHERE IT RUNS" below.
//
// Nothing is re-pointed yet — the flip lands with the Verda-hosted 27B that
// takes the heavy roles. The describe work runs on AnthropicHaiku45 via the
// DescribeAnthropic chain today; the block on that chain in anthropic-only.baml
// is the canonical list of which functions that is (six for `describe`, plus
// ScreenUntrustedContent on its own `screen` role).
//
// ── HOW THE FLIP ACTUALLY WORKS, because the obvious lever is the wrong one ──
//
//   * The lever is BAML. Either rewrite the SIX `client DescribeAnthropic`
//     lines the describe role owns (enumerated on the DescribeAnthropic block
//     in anthropic-only.baml) to `client LocalQwenSmall`, or declare a
//     `DescribeLocal` chain there and point those six lines at it. A function's
//     `client` line is the only thing that routes its call: there is no client
//     registry and no per-call client override anywhere under app/src/lib.
//
//   * NOT `resolveClientForRole` / `CLIENT_BY_ROLE` in clients.server.ts. That
//     map routes nothing — every non-test caller feeds it to `getContextWindow()`
//     or `CLIENT_MAX_OUTPUT_TOKENS`, so it is prompt/batch BUDGETING only.
//     Setting `describe: 'LocalQwenSmall'` there on its own leaves every call
//     going to Anthropic while prompts are sized for a 32768-token local window
//     — a silent mis-budget no test would catch. It is a MIRROR of the BAML
//     declarations: update it WITH the `client` lines, never instead of them.
//
//   * ScreenUntrustedContent (injection-screen.baml) STAYS on DescribeAnthropic.
//     It declares the same chain but is its own `screen` role (SA-M5): a screen
//     must not be talked out of reporting by the content it reviews, and must
//     copy spans VERBATIM so the guard can locate and neutralize them. Both are
//     what a small summarization model is worst at. Re-pointing the shared
//     DescribeAnthropic CHAIN — the one-line change that reads like "switch the
//     tier on" — would move the injection screen onto this 4B as a side effect.
//     Six lines, not the chain.
//
// ── WHERE IT RUNS ───────────────────────────────────────────────────────────
//
// `base_url` and `api_key` are env references (same form as VerdaQwen), so
// moving this model to a remote endpoint is env-vars-only, no code change:
//
//   SMALL_LLM_BASE_URL   OpenAI-compatible base, INCLUDING the `/v1` suffix.
//                        BAML options take an `env.X` reference, not an
//                        expression, so nothing can append the path for us and
//                        nothing can supply a default here either — the local
//                        value lives in app/.env.example, and this client is in
//                        no chain, so an unset var is inert until it is wired.
//   SMALL_LLM_API_KEY    Bearer token. llama-server ignores it; set it for a
//                        remote endpoint that checks one. Keep a placeholder
//                        rather than an empty string: openai-generic sends the
//                        header regardless, and some servers reject a blank one.
//
// The Data Stash embedder has the same shape on its own side —
// EMBEDDINGS_LOCAL_URL / EMBEDDINGS_LOCAL_API_KEY, see embeddings.server.ts.
//
// ── NUMBERS ─────────────────────────────────────────────────────────────────
//
// No caching options: llama-server has no prompt cache to address, and
// Anthropic-style cache_control means nothing to an openai-generic endpoint.
// max_tokens 2048 is the describe tier's output size (same as LocalGLM),
// mirrored in CLIENT_MAX_OUTPUT_TOKENS; MODEL_CONTEXT_WINDOWS carries the 32768
// --ctx-size `make llm-small` serves it with. client-output-caps.test.ts pins
// the first, client-context-windows.test.ts pins the second against the root
// Makefile. Behaviour note for the flip: 2048 re-imposes the batch floor
// compactBulkData.server.ts records from the removed mixed chains —
// `maxBatchItems()` returns 5 rather than the ceiling of 8, so a turn's tool
// results cost more describe calls here than on Haiku's 16384.
client<llm> LocalQwenSmall {
  provider openai-generic
  options {
    base_url env.SMALL_LLM_BASE_URL
    api_key env.SMALL_LLM_API_KEY
    model "qwen3.5-4b-instruct"
    max_tokens 2048
  }
}
