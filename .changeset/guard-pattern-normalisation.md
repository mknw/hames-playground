---
"@hames-ai/harness-patterns": patch
---

**The injection guard normalises a URL scheme before matching.** A URL scheme is case-insensitive (RFC 3986 §3.1), and `exfil-data-url` now matches it that way, as the guard's other URL rules already did. Nothing else in the pattern changes.
