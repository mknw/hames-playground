# Prompt caching 

This file documents the efforts made under the worktrees `prompt-caching-122`.

A result of the general tests (for 3 different prompt caching models) are as follow:

```
prompt-caching-122/ui on  mknw/issue-122-prompt-caching [!] via  v22.21.1 via ❄️  impure (nix-shell-env)
❮ CACHE_BENCH=1 pnpm vitest run src/__tests__/bench/prompt-cache-bench.test.ts

 RUN  v4.1.5 /Users/mknw/Code/harness-playground-worktrees/prompt-caching-122/ui
```

# Prompt-cache bench — 2026-07-26T21:08:31.411Z
Salt: `bench-1785100111411` · model per ControllerAnthropic chain · pricing $2/$10 per MTok (intro)

## V1 ActorController (user arm)

| turn | in_total | uncached | cache_read | cache_write | out | ms | $cached | $nocache | hit |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 5772 | 216 | 0 | 5556 | 279 | 3794 | $0.017112 | $0.014334 | miss (wrote) |
| 2 | 6161 | 243 | 5556 | 362 | 202 | 4018 | $0.004522 | $0.014342 | read 5556t ≈"Attempt 1 result:     Result…" (est 5174t) |
| 3 | 6560 | 311 | 5918 | 331 | 273 | 3187 | $0.005363 | $0.015850 | read 5918t ≈"Attempt 2 result:     Result…" (est 5429t) |
| 4 | 6891 | 311 | 6249 | 331 | 250 | 3471 | $0.005199 | $0.016282 | read 6249t ≈"Attempt 3 result:     Result…" (est 5684t) |

**Totals:** input 25384t (69.8% served from cache) · $0.032197 with caching vs $0.060808 without → **47.1% saved**

## V2 ActorControllerV2 (cookbook arm)

| turn | in_total | uncached | cache_read | cache_write | out | ms | $cached | $nocache | hit |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 5766 | 216 | 0 | 5550 | 264 | 3947 | $0.016947 | $0.014172 | miss (wrote) |
| 2 | 6156 | 243 | 5550 | 363 | 234 | 3295 | $0.004843 | $0.014652 | read 5550t ≈"Attempt 1 result:     Result…" (est 5171t) |
| 3 | 6553 | 310 | 5912 | 331 | 221 | 2869 | $0.004840 | $0.015316 | read 5912t ≈"Attempt 2 result:     Result…" (est 5426t) |
| 4 | 6884 | 310 | 6243 | 331 | 229 | 2980 | $0.004986 | $0.016058 | read 6243t ≈"Attempt 3 result:     Result…" (est 5681t) |

**Totals:** input 25359t (69.8% served from cache) · $0.031616 with caching vs $0.060198 without → **47.5% saved**

## V3 ActorControllerV3 (template_string refactor of V2)

| turn | in_total | uncached | cache_read | cache_write | out | ms | $cached | $nocache | hit |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 5766 | 216 | 0 | 5550 | 249 | 2905 | $0.016797 | $0.014022 | miss (wrote) |
| 2 | 6156 | 243 | 5550 | 363 | 239 | 2767 | $0.004894 | $0.014702 | read 5550t ≈"Attempt 1 result:     Result…" (est 5171t) |
| 3 | 6553 | 310 | 5912 | 331 | 231 | 3314 | $0.004940 | $0.015416 | read 5912t ≈"Attempt 2 result:     Result…" (est 5426t) |
| 4 | 6884 | 310 | 6243 | 331 | 301 | 3951 | $0.005706 | $0.016778 | read 6243t ≈"Attempt 3 result:     Result…" (est 5681t) |

**Totals:** input 25359t (69.8% served from cache) · $0.032337 with caching vs $0.060918 without → **46.9% saved**

Report → ui/.harness-logs/cache-bench-latest.md
 ✓ src/__tests__/bench/prompt-cache-bench.test.ts (1 test) 40677ms
   ✓ prompt-cache live bench: V1 vs V2 (1)
     ✓ runs both variants and writes the report  40676ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  23:08:30
   Duration  41.07s (transform 77ms, setup 12ms, import 18ms, tests 40.68s, environment 305ms)
```
