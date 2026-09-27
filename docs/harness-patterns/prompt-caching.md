# Prompt caching: bench record

> **Status.** Records one live run, on 2026-07-26, of the prompt-caching bench written for [issue #122](https://github.com/mknw/hames-playground/issues/122) (closed); the cache markers it measured now live in the BAML templates in [`packages/harness-baml/baml_src/`](../../packages/harness-baml/baml_src/), and the bench itself in the hames app's tests.

**Prompt caching** lets Anthropic reuse the unchanged opening part (the prefix) of a
request it has recently seen: that part is billed at a fraction of the normal input
price instead of in full. A template opts in by placing `cache_control` markers at
the points where the prefix may end. This page records the run that compared three
ways of placing those markers in the `ActorController` prompt, the controller of
the `actorCritic` pattern (an actor proposes a tool call, a critic judges the result).

## What became of it

The three-way comparison is settled. The bench's own summary: the three schemes
converged at about 89% of input tokens served from cache and about 64% lower cost,
the V2 and V3 arms were removed, and the bench now measures the production
controllers, so cache behaviour can be re-checked after any template change
([`prompt-cache-bench.test.ts`](../../app/src/__tests__/bench/prompt-cache-bench.test.ts),
docblock). The run below predates that summary and shows lower figures (69.8% from
cache, about 47% saved).

Where the markers live today:

- [`simpleLoop.baml`](../../packages/harness-baml/baml_src/simpleLoop.baml) and
  [`actorCritic.baml`](../../packages/harness-baml/baml_src/actorCritic.baml) carry
  the markers; the comment at the top of `simpleLoop.baml` lays out the two cached
  tiers and the two rolling markers on the turn log.
- Only the Anthropic clients in
  [`clients.baml`](../../packages/harness-baml/baml_src/clients.baml) forward the
  markers (`allowed_role_metadata ["cache_control"]`). The self-hosted client in
  [`verda-client.baml`](../../packages/harness-baml/baml_src/verda-client.baml)
  declares none, so on that tier the markers are dropped and nothing asks for a
  prompt to be retained.

## Running the bench

The bench is skipped unless `CACHE_BENCH=1` is set. It calls the Anthropic API
directly and prints the report below; it also writes it to
`.harness-logs/cache-bench-latest.md` under `app/`.

> **Warning.** The bench makes real, billed API calls. Its docblock estimates well under $0.10 per run at the introductory Sonnet 5 price it was written against.

> **Needs:** an Anthropic API key in `ANTHROPIC_API_KEY` or in `app/.env` — get one at [console.anthropic.com](https://console.anthropic.com).

```bash
# From app/, after the root install in the Quickstart (README.md).
CACHE_BENCH=1 pnpm vitest run src/__tests__/bench/prompt-cache-bench.test.ts
```

Today it runs the production prompt, and its table is labelled
`ActorController (production)` rather than V1, V2 and V3.

## The 2026-07-26 run

How to read the tables, from the bench's docblock:

- `in_total` = `uncached` + `cache_read` + `cache_write`, input tokens only;
  output tokens have no cached variant.
- Each variant makes four sequential calls, simulating one actor run with 0 to 3
  prior attempts, on identical scripted fixtures.
- A per-run salt makes every run start with a cold cache.
- The `hit` column is an estimate: the API reports total cache reads and writes,
  not which marker matched, so the bench compares `cache_read` against the
  estimated size of each marked prefix.

The report as printed, with its headings demoted to fit this page:

### Prompt-cache bench, 2026-07-26T21:08:31.411Z

Salt: `bench-1785100111411` · model per ControllerAnthropic chain · pricing $2/$10 per MTok (intro)

#### V1 ActorController (user arm)

| turn | in_total | uncached | cache_read | cache_write | out | ms   | $cached   | $nocache  | hit                                                 |
| ---- | -------- | -------- | ---------- | ----------- | --- | ---- | --------- | --------- | --------------------------------------------------- |
| 1    | 5772     | 216      | 0          | 5556        | 279 | 3794 | $0.017112 | $0.014334 | miss (wrote)                                        |
| 2    | 6161     | 243      | 5556       | 362         | 202 | 4018 | $0.004522 | $0.014342 | read 5556t ≈"Attempt 1 result: Result…" (est 5174t) |
| 3    | 6560     | 311      | 5918       | 331         | 273 | 3187 | $0.005363 | $0.015850 | read 5918t ≈"Attempt 2 result: Result…" (est 5429t) |
| 4    | 6891     | 311      | 6249       | 331         | 250 | 3471 | $0.005199 | $0.016282 | read 6249t ≈"Attempt 3 result: Result…" (est 5684t) |

**Totals:** input 25384t (69.8% served from cache) · $0.032197 with caching vs $0.060808 without → **47.1% saved**

#### V2 ActorControllerV2 (cookbook arm)

| turn | in_total | uncached | cache_read | cache_write | out | ms   | $cached   | $nocache  | hit                                                 |
| ---- | -------- | -------- | ---------- | ----------- | --- | ---- | --------- | --------- | --------------------------------------------------- |
| 1    | 5766     | 216      | 0          | 5550        | 264 | 3947 | $0.016947 | $0.014172 | miss (wrote)                                        |
| 2    | 6156     | 243      | 5550       | 363         | 234 | 3295 | $0.004843 | $0.014652 | read 5550t ≈"Attempt 1 result: Result…" (est 5171t) |
| 3    | 6553     | 310      | 5912       | 331         | 221 | 2869 | $0.004840 | $0.015316 | read 5912t ≈"Attempt 2 result: Result…" (est 5426t) |
| 4    | 6884     | 310      | 6243       | 331         | 229 | 2980 | $0.004986 | $0.016058 | read 6243t ≈"Attempt 3 result: Result…" (est 5681t) |

**Totals:** input 25359t (69.8% served from cache) · $0.031616 with caching vs $0.060198 without → **47.5% saved**

#### V3 ActorControllerV3 (template_string refactor of V2)

| turn | in_total | uncached | cache_read | cache_write | out | ms   | $cached   | $nocache  | hit                                                 |
| ---- | -------- | -------- | ---------- | ----------- | --- | ---- | --------- | --------- | --------------------------------------------------- |
| 1    | 5766     | 216      | 0          | 5550        | 249 | 2905 | $0.016797 | $0.014022 | miss (wrote)                                        |
| 2    | 6156     | 243      | 5550       | 363         | 239 | 2767 | $0.004894 | $0.014702 | read 5550t ≈"Attempt 1 result: Result…" (est 5171t) |
| 3    | 6553     | 310      | 5912       | 331         | 231 | 3314 | $0.004940 | $0.015416 | read 5912t ≈"Attempt 2 result: Result…" (est 5426t) |
| 4    | 6884     | 310      | 6243       | 331         | 301 | 3951 | $0.005706 | $0.016778 | read 6243t ≈"Attempt 3 result: Result…" (est 5681t) |

**Totals:** input 25359t (69.8% served from cache) · $0.032337 with caching vs $0.060918 without → **46.9% saved**

The test runner's closing lines from the same run:

```text
Report → app/.harness-logs/cache-bench-latest.md
 ✓ src/__tests__/bench/prompt-cache-bench.test.ts (1 test) 40677ms
   ✓ prompt-cache live bench: V1 vs V2 (1)
     ✓ runs both variants and writes the report  40676ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  23:08:30
   Duration  41.07s (transform 77ms, setup 12ms, import 18ms, tests 40.68s, environment 305ms)
```

Turn 1 of every variant costs more with caching than without, because writing a
prefix to the cache is billed above the normal input price; each later turn reads
that prefix back at a fraction of it, which is where the saving comes from.
