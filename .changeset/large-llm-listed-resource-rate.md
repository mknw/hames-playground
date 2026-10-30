---
"@hames-ai/harness-baml": patch
---

The 27B time-price default is derived from Modal's listed resources instead of a hand-set figure (#873). `SEAM_DEFAULT_LARGE_LLM_EUR_PER_HOUR` rises 1.819 → 4.598976592 — the documented H100 box (H100 GPU, 4 cores, 64 GiB, broad `eu` compute) priced from Modal's dated list table (`app/src/lib/modal-pricing.ts`, read 2026-10-30) and converted once at `EUR_PER_USD`. The `LARGE_LLM_EUR_PER_HOUR` override and the per-call `configureCostRates` seam are unchanged.
