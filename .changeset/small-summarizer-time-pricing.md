---
"@hames-ai/harness-baml": minor
---

Add `CostPricing.timePricedClients`, a selected-client to EUR/hour reader mapping, so every metered client includes usage-less timed attempts in cost floors. Existing `timePricedClient` string registrations remain supported through `verdaEurPerHour`; consumers can migrate to the mapping to price multiple clients. `opts.eurPerHour` is now passed only for clients registered in `timePricedClients` (or the legacy `timePricedClient`).
