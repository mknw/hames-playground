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
// SCALE TO ZERO, AND THE COLD START IS NO LONGER THIS CLIENT'S PROBLEM. The
// endpoint sleeps when idle, bills only while awake, and pays a cold start
// (container + 27B weight load) before answering the first request after a
// sleep. Measured 2026-08-26: 146s for a 21-token completion on a single
// request to a sleeping box.
//
// That wait is now paid OUT IN FRONT of the harness, by one throwaway wake
// request with its own 300s bound (`app/src/lib/inference/wake.server.ts`,
// wired in `harness-client/turn.server.ts`). No BAML call on this client starts
// until the box has answered something, so `request_timeout_ms` below no longer
// has to survive a cold start — it is a WARM-CALL budget, which is what makes
// the number below defensible instead of merely generous.
//
// WHY THE OLD 600 000 HAD TO GO, and it was not tidiness. The measurements that
// set it also condemned it. Three chats sent in quick succession into a sleeping
// box are ONE replica's queue, not three cold starts in parallel, so a burst
// multiplied its own wait. Under that queueing TWO DISTINCT platform behaviours
// were observed, and they are mutually exclusive readings rather than two halves
// of one story:
//   - two calls returned NOTHING, were still unanswered at 600 000ms and ended
//     as `BamlTimeoutError` — on the evidence they were either never cancelled
//     or the cancellation never reached the client;
//   - a different call WAS given up on by the deployment's own gateway, and
//     said so PROMPTLY: `504 {"error":"inference request was canceled"}` at
//     55s. That client learned within a minute and burned no timeout.
// Which behaviour applies when is still UNMEASURED; 55s is one observation under
// queueing, not a contract. What the wake ping does is make the disagreement
// stop mattering for this number: the case FOR 600s was only ever "a cold start
// must be able to finish", and nothing here pays a cold start any more. The case
// AGAINST it is untouched — a request that is silently dropped is
// indistinguishable from a working one for the whole timeout, and ten minutes of
// that is ten minutes of a user watching nothing.
//
// WHERE 120 000 COMES FROM. The load test measured this deployment WARM at a
// 2.75k-token prompt (2026-08-25, `smoke-verda-load.ts`): 4.1s for a single
// call, 6.3s p50 and 9.9s p95 with 8 requests in flight, one replica, so
// concurrency is queueing rather than scaling. 120s is ~12x that p95, which
// leaves room for a longer prompt, a deeper queue and a slower day, and still
// gives up an order of magnitude sooner than before. It is deliberately not
// tight: an aborted call is a failed turn, and the p95 was measured at one
// prompt size on one day. Two things it must stay clear of, in both directions:
//   - the ~150s FLOOR the old comment named no longer binds this client, because
//     the wake ping absorbs the first call of a session — that floor moved to
//     `VERDA_WAKE_TIMEOUT_MS`, and lowering THAT below ~150s would reliably fail
//     the first turn of every session;
//   - it is above the 55s at which the platform's own gateway was once seen to
//     cancel, so a prompt 504 still surfaces as a 504 rather than as our
//     timeout — which is the more diagnosable of the two.
// What is NOT a judgement call, and is fixed: a turn that spends that time and
// comes back with nothing is no longer recorded as a success (`settleTurn` in
// `harness-patterns/harness.server.ts`), and the SSE stream no longer goes
// byte-silent for the whole wait (`SSE_KEEPALIVE_MS`, declared in
// `lib/sse-client.ts` beside the parser that drops it — NOT in
// `routes/api/events.ts`, which is the one module it cannot live in). And the
// wait is now VISIBLE: a turn-level `warming` frame carries a spinner, the
// words "starting GPU" and a counting-down estimate into the chat, in place of
// the progress bar, for as long as the box is starting
// (`lib/inference/cold-start.server.ts`) — emitted by the wake ping, before it
// goes on the wire, so the notice lands inside the wait rather than beside it.
// The keep-alive was never that — a
// comment frame is invisible to a human by construction — so the two are
// complementary rather than one covering for the other. The estimate defaults
// to the 146s above until a server has measured one of its own; that constant
// is `COLD_START_FALLBACK_MS`, and this comment is its provenance. It is also
// the floor's provenance: a reading below a quarter of it is dropped rather
// than recorded, because nothing that fast starts a container and loads 27B of
// weights, and the alternative is a warm ~4s call entering the history as a
// measured "cold start" whenever the app's configured scale-down window is
// shorter than the deployment's own.
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
      // 2 minutes: a WARM-call budget, ~12x the measured 9.9s p95 at 8-way
      // concurrency. It is no longer sized for a cold start — the wake ping
      // ahead of the harness pays that, and its own bound is
      // `VERDA_WAKE_TIMEOUT_MS`. Read the SCALE TO ZERO note above before
      // changing either number; they are one decision split across two files
      // and raising this one back up would quietly re-create the ten minutes of
      // indistinguishable-from-working that the wake ping exists to end.
      request_timeout_ms 120000
    }
  }
}
