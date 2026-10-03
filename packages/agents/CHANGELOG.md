# @hames-ai/agents

## 0.2.0

### Minor Changes

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
- 7876c1a: README badges: npm version, CI, CodeQL, supported Node version and licence.
- bcf8147: `withSandbox` can mount Agent Skills. `WithSandboxConfig.skills` is a resolver called per run that returns `SandboxSkill[]` (a name, a description and the whole `SKILL.md`); each is written into the container as `/skills/<name>/SKILL.md` by a content-hash sync, and the model is shown an index of them (name and description only) as an escaped `<skills>` block in the request's `user`-role context, never in the tool list or the system message. The package enforces the specification's name rule and 1–1024-character description, a 64 KiB per-file cap and at most 20 skills per run, and reports what it could not mount as a `warning` event (task `skills_mount`, #420's side-failure scheme). The Docker backend mounts a 4 MiB `noexec` tmpfs at `/skills`. New exports from the root: `SandboxSkill`, `SandboxSkillsResolver`, `SKILLS_DIR`, `SKILL_FILE_MAX_BYTES`, `MAX_MOUNTED_SKILLS`, `isSkillName`. The browser-safe `./skills` subpath also carries `isSkillDescription`, `renderSkillsIndex`, `SKILLS_INDEX_TOOL`, `SKILL_FILE_NAME`, `SKILL_NAME_MAX_LENGTH` and `SKILL_DESCRIPTION_MAX_CHARS`; `./work-sync.server` now also exports `bash`, `shq` and `BashOutcome`. Without `skills`, nothing changes.
  
  `@hames-ai/harness-patterns`: `ToolTransport` gains an optional `promptContext` (never a routing input), and `activeTransportContext()` joins the scoped transports' contexts. `WarningTask` gains `'skills_mount'`.
  
  `@hames-ai/harness-baml`: the loop-controller and actor adapters render `activeTransportContext()` in their `user`-role CONTEXT block.
  
  `@hames-ai/agents`: the sandbox-session agent's welcome text names the app's renamed Sandbox tab.
- d4a7684: **`sanitizeTitle`** no longer strips quotes that have no partner (#454). It used to take a leading run and a trailing run of quote characters separately, and only then strip trailing `.!?`. So `Review of "Dune"` lost its closing quote, and `"Title".` kept one, because the `.` hid it from the strip. Now it peels one layer per pass, from the outside in: trailing punctuation first, then a quote pair that wraps the whole title. A quote is removed only together with a matching quote at the other end, and only when that quote closes the title rather than an inner span: `"Dune" and "Arrakis"` is left alone. Punctuation is stripped whether it sits outside the quotes or inside them, so `"Title".` and `"Title."` both become `Title`. **Behaviour change**: a quote with no matching partner at the other end, such as `"Dune Review` or `"Dune Review'`, is now kept where it used to be stripped. A wrapping pair is also kept when the first quote of the same kind inside it ends a word, as in `'The Jones' House'`: that quote looks the same as the one closing `'Dune'` in `'Dune' and 'Arrakis'`.
- Updated dependencies [3e0bdf8]
- Updated dependencies [51f96c6]
- Updated dependencies [af875e4]
- Updated dependencies [f6ed2c6]
- Updated dependencies [f6326c3]
- Updated dependencies [2bb03a4]
- Updated dependencies [9c568cc]
- Updated dependencies [7876c1a]
- Updated dependencies [07bcdd5]
- Updated dependencies [bcf8147]
- Updated dependencies [355994d]
  - @hames-ai/harness-patterns@0.2.0
  - @hames-ai/harness-baml@0.2.0
