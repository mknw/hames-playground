---
"@hames-ai/harness-patterns": minor
---

`compactExecution` (thread mode) keeps the controller's answer on a Return-only turn (#610): when a `simpleLoop` controller answers without calling a tool, no tool iteration survives the terminal-`Return` drop and the synthesizer used to receive no turns. The loop now records its `Return` text as the new optional `returnText` on `SimpleLoopData` / `CompactExecutionData` (cleared by `continueSession` and at the start of each loop), and the synthesizer receives it as the response. An explicit `data.response` wins; a turn that called a tool is unchanged; an `actorCritic` `Return` never sets it. Affects agents that synthesize from a `simpleLoop` thread (`general`, `search`, `retriever-agent`, `microsoft-365`).
