---
"@hames-ai/harness-patterns": patch
---

`compactExecution` (thread mode) keeps the controller's answer on a Return-only turn (#610): when the controller answers without calling a tool, no real iteration survives the terminal-`Return` drop and the synthesizer used to receive no turns. The last `Return`'s text now reaches it as the response; an explicit `data.response` wins, and a turn that called a tool is unchanged. Applies to every agent that synthesizes from a `simpleLoop` thread (`general`, `general-next`).
