---
"@hames-ai/harness-patterns": patch
"@hames-ai/sandbox": patch
---

Record MCP tool failures as failures, and bound stash search (#440, #707).

- A gateway tool result with `isError: true` is now `{ success: false, data: null, error }`, whatever its text says. Before, only text starting with `Error:` counted as a failure. The error is the result's text blocks joined by newlines. A result with no text uses its `structuredContent` as JSON, and one with neither uses a fixed message. The `Error:` prefix rule still applies to servers that do not set the flag.
- The in-VM sandbox transport now also puts a failure's text on `error`. `data` still holds the parsed payload, because the shell's `{ stdout, stderr, exit_code }` lives there.
- `simpleLoop`'s controller turn log truncates a failed call's `error` to `maxResultChars`, as it already truncated `result`. For an all-failed batch, the joined errors are truncated the same way.
- `MAX_SEARCH_SPAN` (200) is exported from `stash/document-ingest.server`. The search loop now caps its first query at that ceiling, so a `k` above it no longer sends one oversized vector query.
