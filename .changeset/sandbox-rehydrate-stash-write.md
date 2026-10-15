---
"@hames-ai/harness-patterns": minor
"@hames-ai/sandbox": minor
---

`withSandbox({ id, syncWorkspace: true })` now copies a document a tool stored mid-run into `/work/in` straight after that call, instead of only when the route is next entered. Core gains two concatenating run-frame slots to do it without a tool-name list: `stashWriteObservers` (told by `storeDocument` once a document is durably stored) and `afterToolCall` (run by `callTool` after dispatch and guard, may replace the result). The copy is `hydrateWorkspace` for the sandbox's own session only; a write to another conversation's stash is ignored. It fails closed: if the copy throws or skips a file, the storing call's result becomes a failure saying the file is stored but not in the sandbox, and an `error` event is recorded. `callTool` guards a hook's replacement result like a dispatched one, `storeDocument` notifies observers with the id of the tool call it ran inside, and core gains `listDocumentsStrict` / `getDocumentStrict`, which throw on a failed read instead of answering "empty".
