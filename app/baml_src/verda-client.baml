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
// request after a sleep. Measured 2026-08-26: 146s for a 21-token completion
// on a single request to a sleeping box. Hence the deliberately generous
// `request_timeout_ms`: the timeout has to survive a cold start, because the
// alternative is a client that reliably fails exactly the first call of every
// session. Which is why the flag is all-or-nothing (one warm box per session)
// rather than per-call.
//
// WHAT THAT GENEROSITY ACTUALLY COSTS, measured the same day and worse than
// the "a hung warm call also waits it out" this comment used to claim. Three
// chats sent in quick succession into a sleeping box are ONE replica's queue,
// not three cold starts in parallel: two of them were still unanswered at
// 600 000ms and ended as `BamlTimeoutError`, while the deployment's own
// gateway had meanwhile answered a sibling call with
// `504 {"error":"inference request was canceled"}` after 55s. So the platform
// gives up on a queued request long before this timeout does, and every second
// past that point is spent waiting for a reply that will never arrive — ten
// minutes of it, per call, twice per turn (controller then synthesizer).
// Lowering it is a real option and an OWNER decision, because the number
// trades "survive a cold start" against "notice a cancelled request", and
// nothing in this repo has measured where the platform's own ceiling sits.
// What is NOT a judgement call, and is fixed: a turn that spends that time and
// comes back with nothing is no longer recorded as a success (`settleTurn` in
// `harness-patterns/harness.server.ts`), and the SSE stream no longer goes
// byte-silent for the whole wait (`SSE_KEEPALIVE_MS` in `routes/api/events.ts`).
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
    // The id `GET /v1/models` reports, i.e. the HF path vLLM was started with
    // (no `--served-model-name` override on this deployment). Read live on
    // 2026-08-25 and pinned here; exactly one model is served, and vLLM 400s a
    // request naming any other id.
    model "Qwen/Qwen3.8-27B-FP8"
    // THINKING OFF, AND THIS IS NOT A TUNING KNOB. Qwen3.8 is a thinking
    // model: its chat template opens a reasoning block unless the template is
    // told not to, and this deployment runs vLLM with no reasoning parser, so
    // the reasoning is NOT split into `reasoning_content` — it lands in
    // `content`, in front of the answer, with a stray `</think>` between them.
    // Measured live against the same one-line prompt:
    //   without → content 'We need to respond to user: ... </think>\n\n{"ok": true}'
    //   with    → content '{"ok": true}'   (23 prompt tokens, not 63)
    // Two consequences for a structured-output client. The prose ahead of the
    // envelope is what BAML has to parse, and at controller size the reasoning
    // eats the `max_tokens` budget the action envelope needs — the exact
    // truncation failure `llmCallHitOutputCap` exists to recover from, except
    // here it would fire on every call. So this is a correctness setting.
    //
    // HOW IT REACHES THE WIRE: `openai-generic` forwards every option it does
    // not recognise into the request body verbatim, so this map is emitted as
    // the top-level `chat_template_kwargs` field vLLM reads. Nothing in
    // `clients.server.ts` or the adapters passes it — declaring it on the
    // client is what makes it unconditional, i.e. it cannot be forgotten at a
    // call site the way a per-call option could. `verda-body-shape.test.ts`
    // renders a real request offline and pins the field, because a silent typo
    // here degrades to "the model thinks out loud again" rather than an error.
    chat_template_kwargs {
      enable_thinking false
    }
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
      // healthy call (a warm turn answers in seconds). See the SCALE TO ZERO
      // note above before changing it — it is longer than the deployment's own
      // request ceiling, which is a measured trade-off, not an oversight.
      request_timeout_ms 600000
    }
  }
}
