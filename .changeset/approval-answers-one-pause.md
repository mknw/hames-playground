---
"@hames-ai/harness-patterns": patch
---

An approval given through `resumeHarness` now answers only the pause it resumes (#456 c′). `resumeHarness` writes `approved` onto `ctx.data` for the resumed run. `continueSession` never cleared it, so after one approval `data.approved === true` rode every later turn, and a gate reached again went ahead without asking. `continueSession` now deletes `approved` along with `hasError`, `errorMessage` and `response`. A rejection (`approved: false`) is cleared the same way, so a later turn asks again instead of refusing on the old answer.

**Behaviour change for callers**: if your gate relied on an approval lasting into later turns, it now pauses again on each turn that reaches it. The resumed run itself still sees `approved`, and `resumeHarness`'s result still reports it.
