---
"@hames-ai/harness-baml": minor
---

Add `CostPricing.timePricedClients`, a selected-client to EUR/hour reader mapping, so every metered client includes usage-less timed attempts in cost floors. Existing `timePricedClient` string registrations remain supported through `verdaEurPerHour`; consumers can migrate to the mapping to price multiple clients. Add an optional `CostRates.smallLlmEurPerHour` reader with a package default of 1.54.
