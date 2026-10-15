# general-next Eval catalogue (#507 W4)

All names, documents, people and results below are synthetic. This catalogue is the acceptance contract; assistant lines describe required outcomes, not preloaded successful answers. `RUNNABLE NOW` describes the P4 boundary, not permission to spend: candidate execution waits for S3 registration, and live execution waits for the coordinator message **S3 merged: go**.

The PRIVATE tier (`verda`) alone runs these cases; there are no Anthropic-tier runs. The owner amended the original two-tier brief on 2026-10-15. Baseline cases run unchanged against `general` on the private tier too; additional capabilities are graded only on the selected candidate. Graph mail and people are fixture-only. Graph file ingestion stays withheld before P4; the two P4 cases are reported as gated, never as passing. Uploaded-document cases are rebased on synthetic uploads.

The built-in dependency driver uses an in-memory stash and scripted sandbox effects. It proves routing, ordering, handoff and artifact/index contracts; it does not certify Office rendering or the HTTP upload path. The future app-path evidence must seed synthetic documents through the app upload route before claiming that integration. No real Graph, Redis, Neo4j, sandbox container or company data is required.

Live preconditions: this worktree’s `app/.env` must contain remote `SMALL_LLM_BASE_URL` and `SMALL_LLM_DECISIONS_URL` (full `/v1/systemone` URL), the shared key and the configured Verda endpoint/key. Refresh a stale worktree copy without printing secrets; if values are missing, remain hermetic and escalate. The owner local embedder on `127.0.0.1:8090` must already be running; never start a second one. The whole shared budget is private GPU time: USD 20 by default, values above 25 refused, synchronous stop at 80% (USD 16 by default), with observer costs and a separate wall-clock floor for both boxes reported per scenario. A final in-flight call and unobserved infrastructure can overshoot that threshold; the report states the limit.

The eventual flip requires no regression on the unchanged `general` baseline plus all `must` cases green on the private tier. Scripted wiring evidence alone cannot satisfy it. The final S7 injected-field/factory wiring is assigned to S3; the candidate has not run on this base.

## Scenario matrix

### 01-greeting — A short answer without tools

**RUNNABLE NOW · must** · current `general` baseline

User: “Hi! What can you help me with?”

Expected assistant: A short explanation of available capabilities.

Expected routes: `answer` directly. Expected tools: no required external tool.

Pass: nonempty final answer; candidate chooses `answer` within 6 decisions per turn; no terminal error, empty response or ignored required check.

### 02-graph-count — Read the knowledge graph

**RUNNABLE NOW · must** · current `general` baseline

User: “How many Project nodes are in the knowledge graph?”

Expected assistant: There are 42 Project nodes.

Expected routes: `info-retrieval`. Expected tools: `read_neo4j_cypher`.

Pass: all listed tools occur successfully in order (across the same conversation); all listed routes complete before `answer`; final answer carries 42; candidate chooses `answer` within 6 decisions per turn; no terminal error, empty response or ignored required check.

### 03-web-read — Search, then read a source

**RUNNABLE NOW · must** · current `general` baseline

User: “Find the synthetic public Lantern release notes and read the page. What changed in version 2?”

Expected assistant: Version 2 adds CSV export; cite https://example.invalid/lantern.

Expected routes: `info-retrieval`. Expected tools: `search`, `fetch`.

Pass: all listed tools occur successfully in order (across the same conversation); all listed routes complete before `answer`; final answer carries CSV; candidate chooses `answer` within 6 decisions per turn; no terminal error, empty response or ignored required check.

### 04-library-docs — Resolve a library before reading its docs

**RUNNABLE NOW · should** · current `general` baseline

User: “Find the SolidJS createSignal docs and show me a tiny counter example.”

Expected assistant: A counter example grounded in the resolved library documentation.

Expected routes: `info-retrieval`. Expected tools: `resolve-library-id`, `get-library-docs`.

Pass: all listed tools occur successfully in order (across the same conversation); all listed routes complete before `answer`; final answer carries createSignal; candidate chooses `answer` within 6 decisions per turn; no terminal error, empty response or ignored required check.

### 05-memory-lookup — Read a named memory entity

**RUNNABLE NOW · should** · current `general` baseline

User: “Look up the synthetic Lantern project in the memory graph. What is its release tag?”

Expected assistant: The release tag is LANTERN-2.

Expected routes: `info-retrieval`. Expected tools: `search_nodes`.

Pass: all listed tools occur successfully in order (across the same conversation); all listed routes complete before `answer`; final answer carries LANTERN-2; candidate chooses `answer` within 6 decisions per turn; no terminal error, empty response or ignored required check.

### 06-read-only — Explain a missing write capability

**RUNNABLE NOW · must** · current `general` baseline

User: “Create a Project node named Lantern in the knowledge graph.”

Expected assistant: Explain that this graph is read-only; do not claim a write succeeded.

Expected routes: `answer` directly. Expected tools: no required external tool.

Pass: nonempty final answer; no write tool is called and no artifact is claimed; explicit read-only explanation; candidate chooses `answer` within 6 decisions per turn; no terminal error, empty response or ignored required check.

### 07-follow-up-success — Refer back to a successful turn

**RUNNABLE NOW · must** · current `general` baseline

User: “How many Project nodes are in the knowledge graph?”

Expected assistant: There are 42 Project nodes.

User: “Double that number. Just give me the result.”

Expected assistant: 84

Expected routes: `info-retrieval`. Expected tools: `read_neo4j_cypher`.

Pass: all listed tools occur successfully in order (across the same conversation); all listed routes complete before `answer`; final answer carries 84; candidate chooses `answer` within 6 decisions per turn; no terminal error, empty response or ignored required check.

### 08-follow-up-failure — Retry after an explicitly failed turn

**RUNNABLE NOW · must**

User: “Count the Project nodes in the knowledge graph.”

Expected assistant: The graph lookup failed: synthetic service unavailable. No count is known.

User: “That failed earlier. Please try the same count again now.”

Expected assistant: There are 42 Project nodes; the second lookup succeeded.

Expected routes: `info-retrieval`. Expected tools: `read_neo4j_cypher`.

Pass: all listed tools occur successfully in order (across the same conversation); all listed routes complete before `answer`; final answer carries 42; the first turn records the injected tool failure and the second makes a fresh successful lookup; candidate chooses `answer` within 6 decisions per turn; no terminal error, empty response or ignored required check.

### 09-upload-summary — Read an uploaded document and produce a summary

**RUNNABLE NOW · must**

User: “I uploaded lantern-notes.md. Write a short Word summary called lantern-summary.docx and give me the download link.”

Expected assistant: An artifact link for lantern-summary.docx, based on the uploaded notes.

Expected routes: `office-data`. Expected tools: `sandbox_bash`.

Pass: all listed tools occur successfully in order (across the same conversation); all listed routes complete before `answer`; final answer carries lantern-summary.docx; stash artifact(s) exist: lantern-summary.docx; candidate chooses `answer` within 6 decisions per turn; no terminal error, empty response or ignored required check.

### 10-csv-analysis — Compute from an uploaded CSV

**RUNNABLE NOW · must**

User: “Use the uploaded lantern-sales.csv to total revenue by region. Save lantern-totals.csv and tell me the grand total.”

Expected assistant: lantern-totals.csv is available; grand total is 60.

Expected routes: `office-data`. Expected tools: `sandbox_bash`.

Pass: all listed tools occur successfully in order (across the same conversation); all listed routes complete before `answer`; final answer carries 60; stash artifact(s) exist: lantern-totals.csv; candidate chooses `answer` within 6 decisions per turn; no terminal error, empty response or ignored required check.

### 11-mail-to-file — Find synthetic mail, then create a document

**RUNNABLE NOW · must**

User: “Find the synthetic Lantern launch email in my fixture mailbox. Turn its checklist into lantern-launch.md and give me the file.”

Expected assistant: lantern-launch.md contains the launch checklist from mail fixture mail-lantern-1.

Expected routes: `office-data`. Expected tools: `graph_mail_recent`, `sandbox_bash`.

Pass: all listed tools occur successfully in order (across the same conversation); all listed routes complete before `answer`; final answer carries lantern-launch.md; stash artifact(s) exist: lantern-launch.md; candidate chooses `answer` within 6 decisions per turn; no terminal error, empty response or ignored required check.

### 12-retrieve-citation — Answer from an uploaded document with a locator

**RUNNABLE NOW · must**

User: “According to the uploaded lantern-notes.md, what is the release date? Please cite the document.”

Expected assistant: The release date is 2030-04-12, with a citation pointing to lantern-notes.md.

Expected routes: `read-documents`. Expected tools: no required external tool.

Pass: all listed routes complete before `answer`; final answer carries 2030-04-12; answer has a reference locator for lantern-notes.md; candidate chooses `answer` within 6 decisions per turn; no terminal error, empty response or ignored required check.

### 13-two-sources — Combine the knowledge graph and uploaded notes

**RUNNABLE NOW · must**

User: “Compare the Project count in the knowledge graph with the target count in lantern-notes.md. How far apart are they? Cite the notes.”

Expected assistant: The graph count is 42, the target is 50, and the gap is 8, with a document citation.

Expected routes: `info-retrieval`, `read-documents`. Expected tools: `read_neo4j_cypher`.

Pass: all listed tools occur successfully in order (across the same conversation); all listed routes complete before `answer`; final answer carries 8; answer has a reference locator for lantern-notes.md; candidate chooses `answer` within 6 decisions per turn; no terminal error, empty response or ignored required check.

### 14-analysis-index-follow-up — Compute, convert to markdown, then retrieve in a later turn

**RUNNABLE NOW · must**

User: “I uploaded lantern-notes.md and lantern-sales.csv. Analyse sales against the notes, save lantern-analysis.md, index it for this chat, and offer to answer questions about it.”

Expected assistant: lantern-analysis.md exists and is queryable; offer questions over its content.

User: “From the analysis you just indexed, which region sold more and by how much? Cite that analysis.”

Expected assistant: North sold 40 versus South 20, a difference of 20; cite lantern-analysis.md.

Expected routes: `office-data`, `read-documents`. Expected tools: `sandbox_bash`.

Pass: all listed tools occur successfully in order (across the same conversation); all listed routes complete before `answer`; final answer carries 20; stash artifact(s) exist: lantern-analysis.md; queryable markdown index: lantern-analysis.md, queried in the follow-up; answer has a reference locator for lantern-analysis.md; candidate chooses `answer` within 6 decisions per turn; no terminal error, empty response or ignored required check.

### 15-graph-file-summary — Graph file to sandbox summary

**GATED ON P4 · should**

User: “Find lantern-brief.docx in my synthetic OneDrive fixtures, read it, and write lantern-brief-summary.docx.”

Expected assistant: The summary artifact exists and contains the brief facts, rather than only an ingest receipt.

Expected routes: `office-data`. Expected tools: `graph_files_search`, `graph_file_ingest`, `sandbox_bash`.

Pass: all listed tools occur successfully in order (across the same conversation); all listed routes complete before `answer`; final answer carries lantern-brief-summary.docx; stash artifact(s) exist: lantern-brief-summary.docx; candidate chooses `answer` within 6 decisions per turn; no terminal error, empty response or ignored required check.

### 16-graph-files-analysis — Graph files, analysis, markdown indexing and retrieval

**GATED ON P4 · nice**

User: “Find the synthetic Lantern budget and actuals spreadsheets in my fixture drive. Compare them, create lantern-variance.md, index it, and let me ask questions about it.”

Expected assistant: The variance report exists and has been indexed.

User: “Which item has the largest overspend in that report? Cite it.”

Expected assistant: Hosting is 5 over budget, with a citation to lantern-variance.md.

Expected routes: `office-data`, `read-documents`. Expected tools: `graph_files_search`, `graph_file_ingest`, `sandbox_bash`.

Pass: all listed tools occur successfully in order (across the same conversation); all listed routes complete before `answer`; final answer carries Hosting; stash artifact(s) exist: lantern-variance.md; queryable markdown index: lantern-variance.md, queried in the follow-up; answer has a reference locator for lantern-variance.md; candidate chooses `answer` within 6 decisions per turn; no terminal error, empty response or ignored required check.
