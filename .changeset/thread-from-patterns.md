---
"@hames-ai/harness-patterns": patch
---

`compactExecution` `thread` mode honours `viewConfig.fromPatterns`: when the caller names patterns, the thread is read from those patterns' records instead of the last pattern to enter. Under a wrapper whose children run in nested views, the old read selected a child outside the named set, found nothing, and silently dropped to `response` mode. Without `fromPatterns` nothing changes. (#507)
