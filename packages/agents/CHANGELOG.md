# @hames-ai/agents

## 0.3.0

### Minor Changes

- 9451b77: Add optional MemoryConfig to AgentDeps so hosts can supply memory without opting any agent in.

### Patch Changes

- Updated dependencies [b52215c]
- Updated dependencies [6970e8b]
- Updated dependencies [bcf7ab4]
- Updated dependencies [220e794]
- Updated dependencies [fa529f0]
- Updated dependencies [d65f08e]
- Updated dependencies [6e4a7ce]
- Updated dependencies [ab78dea]
- Updated dependencies [e6543b1]
- Updated dependencies [f97fd50]
- Updated dependencies [a12c8d0]
- Updated dependencies [5efffdf]
- Updated dependencies [b52215c]
- Updated dependencies [ffc87ba]
- Updated dependencies [08ff54f]
- Updated dependencies [0405113]
- Updated dependencies [5f377c5]
- Updated dependencies [459122e]
- Updated dependencies [1acfe23]
- Updated dependencies [f13bb7d]
- Updated dependencies [b82d37d]
- Updated dependencies [22ff7c3]
  - @hames-ai/harness-patterns@0.3.0
  - @hames-ai/harness-baml@0.3.0

## 0.2.0

### Minor Changes

- 2844e47: Resume, binding and supersede (#433, slice S3). **Breaking**: `minor`, because the family is at `0.x` and a breaking change takes `minor` there (CONTRIBUTING, "Which bump"). This is the release-bearing changeset for human in the loop: S1 and S2 are additive, and no release happens between S2 and S4.
  
  **Removed:**
  
  - the boolean `resumeHarness(serialized, patterns, approved)`;
  - the `ApprovalRequest`, `WithApproval`, `ApprovalRequestEventData` and `ApprovalResponseEventData` types, from `@hames-ai/harness-patterns`;
  - `WithApproval` from `@hames-ai/agents`' `AgentData`, so `AgentData` no longer declares `pendingAction` or `approved`;
  - the public `setPaused`, from the barrel and from `context.server`. Only the `runChain` that owns a run sets `paused`, for a request it records.
  
  `approval_request` and `approval_response` stay in `EventType` as deprecated legacy members. Nothing emits them any more: `resumeHarness` no longer appends an `approval_response`.
  
  **A 0.1.x paused blob cannot be resumed; `continue()` it.** Such a blob holds no `hitl_request`, so `resumeHarness` refuses it as `no-pending`. `continueSession` still deletes a legacy `data.approved`, and so does `resumeHarness`. Both are the legacy-blob scrub, kept until 1.0.
  
  **Added and changed:**
  
  - **`resumeHarness(serialized, patterns, answers, opts?)`.** `answers` maps each waiting `requestId` to an option id, or to `{ choice, flags }`, and to nothing else. `opts` is `{ principal?, resolve?, onEvent?, frame? }` (`ResumeOptions`). An answer resumes only the pause it was issued for. Every check runs before anything is recorded and before `resolve`, and a refusal throws `HitlAnswerError`, whose `code` is one of `not-paused`, `no-pending`, `expired`, `tier-changed`, `unknown-request`, `missing-answer`, `invalid-choice`, `unavailable-option`, `invalid-flag`, `required-flag` or `chain-changed`. Answers are checked against what the current run waits on, never against its journal, so an answer that was already applied is refused. A required flag must be set `true` by the answer itself.
  - **`resolve` must be idempotent per `requestId`.** If a later `resolve` throws, nothing is recorded and the blob is still paused, so a retry calls every `resolve` again.
  - **The run continues.** After the checks, `resolve` runs once per answer, inside the run frame. One `hitl_response` is recorded per answer, with `by: 'person'`, the host's `principal` and what `resolve` returned. Each held tool result becomes its outcome after `sanitizeUntrusted` (namespace `hitl`), is marked `heldBy`, and loses its `summary`; a held result is found by the UUID inside its `requestId`, so one the LLM screen fenced is still substituted. A `stopsRun` choice ends the run `done`. Otherwise the paused top-level pattern runs again, through `runChain(ctx, patterns, onEvent?, { startAt })`, and its gate replays the answer.
  - **Behaviour change: `continueSession` supersedes.** Before the new message, every request the last run still waits on gets `{ choice: null, by: 'superseded' }`, and its held results say nothing was kept.
  - **`expireHitl(serialized, now)`** closes every request past its `expiresAt` with `{ choice: null, by: 'expired' }`. That covers a blocking request of the current run and a non-blocking proposal anywhere in the log. A paused run whose request expired ends `done`, and its other pending requests are closed `{ choice: null, by: 'superseded' }`, because answers are all-or-nothing. It returns `{ serialized, expired, superseded }`, or `null` when nothing was due.
  - **Behaviour change: `compactBulkData` never summarizes a held result.**
  - **Behaviour change: the run's HITL bookkeeping store cannot write the record.** Its identity fields are non-writable, it hands out a copy of the owning context's events, and the owner commits from its buffer only what `askHuman` could have written there. Anything else is dropped with a `console.warn`.
  - `ToolResultEventData.heldBy`, and the types `HitlAnswer`, `HitlAnswers`, `HitlAnswerErrorCode` and `ResumeOptions`.
  - The observability projection previews `hitl_request` and `hitl_response` by kind and outcome, and a legacy `approval_*` event as `legacy approval event`.
- 2bb03a4: Agents are read-only against Neo4j (#403).
  
  `@hames-ai/harness-patterns`: `listTools()` no longer returns `write_neo4j_cypher`, including under a gateway prefix (`mcp__<server>__write_neo4j_cypher`) or a server namespace prefix (`<namespace>-write_neo4j_cypher`). `Tools()` and the BAML adapters' catalogs read through it. And `simpleLoop` and `actorCritic` refuse the tool in their allowlist check even when the allowlist you pass names it, or `dynamicToolAllowlist` / `dynamicToolPattern` would admit it; the refusal says the tool is withheld from every agent. So no agent's tool list, loop allowlist or planner catalog holds it. Like the management-tool filter, it is unconditional, and `listTools()` logs one warning per process when the gateway lists the tool. `callTool()` is unchanged: the list decides what an agent may call, not what the host may call by name. If an agent of yours wrote to Neo4j through this tool, it no longer can.
  
  `simpleLoop` now filters `fewShots` by the loop's allowlist before the controller sees them (#401): a shot whose `tool` the loop would refuse is dropped, and shots of `Return` and `expandPreviousResult` always stay. A model that copied a shot of a tool outside the allowlist used to end the loop on "Tool not allowed".
  
  `@hames-ai/agents`: new export `NEO4J_READ_ONLY_CONTEXT`, the controller context `search`, `retriever` and `general` now pass to the loops that reach Neo4j. It tells the controller the graph is read-only and to answer a request to change it instead of attempting one. `NEO4J_FEW_SHOTS_DEFAULT` is unchanged; its write example now reaches only a loop whose allowlist holds the write tool.
  
  `@hames-ai/connectors`: README only.
- 0f9465e: One sandbox agent instead of two. `sandboxAgent` (id `sandbox`, `agents/sandbox.server.ts`) replaces `sandboxSessionAgent` (`sandbox-session`) and `flavouredSandboxAgent` (`flavoured-sandbox`); both modules and both exports are removed. It keeps the flavoured agent's router, now over three routes: `basic`, the plain persistent box `sandbox-session` ran, keyed on the bare session id so it is the container a host's interactive shell attaches to; `data`; and `office`. The `image-processing` route is gone; the rootfs flavour itself is unchanged in `@hames-ai/sandbox`. A host that stored the old ids should map them to `sandbox`, as the reference app does.
  
  `AgentDefinition` gains an optional `usesSandbox` flag, which `sandboxAgent` sets, so a host can tell which agents run in a sandbox without building them.
- 355994d: Side failures are now visible instead of silent (#420).
  
  - **New `warning` event** (`WarningEventData`, `WarningTask`): a side task — the conversation title, the post-turn result summaries, `compactIntent`'s rewrite, the retriever's query rewrite, `withReferences`' selection — failed and the turn ran on a fallback. It is always committed, rendered metadata-only into LLM-facing serializations, and is never read by `settleTurn`, `runChain`'s stop rule or `EventView.hasErrors()`, so a side failure cannot fail a turn or make the synthesizer apologise. `compactIntent`, the retriever's rewrite and `withReferences`' selector emit it where they used to emit an `error` (the selector's carried `kind: 'llm_call'`; the call record now rides the warning). **Breaking for exhaustive consumers**: `EventType` gains `'warning'`, so a `Record<EventType, …>` or an exhaustive `switch` over it stops compiling until it handles the new member.
  - **`withReferences`**: a selector that throws no longer skips the wrapped pattern; it runs with nothing attached, as `DEFAULT_ERROR_SEVERITY` already described.
  - **`compactBulkData`**: a batch that throws falls back per item (it used to skip the fallback), and a describe failure that leaves a result unsummarized records one `warning` per turn. **Breaking for describe implementations that relied on it**: the `DescribeFn` / `DescribeBatchFn` seam now treats a throw as the failure signal. `describeToolResultOp` and `describeToolResultsBatchOp` (`@hames-ai/harness-baml`) now **throw** on a failed call instead of returning `''` / an empty map.
  - **`runFirstTurnTitleGen`** (`@hames-ai/agents`) now **rejects** when the generation failed, instead of returning the same `null` as "nothing to name". `runRegenerateTitle` keeps its null-on-failure contract. `warningBubble` joins `errorBubble` in `replay`.
  - **Data Stash**: a failed ingest records its reason on the document as `ingestError` (cleared by the next run), and `IngestStatus` gains `'not_indexed'` for a copy stored in a format with no text to index. **Breaking for `GraphStashBridge` hosts** (`@hames-ai/connectors`): `ingest()` now resolves with how the run ended (`GraphStashIngestOutcome`), and `graph_file_ingest` waits up to `INGEST_OUTCOME_WAIT_MS` for it and returns `indexStatus` (`indexed` | `pending` | `failed` | `not_indexed`) plus `indexError`. A host whose `ingest()` still resolves `undefined` (plain JS, or a cast past the type) has every successful index reported as `failed` with "the index run reported no reason" — and the tool tells the model to pass that on — so update the bridge before upgrading.

### Patch Changes

- 3e0bdf8: Two output-cleanup fixes.
  
  - **`repairJson` / `repairJsonTracked`** (`@hames-ai/harness-patterns`) no longer fold a malformed multi-key object into its first key (#408). The last-resort handler for a single key whose bare value holds commas checked only that the input began with one key, so `{a: [x,,y], b: 1}` came back as `{ a: "[x,,y], b: 1" }`, tagged `lenient-tokens`. It now declines whenever the would-be value holds something shaped like another member (`, b:`, `"b":`, `'b':`), and the call **throws**: both loops feed it back to the model as a recovery round (#437). **Behaviour change for callers**: inputs that used to return one wrong key now throw. The decline is deliberately conservative, so some inputs the old handler got right now throw too: a Cypher label predicate or label write after a comma (`RETURN a, b:Person`, `SET a:Customer, b:Vendor`, `REMOVE …`), and a quoted word followed by a colon (Python's `if x == "y":`, once the same code also holds an ambiguous `print("a", b)`). A value that is one cleanly quoted string is exempt, so `{query: "RETURN n, n:Person"}` still repairs.
  - **`sanitizeTitle`** (`@hames-ai/agents`) takes the first line of the model's reply before it strips surrounding quotes and trailing punctuation (#409), so `"Graph Styling Tips"` followed by a second line no longer keeps its closing quote.
- 6df6a8b: Remove text taken from real conversations and a real tenant from shipped source. Comments in `general.server.ts`, `sandbox.server.ts`, `json-repair.ts` and `types.baml` no longer quote a user's request, a model's status line or a captured payload; they describe the case instead. In `@hames-ai/connectors`, the `graph_mail_attachments` tool's `person` description now gives a placeholder name as its example (`e.g. "Adele"`), and two comments use placeholder names and a placeholder attachment title. No behaviour changes.
- 7876c1a: README badges: npm version, CI, CodeQL, supported Node version and licence.
- 6b47a43: README: add banner
- bcf8147: `withSandbox` can mount Agent Skills. `WithSandboxConfig.skills` is a resolver called per run that returns `SandboxSkill[]` (a name, a description and the whole `SKILL.md`); each is written into the container as `/skills/<name>/SKILL.md` by a content-hash sync, and the model is shown an index of them (name and description only) as an escaped `<skills>` block in the request's `user`-role context, never in the tool list or the system message. The package enforces the specification's name rule and 1–1024-character description, a 64 KiB per-file cap and at most 20 skills per run, and reports what it could not mount as a `warning` event (task `skills_mount`, #420's side-failure scheme). The Docker backend mounts a 4 MiB `noexec` tmpfs at `/skills`. New exports from the root: `SandboxSkill`, `SandboxSkillsResolver`, `SKILLS_DIR`, `SKILL_FILE_MAX_BYTES`, `MAX_MOUNTED_SKILLS`, `isSkillName`. The browser-safe `./skills` subpath also carries `isSkillDescription`, `renderSkillsIndex`, `SKILLS_INDEX_TOOL`, `SKILL_FILE_NAME`, `SKILL_NAME_MAX_LENGTH` and `SKILL_DESCRIPTION_MAX_CHARS`; `./work-sync.server` now also exports `bash`, `shq` and `BashOutcome`. Without `skills`, nothing changes.
  
  `@hames-ai/harness-patterns`: `ToolTransport` gains an optional `promptContext` (never a routing input), and `activeTransportContext()` joins the scoped transports' contexts. `WarningTask` gains `'skills_mount'`.
  
  `@hames-ai/harness-baml`: the loop-controller and actor adapters render `activeTransportContext()` in their `user`-role CONTEXT block.
  
  `@hames-ai/agents`: the sandbox-session agent's welcome text names the app's renamed Sandbox tab.
- d4a7684: **`sanitizeTitle`** no longer strips quotes that have no partner (#454). It used to take a leading run and a trailing run of quote characters separately, and only then strip trailing `.!?`. So `Review of "Dune"` lost its closing quote, and `"Title".` kept one, because the `.` hid it from the strip. Now it peels one layer per pass, from the outside in: trailing punctuation first, then a quote pair that wraps the whole title. A quote is removed only together with a matching quote at the other end, and only when that quote closes the title rather than an inner span: `"Dune" and "Arrakis"` is left alone. Punctuation is stripped whether it sits outside the quotes or inside them, so `"Title".` and `"Title."` both become `Title`. **Behaviour change**: a quote with no matching partner at the other end, such as `"Dune Review` or `"Dune Review'`, is now kept where it used to be stripped. A wrapping pair is also kept when the first quote of the same kind inside it ends a word, as in `'The Jones' House'`: that quote looks the same as the one closing `'Dune'` in `'Dune' and 'Arrakis'`.
- Updated dependencies [99387af]
- Updated dependencies [ae701fe]
- Updated dependencies [3e0bdf8]
- Updated dependencies [51f96c6]
- Updated dependencies [af875e4]
- Updated dependencies [94870a1]
- Updated dependencies [f6ed2c6]
- Updated dependencies [a462e55]
- Updated dependencies [6a58ab4]
- Updated dependencies [2ed48b7]
- Updated dependencies [2844e47]
- Updated dependencies [f6326c3]
- Updated dependencies [2bb03a4]
- Updated dependencies [9c568cc]
- Updated dependencies [6df6a8b]
- Updated dependencies [6071a3d]
- Updated dependencies [7876c1a]
- Updated dependencies [6b47a43]
- Updated dependencies [07bcdd5]
- Updated dependencies [bcf8147]
- Updated dependencies [355994d]
  - @hames-ai/harness-patterns@0.2.0
  - @hames-ai/harness-baml@0.2.0
