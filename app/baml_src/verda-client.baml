// Self-hosted inference — the company's own Qwen deployment on a Verda
// (DataCrunch) GPU, served by vLLM behind an OpenAI-compatible API.
//
// WHY IT EXISTS: a confidential-compute route. A prompt sent here never leaves
// infrastructure the company controls, which is a different property from
// "cheaper" or "faster" and is the only reason to accept the trade-offs below.
//
// NOT in any chain and not the default. It is reached only through
// `USE_VERDA_INFERENCE=1`, which re-points the controller / actor / critic /
// synthesizer roles in `harness-patterns/clients.server.ts`. With the flag
// unset nothing in this file is read.
//
// The deployment, for the numbers that had to match it:
//   vllm serve Qwen/Qwen3.8-27B-FP8 --tensor-parallel-size 1
//     --max-model-len 131072 --max-num-batched-tokens 16384
//     --gpu-memory-utilization 0.90 --language-model-only
//     --speculative-config {method:mtp,num_speculative_tokens:3}
// `--max-model-len 131072` is the server's hard ceiling on prompt+completion
// and is mirrored as VerdaQwen in MODEL_CONTEXT_WINDOWS (settings.ts); an
// earlier plan for this client assumed a 250k window, and the deployment wins.
//
// NO CACHING, DELIBERATELY. This client declares no `allowed_role_metadata`,
// and that omission is the control: the simpleLoop / actorCritic templates
// render `cache_control` breakpoints (#122), and BAML forwards them ONLY to a
// client that allowlists the key — so here they are dropped and no request
// asks anything to retain a prompt. Adding `allowed_role_metadata` to this
// client would silently opt confidential-compute traffic into prompt caching.
// Two limits on what that buys: vLLM's own prefix cache is a server flag on
// the deployment (`--enable-prefix-caching`), outside this repo's control, and
// the cache-hit savings the Anthropic chains rely on simply do not apply here.
//
// SCALE TO ZERO. The endpoint sleeps when idle, bills only while awake, and
// pays a cold start (container + 27B weight load) before answering the first
// request after a sleep — measured in minutes, not seconds. Hence the
// deliberately generous `request_timeout_ms`: the timeout has to survive a
// cold start, because the alternative is a client that reliably fails exactly
// the first call of every session. The cost of that generosity is that a
// genuinely hung warm call also waits it out, which is why the flag is
// all-or-nothing (one warm box per session) rather than per-call.
client<llm> VerdaQwen {
  provider openai-generic
  options {
    // The OpenAI-COMPATIBLE BASE — the deployment root plus `/v1`. Passed to
    // the provider verbatim (BAML options take an `env.X` reference, not an
    // expression, so nothing can append the path for us), which is why
    // `assertVerdaConfigured()` refuses a value that does not end in `/v1`:
    // without it every call 404s on `<root>/chat/completions`.
    base_url env.VERDA_INFERENCE_ENDPOINT
    api_key env.VERDA_INFERENCE_API_KEY
    // ⚠️ PLACEHOLDER — the one line in this repo that still needs a real value.
    // vLLM serves the model under the id `GET /v1/models` reports (the HF path
    // it was started with, unless `--served-model-name` overrode it), and the
    // deployment was unreachable when this landed: every authenticated request
    // was held open with no response, while an invalid bearer got a fast 404
    // from the gateway. Rather than commit a model string nobody has seen,
    // this stays an obviously-wrong constant, and `smoke-verda.ts` refuses to
    // run while it is here — so the first person to exercise the route gets
    // told to fill it in instead of debugging a 400 from vLLM.
    model "REPLACE_WITH_ID_FROM_V1_MODELS"
    // Mirror in CLIENT_MAX_OUTPUT_TOKENS (settings.ts) — enforced by
    // client-output-caps.test.ts. Matches the Sonnet 4.6 / Haiku 4.5 cap: the
    // controller envelope needs room for a large `tool_args`, and it is also
    // the server's `--max-num-batched-tokens`.
    max_tokens 16384
    // The Anthropic leaves declare no temperature at all, so there is no house
    // value to copy — they run at their provider default. This one is set low
    // on purpose: the only thing this client is asked to produce is the JSON
    // action envelope, an unmeasured model is the least safe place to sample
    // hot, and speculative decoding (mtp, 3 tokens) makes the sampler's job no
    // easier. UNMEASURED — if the envelope parses reliably, raising it is a
    // fair experiment; the #139 corpus method is how to settle it.
    temperature 0.2
    http {
      connect_timeout_ms 30000
      // ~10 minutes: sized for the cold start described above, NOT for a
      // healthy call (a warm turn answers in seconds).
      request_timeout_ms 600000
    }
  }
}
