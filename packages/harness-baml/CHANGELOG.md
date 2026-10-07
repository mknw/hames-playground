# @hames-ai/harness-baml

## 0.2.0

### Minor Changes

- f6326c3: A single failure no longer ends a tool loop (#437 slice 1, from #425).
  
  - **`simpleLoop`** used to end on the first failed tool call, the first tool name off its allowlist, the first unparseable `tool_args`, the first multi-call turn whose calls all failed, and the first controller answer that would not parse — each with rounds left. Each is now fed back to the controller as that round's result, and the loop continues on its remaining budget. The failure costs the round, and a controller that never recovers is stopped by the budget with the usual `kind: 'budget_exhausted'` marker, or sooner by the consecutive-recovery cap (below).
  - **`actorCritic`** already fed tool failures, refusals and bad `tool_args` back through `previousAttempts`. An actor answer that would not parse now goes the same way, instead of ending the loop with attempts left.
  - **New `maxConsecutiveRecoveries` option on `SimpleLoopConfig` and `ActorCriticConfig` (default `1`)**: how many unusable answers in a row a loop feeds back. An answer is unusable when it would not parse, when its `tool_args` would not parse, when it names a tool off the allowlist, or when it is a multi-call turn of which no call could be dispatched. Up to the cap, each is fed back; the next one ends the loop exactly as the failure did before #437 — its own message, the pattern's severity and the failed call's `llmCall` — on an `error` marked with the new `ErrorEventData.kind` value `'recovery_exhausted'` and the new field `maxConsecutiveRecoveries`. A round that dispatches a tool resets the count, whatever the tool returns, and a tool that ran and failed never counts. So by default a loop stops on its second unusable answer in a row. `0` permits no recovery (`simpleLoop`'s pre-#437 behaviour), and `Infinity` leaves only the round budget. In `actorCritic`, a refusal against a tool surface that resolved to nothing (no static or dynamic names, no scoped transport, no `dynamicToolPattern`) neither counts nor resets, because the actor had no valid name to choose. **Behaviour change for `actorCritic`**: two refused tool names, two unparseable `tool_args`, or two multi-call attempts that dispatched nothing, in a row, now end the loop; before, it only ever retried them. **This binds the two sandbox agents in `@hames-ai/agents`** (`maxRetries: 6`): after two consecutive unusable answers they now stop at attempt 2, where they used to spend all 6 attempts, and the answer is composed from what they actually ran. **Breaking for exhaustive consumers**: `ErrorEventData.kind` gains `'recovery_exhausted'`.
  - **The model sees its own unparseable answer.** When an answer fails to parse for any reason other than a cut-off at the output cap or an empty completion, the feedback now quotes a bounded head of that answer (at most 400 characters), labelled as the model's previous response, next to the parser's message. Before, the next round saw only the parser's message: the turn log replays an empty action for such a round. A cut-off and an empty answer are still not quoted back.
  - **What stays fatal**: the gateway-outage refusal before a loop starts, an LLM call that never answered (transport error, timeout, abort), any failure the implementation did not classify, a `callTool` that throws, and a critic that throws. A thrown `callTool` keeps its pre-#437 behaviour everywhere: fatal when singular, and fatal in a `simpleLoop` multi-call turn whose calls all failed (`SubCallOutcome` gains `threw` so the loop can tell a throw from a returned failure). `actorCritic`'s multi-call attempts continue past a throw, as they always have.
  - **`LLMCallError` gains `recoverable`** (constructor option `{ recoverable: true }`). Only an implementation sets it, and the loops read it rather than inferring it from the message. `wrapAsLLMCallError` (`@hames-ai/harness-baml`) sets it for `BamlValidationError`, the same test as its one corrective retry. **Behaviour change for custom controllers**: an `LLMCallError` without the flag, or a plain `Error`, still ends the loop, as before.
  - **New `loop_recovery` event** (`LoopRecoveryEventData`, `LoopRecoveryFailure`): one per recovery, carrying the failure class, the verbatim error, the tool, the round and the budget, plus the failed call's `llmCall` when the model's answer is the defect. It is always committed and rendered metadata-only into LLM-facing serializations. `settleTurn`, `runChain`'s stop rule and `EventView.hasErrors()` never read it. **Breaking for exhaustive consumers**: `EventType` gains `'loop_recovery'`, so a `Record<EventType, …>` or an exhaustive `switch` over it stops compiling until it handles the new member.
  - **`actorCritic`'s in-loop `error` events become `loop_recovery`**: the refused tool name and the unparseable `tool_args` events, which the chat painted as error bubbles and the synthesizer read as a failed run after the loop had recovered (#235). A refusal against an empty allowlist is now recorded too. It was suppressed only because, as an `error`, it flooded the synthesizer's view.
  - **`compactExecution`'s thread mode** reports a failed singular call as `{ __error }`, the shape batches already use, instead of a successful `null`. Now that a loop continues past a failure, that result is the synthesizer's only record of it.
  - The cut-off feedback for `tool_args` now carries the append advice in `simpleLoop` too, from one shared builder. `actorCritic`'s unparseable-args message quotes a bounded excerpt of the args instead of the full payload, which the attempt log already replays.
- 355994d: Side failures are now visible instead of silent (#420).
  
  - **New `warning` event** (`WarningEventData`, `WarningTask`): a side task — the conversation title, the post-turn result summaries, `compactIntent`'s rewrite, the retriever's query rewrite, `withReferences`' selection — failed and the turn ran on a fallback. It is always committed, rendered metadata-only into LLM-facing serializations, and is never read by `settleTurn`, `runChain`'s stop rule or `EventView.hasErrors()`, so a side failure cannot fail a turn or make the synthesizer apologise. `compactIntent`, the retriever's rewrite and `withReferences`' selector emit it where they used to emit an `error` (the selector's carried `kind: 'llm_call'`; the call record now rides the warning). **Breaking for exhaustive consumers**: `EventType` gains `'warning'`, so a `Record<EventType, …>` or an exhaustive `switch` over it stops compiling until it handles the new member.
  - **`withReferences`**: a selector that throws no longer skips the wrapped pattern; it runs with nothing attached, as `DEFAULT_ERROR_SEVERITY` already described.
  - **`compactBulkData`**: a batch that throws falls back per item (it used to skip the fallback), and a describe failure that leaves a result unsummarized records one `warning` per turn. **Breaking for describe implementations that relied on it**: the `DescribeFn` / `DescribeBatchFn` seam now treats a throw as the failure signal. `describeToolResultOp` and `describeToolResultsBatchOp` (`@hames-ai/harness-baml`) now **throw** on a failed call instead of returning `''` / an empty map.
  - **`runFirstTurnTitleGen`** (`@hames-ai/agents`) now **rejects** when the generation failed, instead of returning the same `null` as "nothing to name". `runRegenerateTitle` keeps its null-on-failure contract. `warningBubble` joins `errorBubble` in `replay`.
  - **Data Stash**: a failed ingest records its reason on the document as `ingestError` (cleared by the next run), and `IngestStatus` gains `'not_indexed'` for a copy stored in a format with no text to index. **Breaking for `GraphStashBridge` hosts** (`@hames-ai/connectors`): `ingest()` now resolves with how the run ended (`GraphStashIngestOutcome`), and `graph_file_ingest` waits up to `INGEST_OUTCOME_WAIT_MS` for it and returns `indexStatus` (`indexed` | `pending` | `failed` | `not_indexed`) plus `indexError`. A host whose `ingest()` still resolves `undefined` (plain JS, or a cast past the type) has every successful index reported as `failed` with "the index run reported no reason" — and the tool tells the model to pass that on — so update the bridge before upgrading.

### Patch Changes

- 6df6a8b: Remove text taken from real conversations and a real tenant from shipped source. Comments in `general.server.ts`, `sandbox.server.ts`, `json-repair.ts` and `types.baml` no longer quote a user's request, a model's status line or a captured payload; they describe the case instead. In `@hames-ai/connectors`, the `graph_mail_attachments` tool's `person` description now gives a placeholder name as its example (`e.g. "Adele"`), and two comments use placeholder names and a placeholder attachment title. No behaviour changes.
- 7876c1a: README badges: npm version, CI, CodeQL, supported Node version and licence.
- 6b47a43: README: add banner
- 07bcdd5: Source comments no longer name the app by its old internal name: the gateway they describe is the Docker MCP gateway, and the global-symbol example is the app's renamed `hames-app.*` key. No behaviour change.
- bcf8147: `withSandbox` can mount Agent Skills. `WithSandboxConfig.skills` is a resolver called per run that returns `SandboxSkill[]` (a name, a description and the whole `SKILL.md`); each is written into the container as `/skills/<name>/SKILL.md` by a content-hash sync, and the model is shown an index of them (name and description only) as an escaped `<skills>` block in the request's `user`-role context, never in the tool list or the system message. The package enforces the specification's name rule and 1–1024-character description, a 64 KiB per-file cap and at most 20 skills per run, and reports what it could not mount as a `warning` event (task `skills_mount`, #420's side-failure scheme). The Docker backend mounts a 4 MiB `noexec` tmpfs at `/skills`. New exports from the root: `SandboxSkill`, `SandboxSkillsResolver`, `SKILLS_DIR`, `SKILL_FILE_MAX_BYTES`, `MAX_MOUNTED_SKILLS`, `isSkillName`. The browser-safe `./skills` subpath also carries `isSkillDescription`, `renderSkillsIndex`, `SKILLS_INDEX_TOOL`, `SKILL_FILE_NAME`, `SKILL_NAME_MAX_LENGTH` and `SKILL_DESCRIPTION_MAX_CHARS`; `./work-sync.server` now also exports `bash`, `shq` and `BashOutcome`. Without `skills`, nothing changes.
  
  `@hames-ai/harness-patterns`: `ToolTransport` gains an optional `promptContext` (never a routing input), and `activeTransportContext()` joins the scoped transports' contexts. `WarningTask` gains `'skills_mount'`.
  
  `@hames-ai/harness-baml`: the loop-controller and actor adapters render `activeTransportContext()` in their `user`-role CONTEXT block.
  
  `@hames-ai/agents`: the sandbox-session agent's welcome text names the app's renamed Sandbox tab.
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
