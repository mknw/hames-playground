---
"@hames-ai/harness-patterns": minor
"@hames-ai/agents": minor
---

Tell the Decide step about the conversation's documents (#507). `decisionLoop` takes an optional `documents` source (`(signal) => Promise<DecisionDocuments>`), read once per run before iteration 1, and renders it into the state as a block between the conversation and "This turn so far": a capped list of every visible document's name, type and size when the host's source returns names, `N (names not shown)` when it returns a count only, and nothing when there are no visible documents (such a state is byte-identical to before). Core never reads a tier: the host decides what a run may reveal.

- Names are untrusted text: cut to 80 code points before any rule runs, separators and control characters replaced, invisible and bidi characters removed, checked against the injection rule corpus and the state's own headers (a name that trips either is shown as `[name withheld]`), then JSON-quoted on one line. At most 10 names and 1,000 characters, then `+K more documents`. The guard's screen is never run for a name. `mimeType` is mapped through a fixed allowlist, never printed raw.
- A source that throws, times out (`documentsTimeoutMs`, default `DECISION_DOCUMENTS_TIMEOUT_MS` 30 000, aborts the source's signal) or returns a malformed value gives an explicit `unknown (could not be read)` line (never "none") and one `warning` event (new `WarningTask` `'decision_documents'`); the turn runs as before.
- `DecisionLoopStateInput.documents` hands the resolved value to a `state` override. New exports: `renderDocumentsBlock`, `DECISION_DOCUMENTS_TIMEOUT_MS`, and the `DecisionDocument`, `DecisionDocuments`, `DecisionDocumentsSource` and `ResolvedDecisionDocuments` types.
- `listDocumentSummariesStrict(sessionId, callTool?, signal?)` in `stash/document-store.server`: the strict list without the content, one `json_get` per document of just the members a description needs. A failed or unreadable read throws and never prunes; an index entry is pruned only after a successful read that found nothing.
- `@hames-ai/agents`: `AgentDeps.createDecisionDocuments` (optional); `general-next` passes it to its loop. Without it the state says nothing about documents.
- SPEC: `decision_made`'s `data` carries `stateChars`, never the state text, but the call record's `rawInput` is the request body, state included, and is persisted with the conversation.
