---
"@hames-ai/harness-patterns": patch
---

**`decisionLoop`: an actorCritic record that shows a saved `/work/out` deliverable ends in a fixed echoable line.** The record Synthesize reads for the office route's deliverable now closes with `Saved to /work/out/<name> (not indexed by this route; the user can index it for search from the Data Stash)`, built by code from the accepted attempt's own tool results — no new model call. This is the residual of #507 run 9: the synthesizer inverted the critic's prose into "Saved and indexed for this chat"; the record now carries the truth itself, and the line's wording is the #836 route-description sentence's own ("never indexed by this route"), so it stays true whatever the person does later. The line's budget comes off the quoted body's share, so the record stays within its cap. Only actorCritic records carry the line: a simpleLoop Return or a planner plan naming the same path does not.
