# @hames-ai/sandbox

## 0.4.0

### Minor Changes

- 959966b: Add `decisionLoop(routes, config)` (#507 S1): a loop over routes in which the systemone `decide` seam picks the next route each time round, until it picks `answer` (a choice that runs nothing, so the synthesizer answers once) or `maxIterations` is reached. Exports `DECISION_LOOP_MAX_ITERATIONS` (6), `DECISION_LOOP_OUTPUT_KEY` and the record/stat types.
  
  - Each child runs in its own synthetic context and `viewConfig`, with events of siblings it may not see (`siblingResults`, default none) and the loop's own records physically removed, and with fresh `data` (never `memories`, `memoryContext` or `intent`).
  - A route's output is a record built by code from the child's committed events by route kind (`simpleLoop`, `actorCritic`, `retriever`, `planner`), never reading `content_sanitized`. Its `result` and `reasoning` are capped and sanitized under the guard key `decision_loop_output`; a screen that threw withholds the output (typed `screenUnavailable` on `SanitizeReport` and `SanitizeSummary`).
  - `formatPlanContext(plan, handoff?)` renders earlier-step results under their own data heading, outside the PLAN section; `planner` reads `data.handoff` and `data.agentMap` into its existing `context` argument. With neither, both are byte-identical to before.
  - A non-decision never dispatches a route: an irrecoverable visible error on iteration 1, a stop-as-answer on a later one. A failed route is a failed record and the loop decides again; a child's `error` events are committed as `recoverable`.
  - New `PatternCapabilities.tools` (declared by `simpleLoop`, `actorCritic` and `withSandbox`, which now always declares its in-VM tool names and merges over the wrapped pattern's capabilities) and `collectToolNames`.
  - Export `unspotlight(text)` from `@hames-ai/harness-patterns/guard`: strips one guard spotlight fence, for readers that excerpt fenced text. `decisionLoop` refuses routes that share a `patternId` (or use the loop's own) and warns once when no guard in the run declares `decision_loop_output`.
  - A screen outage in `decisionLoop` also withholds that iteration's child events from every later child context, this turn and later turns (ids persist on the marker record).
  - `decisionLoop` requires an explicit `patternId` (its records and withheld ids are matched by it across turns) and hides earlier turns' events by the route they were emitted inside, so patterns rebuilt each turn with generated ids cannot leak.
- 3819eee: Record sandbox output provenance in stored documents and retrieved chunks. Exclude promoted documents from the General Agent Next web route's reference previews and expansions while keeping them available for document search and user answers.
- 1b84721: `withSandbox({ id, syncWorkspace: true })` now copies a document a tool stored mid-run into `/work/in` straight after that call, instead of only when the route is next entered. Core gains two concatenating run-frame slots to do it without a tool-name list: `stashWriteObservers` (told by `storeDocument` once a document is durably stored) and `afterToolCall` (run by `callTool` after dispatch and guard, may replace the result). The copy is `hydrateWorkspace` for the sandbox's own session only; a write to another conversation's stash is ignored. It fails closed: if the copy throws or skips a file, the storing call's result becomes a failure saying the file is stored but not in the sandbox, and an `error` event is recorded. `callTool` guards a hook's replacement result like a dispatched one, `storeDocument` notifies observers with the id of the tool call it ran inside, and core gains `listDocumentsStrict` / `getDocumentStrict`, which throw on a failed read instead of answering "empty".

### Patch Changes

- Updated dependencies [959966b]
- Updated dependencies [d6b58f4]
- Updated dependencies [c46aa3c]
- Updated dependencies [e7f697e]
- Updated dependencies [b1f162c]
- Updated dependencies [e4c744d]
- Updated dependencies [a65a7b7]
- Updated dependencies [3819eee]
- Updated dependencies [1b84721]
- Updated dependencies [e39d5a4]
- Updated dependencies [d89bf08]
- Updated dependencies [55a780e]
- Updated dependencies [8f8ebd0]
  - @hames-ai/harness-patterns@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [59af7c6]
- Updated dependencies [b52215c]
- Updated dependencies [e5fc954]
- Updated dependencies [fa529f0]
- Updated dependencies [6e4a7ce]
- Updated dependencies [ab78dea]
- Updated dependencies [e6543b1]
- Updated dependencies [f97fd50]
- Updated dependencies [5efffdf]
- Updated dependencies [8b8b72c]
- Updated dependencies [ffc87ba]
- Updated dependencies [08ff54f]
- Updated dependencies [0405113]
- Updated dependencies [5f377c5]
- Updated dependencies [459122e]
- Updated dependencies [f13bb7d]
- Updated dependencies [22ff7c3]
  - @hames-ai/harness-patterns@0.3.0

## 0.2.0

### Minor Changes

- bcf8147: `withSandbox` can mount Agent Skills. `WithSandboxConfig.skills` is a resolver called per run that returns `SandboxSkill[]` (a name, a description and the whole `SKILL.md`); each is written into the container as `/skills/<name>/SKILL.md` by a content-hash sync, and the model is shown an index of them (name and description only) as an escaped `<skills>` block in the request's `user`-role context, never in the tool list or the system message. The package enforces the specification's name rule and 1–1024-character description, a 64 KiB per-file cap and at most 20 skills per run, and reports what it could not mount as a `warning` event (task `skills_mount`, #420's side-failure scheme). The Docker backend mounts a 4 MiB `noexec` tmpfs at `/skills`. New exports from the root: `SandboxSkill`, `SandboxSkillsResolver`, `SKILLS_DIR`, `SKILL_FILE_MAX_BYTES`, `MAX_MOUNTED_SKILLS`, `isSkillName`. The browser-safe `./skills` subpath also carries `isSkillDescription`, `renderSkillsIndex`, `SKILLS_INDEX_TOOL`, `SKILL_FILE_NAME`, `SKILL_NAME_MAX_LENGTH` and `SKILL_DESCRIPTION_MAX_CHARS`; `./work-sync.server` now also exports `bash`, `shq` and `BashOutcome`. Without `skills`, nothing changes.
  
  `@hames-ai/harness-patterns`: `ToolTransport` gains an optional `promptContext` (never a routing input), and `activeTransportContext()` joins the scoped transports' contexts. `WarningTask` gains `'skills_mount'`.
  
  `@hames-ai/harness-baml`: the loop-controller and actor adapters render `activeTransportContext()` in their `user`-role CONTEXT block.
  
  `@hames-ai/agents`: the sandbox-session agent's welcome text names the app's renamed Sandbox tab.

### Patch Changes

- 30175ff: `PtyManager`: a shell that no subscriber ever attaches to now idles out after `IDLE_CLOSE_MS`, like one whose last subscriber left, and releases its container (#429). The idle clock used to start only when a subscriber unsubscribed, so a shell started by `ensure()` and never streamed held its VM until the process restarted. That case is reachable once starting a terminal and streaming it are two requests, which is how the host app's terminal route works since #429. The first `subscribe()` cancels the clock, so a stream that attaches within the window is unaffected.
- 7876c1a: README badges: npm version, CI, CodeQL, supported Node version and licence.
- 6b47a43: README: add banner
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
