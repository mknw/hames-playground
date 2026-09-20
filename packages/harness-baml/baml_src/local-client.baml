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

// Small summarizer (Qwen3.5-4B class) — the describe role's owned-inference
// model, and since 2026-08-26 the one it ACTUALLY runs on under the private
// tier. Served locally by `make llm-small` on port 8095, or remotely: see
// "WHERE IT RUNS" below.
//
// ── WHICH TIER REACHES IT, AND THROUGH WHICH SEAM ───────────────────────────
//
// The flip is per TIER, not per chain, and it went through the per-call
// override rather than through any `client` line here:
//
//   * ANTHROPIC TIER — unchanged. The six describe functions still declare
//     `client DescribeAnthropic` (→ AnthropicHaiku45) and still run there. The
//     canonical per-function list is the block on that chain in
//     anthropic-only.baml. Nothing in this file is read on that tier.
//
//   * PRIVATE TIER — `describe: 'LocalQwenSmall'` in `VERDA_CLIENT_BY_ROLE`
//     (harness-patterns/clients.server.ts) spreads `{ client: 'LocalQwenSmall' }`
//     into every describe call's options bag. That is the SAME seam the 27B
//     roles take; the private tier is now two models, not one — the heavy roles
//     on VerdaQwen and summarization here.
//
//   * WHY NOT the obvious lever. Rewriting the six `client DescribeAnthropic`
//     lines (or pointing them at a new `DescribeLocal` chain) would move
//     describe on BOTH tiers at once, which is not what was asked for, and it
//     would move ScreenUntrustedContent with them — see below. The `client`
//     line stays the Anthropic-tier declaration; the tier map is what re-points
//     it per call.
//
//   * `CLIENT_BY_ROLE` in clients.server.ts is still the BUDGETING mirror of the
//     `client` lines and still routes nothing. What routes is
//     `VERDA_CLIENT_BY_ROLE` beside it. Setting a client in the mirror alone
//     re-sizes prompts for a model no call reaches (a silent mis-budget); this
//     flip therefore lives in the map that routes, and the budgeting follows it
//     automatically because `resolveClientForRole` reports the override.
//
//   * ScreenUntrustedContent (injection-screen.baml) DOES NOT COME ALONG. It
//     declares the same DescribeAnthropic chain but is its own `screen` role
//     (SA-M5 / SD-4): a screen must not be talked out of reporting by the
//     content it reviews, and must copy spans VERBATIM so the guard can locate
//     and neutralize them character-for-character. Both are what a small
//     summarization model is worst at. On the private tier the screen stays on
//     VerdaQwen — a 27B — by owner decision (2026-08-26), and that decision is
//     the whole reason the two roles are separate: re-pointing the shared
//     DescribeAnthropic CHAIN, the one-line edit that reads like "switch the
//     describe tier on", would have dragged prompt-injection screening onto
//     this 4B as a side effect. The tier map moves the two roles independently,
//     on separate lines, which is exactly what a security control's client
//     needs.
//
//   * IF THIS ENDPOINT IS NOT CONFIGURED while the private tier is active, the
//     tier is REFUSED — loudly, at module load or at scope entry
//     (`assertPrivateTierConfigured`). Owner decision 2026-08-26: describe must
//     never silently descale back onto the 27B. Falling back would be a routing
//     change nobody asked for, made invisibly, on the role that is handed tool
//     results verbatim (SD-10).
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
//                        value lives in app/.env.example. NO LONGER INERT when
//                        unset: the private tier routes describe here, so
//                        `assertPrivateTierConfigured()` refuses that tier
//                        outright rather than letting the first summary 404.
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
// Makefile. Behaviour note, now live rather than prospective: 2048 re-imposes
// the batch floor compactBulkData.server.ts records from the removed mixed
// chains — `maxBatchItems()` returns 5 rather than the ceiling of 8, so a
// private-tier turn's tool results cost more describe calls than the same turn
// on Haiku's 16384. That is the cost of the flip and it is paid per turn.
//
// No CLIENT_PRICING entry, deliberately, and it is not the VerdaQwen case: this
// box is neither billed per token by a vendor nor per GPU-hour by this repo's
// own rate, so an invented figure would render as a confident price for a
// machine whose bill nobody here can see. Consequence, stated rather than
// discovered: a private-tier step that made a describe call reads as
// cost-unknown. Pricing it is an owner call (see the PR that landed the flip).
client<llm> LocalQwenSmall {
  provider openai-generic
  options {
    base_url env.SMALL_LLM_BASE_URL
    api_key env.SMALL_LLM_API_KEY
    model "qwen3.5-4b-instruct"
    max_tokens 2048
    // THINKING OFF, REQUEST-SIDE, for VerdaQwen's reason and one more.
    //
    // Qwen3.5 is a thinking model: with the chat template left to itself the
    // reasoning lands in `content` ahead of the answer (no reasoning parser is
    // configured on either server), and at 2048 output tokens a reasoning block
    // eats a two-line summary's whole budget — the failure mode is a degraded
    // parse, never an error.
    //
    // The extra reason is WHERE it runs. `make llm-small` bakes the equivalent
    // into the server it starts (see the root Makefile), so the local box was
    // already covered — but this client's whole point is that its host is an env
    // var, and a REMOTE 4B endpoint is somebody else's `vllm serve` with
    // somebody else's flags. Declaring it here makes the setting travel with the
    // client instead of with one machine's launch command. `openai-generic`
    // forwards an unrecognised option into the request body verbatim, which is
    // what puts it on the wire; `verda-body-shape.test.ts` renders one real request
    // per private-tier function offline — the six describe ones against THIS
    // client — and pins it, because nothing upstream would look wrong.
    chat_template_kwargs {
      enable_thinking false
    }
  }
}
