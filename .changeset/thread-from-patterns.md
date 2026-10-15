---
"@hames-ai/harness-patterns": patch
---

`compactExecution` `thread` mode honours `viewConfig.fromPatterns`: when the caller names patterns, the thread is every execution of those patterns within the view's turn window (the caller's `fromLastNTurns`, else the current turn), in log order, instead of the last pattern to enter. Under a wrapper whose children run in nested views, the old read selected a child outside the named set, found nothing, and silently dropped to `response` mode. Without `fromPatterns` nothing changes. Behaviour change for `general` (the only production caller with `fromPatterns`): on a HITL resume the paused `execute` re-enters with no new user message, so synthesis now reads both the pre-pause and post-resume iterations, where it used to read only the post-resume ones; likewise two named patterns that both act are both read. A name that matches no pattern in the window still yields no history and `response` mode (#507)
