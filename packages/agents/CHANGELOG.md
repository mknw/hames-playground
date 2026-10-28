# @hames-ai/agents

## 0.4.0

### Minor Changes

- be74388: Tell the Decide step about the conversation's documents (#507). `decisionLoop` takes an optional `documents` source (`(signal) => Promise<DecisionDocuments>`), read once per run before iteration 1, and renders it into the state as a block between the conversation and "This turn so far": a capped list of every visible document's name, type and size when the host's source returns names, `N (names not shown)` when it returns a count only, and nothing when there are no visible documents (such a state is byte-identical to before). Core never reads a tier: the host decides what a run may reveal.
  
  - Names are untrusted text: cut to 80 code points before any rule runs, NFKC-normalised, separators and control characters replaced, invisible, default-ignorable and format characters removed, checked against the injection rule corpus and the state's own headers (a name that trips either is shown as `[name withheld]`), then JSON-quoted on one line. At most 10 names and 1,000 characters, then `+K more documents`. The guard's screen is never run for a name. The check is deterministic, not a confusables filter: a lookalike letter from another script is shown. `mimeType` is mapped through a fixed allowlist, never printed raw.
  - A source that throws, times out (`documentsTimeoutMs`, default `DECISION_DOCUMENTS_TIMEOUT_MS` 30 000, aborts the source's signal) or returns a malformed value gives an explicit `unknown (could not be read)` line (never "none") and one `warning` event (new `WarningTask` `'decision_documents'`); the turn runs as before.
  - `DecisionLoopStateInput.documents` hands the resolved value to a `state` override. New exports: `renderDocumentsBlock`, `DECISION_DOCUMENTS_TIMEOUT_MS`, and the `DecisionDocument`, `DecisionDocuments`, `DecisionDocumentsSource` and `ResolvedDecisionDocuments` types.
  - `listDocumentSummariesStrict(sessionId, callTool?, signal?)` in `stash/document-store.server`: the strict list without the content, one `json_get` per document of just the members a description needs. A failed or unreadable read throws and never prunes; an index entry is pruned only after a successful read that found nothing.
  - `@hames-ai/agents`: `AgentDeps.createDecisionDocuments` (optional); `general-next` passes it to its loop. Without it the state says nothing about documents.
  - Cost: every turn of a conversation with documents waits on the read before the first decision, up to `documentsTimeoutMs`; on the default gateway transport it is one call per document in sequence, so linear in their number. Unmeasured; it must be measured before it can be turned on by default.
  - SPEC: `decision_made`'s `data` carries `stateChars`, never the state text, but the call record holds it twice, in `rawInput` (the request body) and `variables.state`, both persisted with the conversation; deleting or hiding a document does not remove its name from earlier turns' stored states.
- 60836df: **`decisionLoop` no longer sanitises or screens its own route records, and the API the unreleased `decision-loop` entry announced for that is removed before it ships (pre-1.0, so a minor bump).** Guards run where content enters or leaves; a record is built by code from the child's committed events (the model's own plan or Return, a stats line, or a tool-result body that already passed its route's guard) and is only capped. This removes the loop's own call into the run frame's guard, and the planner-only `screenOutput` option that narrowed it (`screenOutput` was added by the unreleased #713 change, whose changeset this entry replaces).
  
  - Removed exports (never in a published release; the migration note is for anyone on a pre-release build): `DECISION_LOOP_OUTPUT_KEY` and `WITHHELD_SCREEN_UNAVAILABLE` (from the package root and from `patterns`), and the route option `screenOutput`. The unguarded-output warning and its test-only `__resetDecisionLoopWarnings` are gone. A `screenOutput` property on a route is no longer read; TypeScript callers get an excess-property error.
  - Removed behaviour: a screen outage no longer withholds a route record (S-d), and `RouteOutput.withheldEventIds` is no longer written. Records an older version persisted still carry `withheldEventIds`, and the loop still reads them back as a filter, so those events stay hidden from every later child.
  - The `actorCritic` and `retriever` extractors, which quote tool-result bodies, now put each body back under the provenance fence it arrived in (the same tool and namespace, no regex pass, no screen) after the cap (the fence's own lines ride on top of the cap), so it reaches the decisions model and the next child's `plan_context` labelled. A body that arrived unfenced stays unfenced, and a fence is labelled only when the run's guard declares the tool it names. A failed route's text (a tool error or a thrown message) gets the same cap-then-fence treatment. An `actorCritic` batch is one fenced block per accepted result, no longer one JSON array.
  - Record text the loop did not build (the plan's record, a Return, reasoning, failure text) renders into the decision state and the handoff as one JSON string, the handoff block gains an end line (`HANDOFF_END`), and the state's results heading says the results are data.
  - New: `closeCutFences(text)` and `unspotlightParts(text)` from `@hames-ai/harness-patterns/guard`, the sibling of `unspotlight` that also returns the `tool` and `namespace` the header named. `extract(kind, events, max)` (the records module) now takes the cap as a required third argument and returns every text field already capped (`carryText` is the same cap for a thrown message).
  - Migration: delete `DECISION_LOOP_OUTPUT_KEY` from any guard's `tools` and from imports, delete `screenOutput`, and move any screen you relied on for route records onto the routes' own guards (the tools a route reads). A guard around the whole loop no longer has anything of the loop's to guard; the GUIDE sample shows route guards and no orchestrator guard.
  - `general-next` drops the key from its orchestrator guard and `screenOutput` from its `think` route; its office and info route guards keep their screens.
- dfffba2: **Breaking (pre-1.0, so a minor bump): what leaves is judged by a new egress gate, and `withPseudonymisedInputs` no longer checks or refuses outgoing calls.**
  
  - New: `withEgressGate(config)(pattern)` installs one `egressChecks` entry and one `afterToolCall` hook around the pattern it wraps, so every `callTool` inside it is covered on every tier. A call is egress unless its namespace is in `local` or its exact name in `localTools` (a `localTools` name that is in `catalog` refuses the run; `local`, `fetchTools` and `addressSources` are verified against `catalog` when the gate runs, and `fetchTools` without `addressSources` refuses construction). Per outgoing call: a closed turn or route, or a damaged roster, refuses with no model call; then deterministic refusals (undecodable percent-encoding, a Unicode format or default-ignorable character, a `PERSON_n` placeholder, a decoded block over 2 048 characters, never truncated, and for a tool in `fetchTools` an address-carrying or `url` argument that is not, whole, an address found in the user's latest message or in the data of a result from an `addressSources` namespace); then, in `'filter'` mode, the `guard.egress` question (`GUARD_EGRESS`, a `choice` over `personal`, `company`, `nothing_private`) asked over a state the gate renders with a per-call nonce, every quoted line prefixed `"> "`, a `Destination named in the request:` line per host (nested redirector hosts included) and the host roster's matched spans as evidence. At or above τe (0.3) on 1 − P(`nothing_private`) the call is refused with the larger private label's fixed text; below it the call goes out, and a roster match is recorded as an `egress_audit` event. In `'roster'` mode, or with Decide down, the directory status the roster reports decides (`loaded`, `empty`, `unreadable`, `none`; `loadedDecideDown: 'by-shape' | 'ask'`).
  - The tripwire: a refusal on Decide's answer or for want of one is an `egress_refused` event, and refusal `maxOutgoingRetriesPostTripwire + 1` (default 0, so the first) closes that route's outgoing calls until the user's next message. The counts are derived from the turn's recorded refusals (`egressClosures`), so they survive a pause, and a route's checks run in batch order.
  - New exports: `withEgressGate`, `egressClosures`, `GUARD_EGRESS`, `EGRESS_TEXTS` (every text the gate returns, none interpolated), `EGRESS_WARNINGS`, `EGRESS_WARNING_TASK`, `GUARD_EGRESS_THRESHOLD`, `GUARD_EGRESS_TIMEOUT_MS`, `EGRESS_MAX_BLOCK_CHARS`, `EGRESS_SMALL_BLOCK_CHARS`, `EGRESS_USER_CAP`, `EGRESS_SPAN_CAP`, `readOutgoing`, `destinationHosts`, `renderEgressState`, `EGRESS_CHECK_FAILED`, `LINE_BREAK` (from `guard-gate.server`), and the `EgressGateConfig`, `EgressRoster`, `EgressRosterSource`, `EgressDirectoryStatus`, `EgressMode`, `EgressClosures`, `OutgoingRequest`, `ReadOutgoing`, `EgressStateInput`, `EgressAuditEventData`, `EgressRefusedEventData` and `EgressProbabilities` types. New event types `egress_audit` and `egress_refused` (always committed, rendered metadata-free into LLM-facing views); a new `WarningTask`, `egress_check`; `WarningEventData.detail`.
  - `RunFrame.route`: `decisionLoop` writes its route key around each child; it replaces on `amendRunFrame` like most slots.
  - **Removed from `withPseudonymisedInputs`:** its `egressChecks` entry (K6), its `afterToolCall` roster extension and its refusal of web calls when the host filter is unavailable. A failed host filter still withholds earlier content; its warning no longer says web calls were refused. `WebPseudonymisation` loses `check` and `observe`.
  - A throwing `egressChecks` entry now denies with `EGRESS_CHECK_FAILED` ("Refused: the check on outgoing requests failed, …") instead of "Tool call refused: outgoing privacy check unavailable."
  - The shared fence neutraliser (`neutralizeFenceMarkers`) is replaced: it turns the marker words of both fence forms (`BEGIN|END UNTRUSTED CONTENT` and `BEGIN|END CONTENT UNDER REVIEW`) into `[fence]`, word-bounded, and no longer deletes the 40 characters after a marker from what the screen, the guard gate and the egress question read.
  - Embeddings: `TRUSTED_EMBEDDING_PROVIDERS` (empty) and `embeddingProviderPassesEgress()` in `stash/embeddings.server`: `local`, unset, or a provider declared trusted in code.
  - `@hames-ai/agents`: `AgentDeps.egressRoster` (optional); `general-next` wraps its decision loop in the egress gate (`'filter'` on both tiers, N = 0, `loadedDecideDown: 'by-shape'`; fetch addresses from `web`, `context7` and `graph` results; local: `neo4j`, `graph`, and the office sandbox's in-VM tools by name only while that box is booted `mcp-only`, `officeLocalTools()`).
  - `@hames-ai/connectors`: `graph_file_ingest` refuses any embedding provider that does not pass `embeddingProviderPassesEgress` (an unregistered value as well as `openrouter`). No Graph result echoes a string the controller wrote, because `graph` is an address source: `graph_files_search` no longer returns `query` (`GraphFileSearchResult.query` is removed), and `graph_files_shared`'s empty-result note says "by the person named" instead of quoting `shared_by`.
  
  Migration: if you composed `withPseudonymisedInputs` for its outgoing check, wrap the pattern (or the whole loop) in `withEgressGate({ local, catalog: tools.all, decide, roster })` instead; a host `PseudonymiseForWeb` can drop `check` and `observe`, and a host roster for the gate implements `EgressRosterSource` (`{ directory, roster: { match, observe } }`). To keep the old "a roster match refuses by itself" behaviour, declare `mode: 'roster'`. A gate with `fetchTools` must also declare `addressSources`, the namespaces whose result data gives the controller addresses; leave out any whose tools compute their output from their arguments (a query engine, a code box). The cost, accepted: an address stored only there (for example a URL held only in Neo4j) is not fetchable until a search or another source returns it. Code that matched the old thrown-check text should match `EGRESS_CHECK_FAILED`.
- 787830f: Add general-next beside general: guarded decision-loop routes for Microsoft 365
  and an office sandbox, Neo4j/web lookup, conversation-document retrieval and
  planning. The candidate also opts into optional memory, with recall reaching
  only synthesis; general keeps its opt-in until the default-agent flip. Enable Graph file ingestion only when the host explicitly permits it; keep turn-results materialisation disabled and require the S7 web-route pseudonymisation guard.
- c46aa3c: general-next's info route gains `context7` library docs and the memory graph's
  targeted read tools (`search_nodes`, `open_nodes`) under the same injection
  guard and web-route pseudonymisation boundary; memory write tools stay withheld.
  `withPseudonymisedInputs` now treats `memory` as a local namespace beside
  `neo4j`, keeps `context7` under the outgoing check, and stops extending its outgoing
  literals from `context7` results (as already for web).
- 540c5a5: **Breaking (pre-1.0, so a minor bump): the injection guard's `screen` option is a config object, and its model screen can sit behind a gate.**
  
  - `screen` takes `{ run, mode?, gate?, onUnavailable?, exempt?, classify? }` instead of a bare `InjectionScreen`. `run` is the screen you passed before.
  - `mode` is `'off' | 'shadow' | 'gated' | 'always'`, per tier: a bare value or a `ByTier` map such as `{ default: 'shadow', anthropic: 'always' }`, resolved per call against the registered `effectiveTier()` by the new `resolveByTier()`. Default: `'always'` for a screen alone, `'shadow'` when a `gate` is passed. A mode that asks a gate with none passed refuses construction, and so do a `run` that is not a function, a mode that is not one of the four (on any tier), a per-tier map with no `default` and an `onUnavailable` other than `'pass'` or `'withhold'`. Read per call, an unrecognised mode runs the screen and an unrecognised `onUnavailable` withholds.
  - **Removed: `screenDespiteFindings`.** A deterministic finding now forces the screen in every mode but `'off'`, on the sanitized projection and with no gate call. A guard that declared a screen without that option used to skip the screen on any result with a finding; it now screens it, one more model call per such result.
  - New: `createGuardGate(decide, settings?)` (its state is refused over `maxStateBytes`, default `GUARD_GATE_MAX_STATE_BYTES` = 32 000, which runs the screen) and `GUARD_SCREEN` (the `guard.screen` noul question), `guardGateSkipRate(events)`, `neutralizeFenceMarkers()` (the screen's fence neutraliser, now shared), `SCREEN_WITHHELD`, `resolveByTier()`, and the `ByTier`, `ScreenMode`, `GuardGate`, `GuardGateVerdict`, `IngressClass`, `IngressClassifier` and `InjectionScreenConfig` types. Each gate answer is a `decision_made` event keyed `guard.screen`.
  - `onUnavailable: 'withhold'` replaces a payload whose screen threw with a fixed marker (`SCREEN_WITHHELD`, which tells the controller to answer without it); `'pass'`, the default, keeps today's behaviour.
  - `exempt` names declared namespaces neither the gate nor the screen runs on; an undeclared one refuses construction. `classify` is the host's: an `'internal'` payload gets the deterministic layer only, unless it has a finding; without one every payload is external.
  - `DecideInput` gains an optional `signal`, which `evaluateDecision` passes through and the systemone transport hands to its fetch, so a caller's deadline aborts the request. `LlmUsageSample` gains `decisionKey` for Decide calls.
  - `ScreenUntrustedContent`'s definition of an injection now follows the gate's question (text aimed at the AI reading it), with the gate's behaviour list item for item; its signature is unchanged.
  - `@hames-ai/connectors`: `registerGraphConnectorTools` takes an optional `homeDomains` supplier; the mail, calendar, shared-with-me and mail-attachment tools stamp each item and result with a non-enumerable `GRAPH_PROVENANCE` (`'home' | 'external' | 'unknown'`) computed from the raw addresses before shaping, read with `graphProvenance()`. No serialization carries it. Also new from `graph/graph-tools.server`: `isHomeAddress()` (a sender's domain matches only in its canonical spelling, so a spelling IDNA folds onto a home domain is not home), `provenanceOf()` and the `GraphProvenance` type.
  - `@hames-ai/agents`: `AgentDeps.classifyIngress` (optional). `general-next`'s office and info guards declare the screen behind the gate, `{ default: 'shadow', anthropic: 'always' }`, with the host's classifier.
  
  Migration: replace `screen: myScreen` with `screen: { run: myScreen }` (behaviour on clean content is unchanged: `'always'`), and delete `screenDespiteFindings` (its behaviour is now the default). To keep a screen off results that already have a deterministic finding, there is no option: that is the change. A custom `DecideFn` should pass `input.signal` to its request when it has one.
- 49888cd: **The guards' operator switches: the host's `GUARD_*` variables reach the agents through one `AgentDeps.guards` field.**
  
  - New on `AgentDeps`: `guards?: AgentGuards` — `{ screenMode?, egressMode?, classifyIngress?, pseudonymiseForWeb? }`, the four fields the guard settings compose under. `screenMode` replaces `general-next`'s screen tier map (`ByTier<ScreenMode>`), `egressMode` sets the egress gate's `mode` (`ByTier<EgressMode>`; absent keeps `'filter'`), `classifyIngress` and `pseudonymiseForWeb` carry what their two old `AgentDeps` fields carried.
  - **Breaking (pre-1.0, so a minor bump): `AgentDeps.classifyIngress` and `AgentDeps.pseudonymiseForWeb` are removed** — both move under `guards`, so the screen's gating has one `AgentDeps` path, not two. Hosts pass `guards: { classifyIngress, pseudonymiseForWeb }` instead of the two flat fields. With a `guards` bag present but no `pseudonymiseForWeb`, `general-next` composes its info route WITHOUT `withPseudonymisedInputs` (the `GUARD_PSEUDONYMISE=off` reading: the switch is off, not unconfigured); a bag with no `guards` field at all keeps the old shape — the wrapper is composed with no filter, which withholds inherited content rather than pass it through unfiltered (G14 D3).
  - `AgentDeps.egressRoster` stays its own field: it is wiring the gate reads at run time, not a switch, and no `GUARD_*` variable turns the roster on or off.
  - `@hames-ai/harness-patterns`: nothing changes — the switches set values its existing `ByTier` settings already take (`ScreenMode` for the screen, `EgressMode` for the gate), and a patch bump records that the package gained no surface in this slice.
- 467e9be: **Breaking (pre-1.0, so a minor bump): nested `withInjectionGuard`s no longer merge their options.** A tool is now sanitized with the options of the innermost guard that declares it, and a guard that does not declare a tool hands it to the enclosing guard, which applies its own. Coverage still unions: an inner guard can never un-guard a namespace or tool an outer guard declared.
  
  - Removed: the `strictestSpotlight` export, and the merge of `disableRules` (was an intersection), `rules` (was a union), `spotlight` (was the strictest), `screen` (was inherited) and `screenDespiteFindings` (was an OR) across nested guards.
  - `ActiveInjectionGuard.options` is replaced by `optionsFor(tool)`, the options that govern that tool. A hand-built `ActiveInjectionGuard` needs the new member.
  - Migration: an option you relied on an enclosing guard to supply (a `screen`, `spotlight: 'always'`, an extra rule) is now declared on each guard whose tools should have it. An inner `disableRules` or weaker `spotlight` no longer reaches the outer guard's tools, so nothing needs removing for that direction. This holds for tools the inner guard does not itself declare: a tool declared by two guards takes the inner guard's options.
  - `general-next` declares its route guards' options itself: `spotlight: 'always'` on all three, the screen (with `screenDespiteFindings`) on the office and info guards, none on the documents guard. The orchestrator guard keeps the fence and loses its screen, so a retriever hit and a route-output record are no longer model-screened; every other guarded tool result is screened as before.
- 93ca260: **Breaking:** remove the `general` agent. `generalAgent` and the
  `@hames-ai/agents/agents/general.server` module are gone, and the package now ships five
  agent definitions instead of six. `general` was a planner followed by one loop over every
  tool the gateway listed, with no injection guard, so it was the one agent that could read
  fetched web content and write the shared memory graph in the same turn.
  
  Migration: register `generalNextAgent` (it needs `deps.withSandbox` and
  `deps.createRedisBackend`) wherever you registered `generalAgent`, and keep resolving the
  old `general` id to it so stored conversations and scheduled routines still open (the
  reference host does this in one map entry). No other agent takes the whole tool surface:
  each takes a namespace slice, and `general-next` is handed only the read tools of the
  memory namespace.
- 2d24874: **Breaking:** retire the shared memory graph (the `memory` MCP server and its tools).
  Personal memory is unchanged: `withMemory` stores and recalls per-user memories in
  Postgres. This supersedes the earlier entry that gave `general-next`'s info route
  the memory graph's targeted read tools (`search_nodes`, `open_nodes`): with the
  graph gone, those tools go with it.
  
  - `@hames-ai/connectors`: `MCP_TOOL_CATALOG` / `mcpNamespace` no longer map the nine
    memory-graph tools (`create_entities`, `create_relations`, `add_observations`,
    `delete_entities`, `delete_relations`, `delete_observations`, `open_nodes`,
    `search_nodes`, `read_graph`) to a `memory` namespace, so `Tools()` returns no `memory`
    list. The catalog is 77 names across five namespaces.
  - `@hames-ai/agents`: `general-next` no longer holds the memory graph's read tools, and its
    info route's description and capability no longer mention a memory graph.
    `isMemoryGraphResult` is no longer exported, `GraphElement.source` is
    `'neo4j' | 'unknown'`, and the graph extractor no longer parses memory-graph results.
  - `@hames-ai/harness-patterns`: `withPseudonymisedInputs` treats only `neo4j` as a local
    namespace; a tool that still resolves to `memory` is egress-checked like any other.
    `isReadOnlyTool` no longer lists `open_nodes`.
  
  Migration: remove the `memory` server from your gateway catalog and config, drop any
  `tools.memory` read, and drop any import of `isMemoryGraphResult`. A gateway that still
  serves those tools hands them to no agent shipped here. Decide separately what to do with
  the old server's data volume before deleting it.
- 3819eee: Record sandbox output provenance in stored documents and retrieved chunks. Exclude promoted documents from the General Agent Next web route's reference previews and expansions while keeping them available for document search and user answers.
- 8f8ebd0: Add `withPseudonymisedInputs` and its host `PseudonymiseForWeb` seam for #507 G14.
  Rewrite and post-check earlier event-data copies and all inherited child data on
  every run except an explicit Anthropic run, preserving provenance fences,
  restricting copied events to the child's view and withholding residual identities
  per string body. Missing or unavailable host wiring still fails closed. Check
  outgoing arguments for every capability except declared local reads at `callTool`
  through concatenating run-frame
  `egressChecks`. `decisionLoop` supplies every preceding iteration's source
  payloads as roster-only input to declaring routes, removed before inner dispatch.
  Local results extend the outgoing literal check through `afterToolCall`.
  ActorCritic output records unfence string leaves before JSON stringification;
  literal checks normalise JSON escapes and bound compact names to single tokens.
  `AgentDeps.pseudonymiseForWeb` lets hosts supply the ephemeral implementation.

### Patch Changes

- 3e816f9: `createActorControllerAdapter` now renders `input.availableTools` together with its own `toolNames`, so an actor pattern's allowlist no longer has to be declared twice. `general-next` drops its duplicate `toolNames`.
- 37fb68c: general-next: when a route this turn already ran and its result reports the lookup could not be done (an error, not merely nothing found), the `answer` criterion tells the decisions model to answer with that reported failure instead of dispatching the route again. Fixes a case from end-to-end testing ([#606 (comment)](https://github.com/mknw/hames-playground/pull/606#issuecomment-6447533657)): the decider re-dispatched info-retrieval six times over a child that had already honestly reported the failure.
- 8d2c4dc: general-next: exact calculation on numbers in the user's latest message (arithmetic, percentages, averages, sums) is described as sandbox work, and the answer is the computed number once the sandbox has run.
- 46b2cac: **`general-next` declares `context7` as an egress address source only when the gateway offers a context7 tool**, as its info guard already did. The egress gate refuses, on every turn, an `addressSources` namespace no catalog tool resolves to, so a gateway without context7 failed every `general-next` turn before any route ran. With no context7 tool there is no context7 result to give an address, so nothing the gate allows changes.
- b99620f: Docs: `general-next` is now the reference app's default agent (a new chat opens on it).
  The agents README and harness-patterns' SPEC and GUIDE no longer say the default is `search`
  or unchanged.
- 4889011: general-next: the office-data actor's prompt now lists the Graph read tools. They were allowlisted on the route but the actor adapter never received them, so the model was shown only the sandbox tools. `graph_file_ingest` stays withheld by exact name.
- 7fbee82: `general-next`'s `read-documents` route description now also covers a file the user names that an earlier lookup (the info route) did not find, so the decision after an info result of "not found" has a criterion to match; the effect on routing has not yet been verified end to end.
- 44569ee: Add `withSandbox({ lazy: true })`: the sandbox starts on the first `sandbox_*` call rather than at the turn's entry, so a turn that only reads Microsoft 365 data needs no container engine. A sandbox that cannot start now fails the call with a fixed, classified sentence (`classifySandboxFailure`); the engine's own error goes to the server log only and never reaches the model; the same goes for a step that fails after the sandbox started (file restore or save, skills mount), whose events no longer carry the raw error in lazy mode. The general-next office route opts in.
- c63157f: Demonstrate the office actor's JSON action envelope with synthetic Graph and document-creation examples.
- fedebd9: `general-next`'s office actor now carries one Markdown deliverable example (read an input, save the `.md` under `/work/out`, print the path, in one command) and a sentence that a requested file exists only after a command has written it; its effect on the Markdown scenarios has not yet been verified end to end.
- f1d0942: **Breaking for hosts registering Graph tools:** supply a per-call `fileIngestAllowed`
  predicate. File ingestion refuses before I/O unless that predicate positively
  allows the call, and refuses OpenRouter embedding. The app requires both an
  explicit private run frame and a private-only deployment until tier-flip release
  is implemented. General-next advertises Graph file ingestion in its
  office route only when the host enables the deployment capability, preserving original bytes for sandbox analysis and cited retrieval.
- 8ce163a: Support host-enforced private-only inference and refuse unguarded public BAML calls before requests are constructed.
- 57e1784: `general-next`'s `read-documents` route description now covers an uploaded file the user names without saying "uploaded" (running code over a file stays `office-data`), and `info-retrieval` says it cannot open files uploaded to the conversation while still reaching a file at a web address; the effect on routing has not yet been verified end to end.
- b36299a: docs: README fixes from the blind first-contact read before the 0.4.0 cut (#818). The stale "These packages are at 0.1" note is restated truthfully at 0.4.0 in all five READMEs. `@hames-ai/agents`: one agent count everywhere (five verified against the source barrel, including the package description); `guards` and `egressRoster` join the `AgentDeps` excerpt; the four `GUARD_*` operator switches the prose promised "below" are now listed with their values; the `general` → `general-next` migration and the internal shorthand in the general-next paragraph are behind absolute links. `@hames-ai/harness-baml`: the Systemone section now says what the decisions endpoint is, that it is optional and how to configure one, explains `noul`, and links the preview runbook section absolutely. `@hames-ai/connectors`: the graph-edit write ops get a one-paragraph example and a statement of how they coexist with the agents' read-only guarantee, and the shipped `./document` subpath is named in the exports table.
- 0ff551e: **A pause can be resumed inside a route (decision-loop-agent.md slice 6).** After an answer, the run continues inside the pattern that paused, from the held call, instead of re-entering the paused top-level pattern from its start.
  
  - New capability `resumable` (`PatternCapabilities.resumable`): `decisionLoop`, `simpleLoop` (when it records its rounds under an explicit `patternId`), `withReferences`, `withInjectionGuard`, `withEgressGate` and `withPseudonymisedInputs` declare it; `actorCritic`, `withSandbox`, `parallel`, `routes` and `chain` do not. A wrapper that spreads the pattern it wraps does not inherit it (`ownResumable`).
  - Each request records a `continuation`, the resumable path from the top-level pattern to the gate. `checkResume` follows it through the current composition before any `resolve`; an absent, changed or non-resumable path is `chain-changed`. A pause below a top-level pattern that is not resumable keeps the 0.x re-entry from its start.
  - On re-entry `decisionLoop` rebuilds its records, latest plan and roster inputs from its children's brackets and re-enters the paused route with no decide call; `simpleLoop` rebuilds its turn log, turn count and recovery streak through the one projection its live rounds use; `withReferences` re-attaches its recorded selection without calling the selector. No earlier tool is dispatched again.
  - `decisionLoop` children's `pattern_enter` carries `iteration`, and a paused child's `pattern_exit` says `paused` and carries `wallMs`.
  - New `gatedTools` (on `decisionLoop`, and as a capability): construction refuses a gated name in any allowlist whose path from the root is not resumable all the way down, or in a loop that does not record its history (`refuseUnresumableGates`, also run by the harness entry points); `simpleLoop` refuses a batch that holds one before dispatching any of its calls.
  - `withReferences` now records its `reference_attached` selection by default, and that event serializes as counts only, never its candidates' summaries or the selector's reasoning. A `loop_recovery` for an unparseable answer carries the `feedback` the next round was given; a skipped batch call's `tool_result` carries `skipped: true`.
  - A host's own wrapper joins the path with `wrapperResumable` and `resumableStep`.
- 37ded19: Demonstrate the sandbox actors' JSON action envelope: one expressive multi-step example (narrated explore/inspect steps, transform-and-deliver action) per list, plus one shared contrastive negative that labels the model's native tool-call syntax WRONG with the same call corrected in JSON.
- d0365ed: BREAKING (shipped as a minor bump): rename the
  built-in inference tier from `verda` to `self_deployed`, the BAML clients to
  `LargeQwen` / `LargeQwenThink` (the 27B) and `SmallQwen` (was `LocalQwenSmall`; the
  small box runs on Modal, so `Local` was a misnomer, and `LocalGLM` keeps its name),
  and the exported routing and cost identifiers. `self_deployed` names the tier (two boxes); identifiers about the large
  model alone take `large` (`largeEurPerHour`, `LARGE_LLM_MODEL_ID`, the `'large'`
  wake box). The full old → new table, with each name's scope, is in
  `docs/deployment/self-deployed-migration.md`.
  
  Migration for consumers: update imports, role maps (`VERDA_CLIENT_BY_ROLE` →
  `SELF_DEPLOYED_CLIENT_BY_ROLE`), model tables, cost-rate registration
  (`verdaEurPerHour` → `largeEurPerHour`), `VERDA_CLIENT_NAME` → `LARGE_LLM_CLIENT_NAME`,
  `assertServedByVerda` → `assertServedByLarge`, per-call `client` overrides and run frames
  together. Regenerate the BAML client from the renamed `large-client.baml`. A run frame still
  carrying `'verda'` is read as `self_deployed` (and only that spelling).
  
  The reference host reads historical tier values, and stored `VerdaQwen` /
  `VerdaQwenThink` / `LocalQwenSmall` client names, without rewriting rows. Migrate
  27B settings to `LARGE_LLM_BASE_URL`, `LARGE_LLM_API_KEY`, `LARGE_LLM_EUR_PER_HOUR`,
  `LARGE_LLM_SCALEDOWN_SECONDS` and `LARGE_LLM_WAKE_*`; use
  `USE_SELF_DEPLOYED_INFERENCE=1` for the boot-time check that the tier is configured and
  `INFERENCE_TIERS=self_deployed` for the restriction. Old environment names and
  `INFERENCE_TIERS=private` remain accepted for one release with a boot warning; the
  list of what is removed afterwards is in the migration doc. Verda control-plane
  credentials retain their provider-specific names. UI copy continues to say Private.
- d89bf08: `compactExecution` (#507 W4): the user's message is read past a `viewConfig.fromPatterns` scope (it is a `harness`-level event, so a scoped synthesizer received an empty `userMessage` and `intent`), and a new optional `threadTurns` widens only the scoped `thread` read, so a follow-up turn keeps the previous turn's committed `decisionLoop` records while the error read keeps its own window and an earlier turn's failed or withheld record is not carried forward. `threadTurns` must be an integer >= 1 and is refused at construction unless `mode` is `'thread'` and `viewConfig.fromPatterns` is set; the user message is read only from `harness`. `general-next` sets `threadTurns: 2`. The records stay sanitized and fenced, and a record withheld by a screen outage stays marker-only.
- 03d15fc: Refuse thinking leaves selected through registry chains for functions without a designated thinking counterpart, retaining usage accounting and preventing corrective retries on the unsupported leaf.
  
  Behaviour change for custom controllers: `accountBamlCall`, `withUsageAccounting`, `extractLLMCallData` and `extractFailureLLMCallData` now throw a non-recoverable `LLMCallError` after accounting when the selected leaf or rendered request enables thinking for an undesignated function. `THINKING_FUNCTIONS_BY_CLIENT` is a new public export listing designated counterparts.
  
  Client overrides carrying `collector` are refused by both routing lookups; adapters and the title agent retain their own accounting collector.
- 621ced6: Clarify that general-next's office-data route computes over uploaded spreadsheets, CSV and tables and saves deliverables.
- 7fe7967: Require general-next's info controller to cite source URLs in its Return so the final answer can preserve them.
- Updated dependencies [e6f6562]
- Updated dependencies [3e816f9]
- Updated dependencies [a419d43]
- Updated dependencies [4f0c766]
- Updated dependencies [be74388]
- Updated dependencies [0b4a682]
- Updated dependencies [60836df]
- Updated dependencies [4190880]
- Updated dependencies [959966b]
- Updated dependencies [dfffba2]
- Updated dependencies [d6b58f4]
- Updated dependencies [33c71cf]
- Updated dependencies [c46aa3c]
- Updated dependencies [b99620f]
- Updated dependencies [540c5a5]
- Updated dependencies [49888cd]
- Updated dependencies [467e9be]
- Updated dependencies [5ea0d3d]
- Updated dependencies [50ac40e]
- Updated dependencies [3b967a8]
- Updated dependencies [e7f697e]
- Updated dependencies [7ec2dd2]
- Updated dependencies [40d3627]
- Updated dependencies [7034d6d]
- Updated dependencies [f1d0942]
- Updated dependencies [8ce163a]
- Updated dependencies [b1f162c]
- Updated dependencies [b36299a]
- Updated dependencies [e5b773d]
- Updated dependencies [0ff551e]
- Updated dependencies [2d24874]
- Updated dependencies [e4c744d]
- Updated dependencies [a65a7b7]
- Updated dependencies [3819eee]
- Updated dependencies [1b84721]
- Updated dependencies [e39d5a4]
- Updated dependencies [d0365ed]
- Updated dependencies [fdaf3f8]
- Updated dependencies [ed4eed3]
- Updated dependencies [d89bf08]
- Updated dependencies [3896e47]
- Updated dependencies [372bb26]
- Updated dependencies [03d15fc]
- Updated dependencies [2e0e103]
- Updated dependencies [55a780e]
- Updated dependencies [0f0121a]
- Updated dependencies [8f8ebd0]
  - @hames-ai/harness-baml@0.4.0
  - @hames-ai/harness-patterns@0.4.0

## 0.3.0

> The published 0.3.0 tarball differs from the tag only in README.md (Neo4j egress wording, #241 G13); no code differs.

### Minor Changes

- fb4fac8: Opt the General agent into persistent memory when the host supplies `AgentDeps.memory`. Recall and storage continue to honor the user's memory switch.
- 9451b77: Add optional MemoryConfig to AgentDeps so hosts can supply memory without opting any agent in.

### Patch Changes

- Updated dependencies [59af7c6]
- Updated dependencies [b52215c]
- Updated dependencies [6970e8b]
- Updated dependencies [bcf7ab4]
- Updated dependencies [220e794]
- Updated dependencies [e5fc954]
- Updated dependencies [fa529f0]
- Updated dependencies [d65f08e]
- Updated dependencies [6e4a7ce]
- Updated dependencies [ab78dea]
- Updated dependencies [e6543b1]
- Updated dependencies [f97fd50]
- Updated dependencies [5efffdf]
- Updated dependencies [8b8b72c]
- Updated dependencies [ffc87ba]
- Updated dependencies [08ff54f]
- Updated dependencies [30fdf03]
- Updated dependencies [0405113]
- Updated dependencies [5f377c5]
- Updated dependencies [459122e]
- Updated dependencies [1acfe23]
- Updated dependencies [f13bb7d]
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
