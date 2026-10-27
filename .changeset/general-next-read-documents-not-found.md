---
"@hames-ai/agents": patch
---

`general-next`'s `read-documents` route description now also covers a file the user names that an earlier lookup (the info route) did not find, so the decision after an info result of "not found" has a criterion to match; the effect on routing has not yet been verified end to end.
