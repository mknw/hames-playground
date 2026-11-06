---
"@hames-ai/harness-patterns": patch
---

Recover from JSON-decoded newlines in code arguments (#1018).

- A tool failure whose error is Python's unterminated single-line-string spelling (`unterminated string literal`, `EOL while scanning string literal`) and whose decoded arguments still show a raw line break inside a quoted (non-triple) string is recognised by `unterminatedStringFeedback` in `loop-recovery.server`. The loop appends the exact fix — write `\\n` in the JSON for a literal backslash-n in the code — to what the next round reads: `simpleLoop`'s turn log (and a released held call's re-dispatch), `actorCritic`'s attempt log, and the recovery's `feedback`, so a resume replays the same entry. The committed `tool_result` event keeps the error verbatim.
- Triple-quoted spans, heredoc bodies and `#` comments are masked before the scan, so legitimate multi-line strings and heredoc prose never match, and neither do the multi-line spellings of the failure (`unterminated triple-quoted string literal`, `EOF in multi-line string`).
