---
"@hames-ai/sandbox": patch
---

`PtyManager`: a shell that no subscriber ever attaches to now idles out after `IDLE_CLOSE_MS`, like one whose last subscriber left, and releases its container (#429). The idle clock used to start only when a subscriber unsubscribed, so a shell started by `ensure()` and never streamed held its VM until the process restarted. That case is reachable once starting a terminal and streaming it are two requests, which is how the host app's terminal route works since #429. The first `subscribe()` cancels the clock, so a stream that attaches within the window is unaffected.
