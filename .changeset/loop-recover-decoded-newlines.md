---
"@hames-ai/harness-patterns": patch
---

Recover from JSON-decoded newlines in code arguments (#1018).

- A tool failure whose error is Python's unterminated single-line-string spelling (`unterminated string literal`, `EOL while scanning string literal`) and whose decoded arguments still show a raw line break inside a quoted (non-triple) string is recognised by `unterminatedStringFeedback` in `loop-recovery.server`. The loop appends the exact fix — write `\\n` in the JSON for a literal backslash-n in the code — to what the next round reads: `simpleLoop`'s turn log (and a released held call's re-dispatch), `actorCritic`'s attempt log, and the recovery's `feedback`, so a resume replays the same entry. The committed `tool_result` event keeps the error verbatim.
- Triple-quoted spans and `#` comments are masked before the scan, so a legitimate multi-line string never matches, and neither do the multi-line spellings of the failure (`unterminated triple-quoted string literal`, `EOF in multi-line string`). Heredocs split by what feeds them: the body of a heredoc not fed to Python is masked (its lines are literal content), while a heredoc fed to Python (`python3 - <<'PY'`, the shape the incident ran) has its body scanned as the script it is; a script-file argument or `-c` after the interpreter token makes the body data again.
- The decorated turn-log error is truncated at `maxResultChars` like the bare error it replaces (#440), on the live run and a resume alike.
