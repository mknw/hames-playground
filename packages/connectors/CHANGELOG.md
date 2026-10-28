# @hames-ai/connectors

## 0.4.0

### Minor Changes

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
- f1d0942: **Breaking for hosts registering Graph tools:** supply a per-call `fileIngestAllowed`
  predicate. File ingestion refuses before I/O unless that predicate positively
  allows the call, and refuses OpenRouter embedding. The app requires both an
  explicit private run frame and a private-only deployment until tier-flip release
  is implemented. General-next advertises Graph file ingestion in its
  office route only when the host enables the deployment capability, preserving original bytes for sandbox analysis and cited retrieval.
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

### Patch Changes

- b36299a: docs: README fixes from the blind first-contact read before the 0.4.0 cut (#818). The stale "These packages are at 0.1" note is restated truthfully at 0.4.0 in all five READMEs. `@hames-ai/agents`: one agent count everywhere (five verified against the source barrel, including the package description); `guards` and `egressRoster` join the `AgentDeps` excerpt; the four `GUARD_*` operator switches the prose promised "below" are now listed with their values; the `general` → `general-next` migration and the internal shorthand in the general-next paragraph are behind absolute links. `@hames-ai/harness-baml`: the Systemone section now says what the decisions endpoint is, that it is optional and how to configure one, explains `noul`, and links the preview runbook section absolutely. `@hames-ai/connectors`: the graph-edit write ops get a one-paragraph example and a statement of how they coexist with the agents' read-only guarantee, and the shipped `./document` subpath is named in the exports table.
- Updated dependencies [a419d43]
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
- Updated dependencies [b1f162c]
- Updated dependencies [b36299a]
- Updated dependencies [0ff551e]
- Updated dependencies [2d24874]
- Updated dependencies [e4c744d]
- Updated dependencies [a65a7b7]
- Updated dependencies [3819eee]
- Updated dependencies [1b84721]
- Updated dependencies [e39d5a4]
- Updated dependencies [d0365ed]
- Updated dependencies [ed4eed3]
- Updated dependencies [d89bf08]
- Updated dependencies [3896e47]
- Updated dependencies [55a780e]
- Updated dependencies [8f8ebd0]
  - @hames-ai/harness-patterns@0.4.0

## 0.3.0

> The published 0.3.0 tarball differs from the tag only in README.md (Neo4j egress wording, #241 G13); no code differs.

### Patch Changes

- 84536cf: `ooxmlDisarm`'s pptx placeholder resolver (#517).
  
  - **Linear lookup.** A run's layout and master placeholder used to be found by scanning every placeholder the part declares, so a slide of n runs over a layout of m distinct placeholders cost O(n·m) CPU: about 17 s for a 599 KB file at n = m = 32,000. Each style part is now indexed once when it is read, and each run is one lookup.
  - **Concealment coverage.** A placeholder whose type is written in camelCase — `ctrTitle`, `subTitle`, `sldNum`, `clipArt`, `sldImg` — never matched its layout, master or notes-master placeholder by type, so text hidden through that inheritance (white at 1 pt, for example) was not counted and the document reported `hiddenContent: 'removed'`. Types now match whatever their case, and such text counts as `colour-contrast` and `too-small`. In the same class, a placeholder written with no `type` — ECMA-376's default `obj`, the stock content placeholder — now takes its master's `bodyStyle` rather than `otherStyle`, so text that `bodyStyle` hides counts too.
- bfef4f4: `ooxmlDisarm` no longer reports hidden pptx placeholder text as removed when it is inherited through a route the resolver did not read. A slide placeholder now matches its layout placeholder by exact type and idx first, with ECMA-376's defaults (`type` obj, `idx` 0) and unsignedInt idx spellings; a level the matched placeholder lacks goes up to the master rather than to a sibling; the master placeholder is found through the layout placeholder's type family; and a match renderers disagree on is counted `unknown-property`. A placeholder with no fill or autofit of its own now inherits both from its layout and master placeholder, and a slide's, notes slide's or layout's `p:clrMapOvr` replaces the master's colour map. A fill inherited only through a layout placeholder's `p:style` `fillRef`, and a typed placeholder that matches several layout placeholders of its type, count `unknown-property`, because renderers disagree. (#519, #520)
- b42161e: `ooxmlDisarm` no longer costs CPU quadratic in a pptx slide's run count when its layout's or master's `p:bg` is wide. The layout's and master's backgrounds are shared by every run on the slide and were re-evaluated once per run; they are now resolved once per slide part. A gradient background with more than 10 stops (any level: shape, table, slide, layout, master, or a docx text box) counts `unknown-property` rather than being tested against every run. (#522)
- 9aff2a5: `ooxmlDisarm` no longer costs CPU quadratic in a pptx slide's run count when a text-property level its runs share is wide. The paragraph's, shape's, layout placeholder's, master placeholder's, master `txStyles` and presentation `defaultTextStyle` levels, and an inherited placeholder's `p:spPr` fill, were re-evaluated once per run; each is now evaluated once per slide part. A gradient with more than 10 stops, wherever it is read (a text fill, a shape or placeholder fill, a background), counts `unknown-property` rather than having its stops resolved and tested against every run. (#524)
- 40fac56: Compile shared Word and Excel visibility inputs once per document and use exact indexed contrast queries, removing repeated style, shading, string, number-format and content-type work. Separate Word cascade identities so delimiter-containing style IDs cannot conceal a white run through a cache collision.
  
  Use fixed-domain persistent conditional colour sets to keep unions across distinct consumers bounded in memory and work. Separate PowerPoint placeholder type/index identities (a pre-existing sibling of ruling K), and treat inherited prototype names as unrecognised highlights and number-format colours.
- b729a82: Compile shared PowerPoint formatting once per document while resolving colours per slide, bound colour transforms to sixteen and gradients to ten stops, and cache shared relationships and slide visibility scans.
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

- 6071a3d: An OOXML disarm for untrusted office files (#433 S6), and the two core changes it needs.
  
  - **New `@hames-ai/connectors/document/ooxml-disarm.server`**: `ooxmlDisarm`, a `DocumentDisarm` for `flattenDocument`. It rebuilds a docx, docm, xlsx, xlsm, pptx or pptm as a fresh package, on core's bounded ZIP reader and writer, with no new dependency.
    - **Parts:** only those reached from the main part through an allowlisted relationship, and carrying that relationship's content type, are written: styles, numbering, footnotes and endnotes, shared strings, visible worksheets, visible slides and their notes, the theme. A sheet or slide is visible only through the list that names it. Everything else is dropped, including macros, ActiveX, OLE and embeddings, comments, customXml, customUI, the glossary, data connections, query tables, pivot caches, embedded fonts, external links, document properties, headers and footers. Every external relationship is dropped. The content types and every relationships part are written fresh.
    - **Markup compatibility first:** every kept part is reduced to what Word renders before any rule runs. Elements outside the namespaces the disarm understands are dropped with their content (`mc:Ignorable` wrappers, unknown or Strict namespaces, and VML), and each `mc:AlternateContent` keeps only the branch Word renders.
    - **Inside the kept parts**, matched by namespace URI: runs whose effective `vanish`, `specVanish` or `webHidden` is on, through direct formatting, character, paragraph and table styles, `basedOn` and docDefaults. A chain longer than 256, or one that loops, counts as hiding. Also dropped: shapes marked hidden; alt text; deletions, moves and deleted cells (insertions are kept); property revisions; field codes and `w:fldSimple` instructions; cell formulas and defined names; OLE and ActiveX elements; comment markers; references to dropped parts; footnotes and endnotes no kept reference points at; and every run but the separator mark in a separator-type note. Fields nested deeper than 256 are refused. Style resolution and field state cost linear time in the part.
    - **Counted, not dropped** — by the effective-visibility resolver of #492: hidden rows and columns, row heights under 1 and column widths under 0.5; a hidden workbook window; a number format that is only `;` once empty literals and `[…]` codes are gone, and a format's colour sections resolved against the cell's fill; a font, rich-text run or foreground colour that cannot contrast with its background (white, near-white, equal fills, gradients, transparency — through the full cascade of each format); text of 1 pt or less after any scale; shapes off the slide. The counted keys are the five reasons of #492 decision 3: `colour-contrast`, `too-small`, `hidden-flag`, `layout`, `unknown-property`.
  
      Anything counted makes `flattenDocument` report `hiddenContent: 'not-removed'`.
  
    - It throws a `DocumentRefusedError` (`unsupported-type`, `content-type`, `no-main-part`) or a `ZipRefusedError` rather than return a package it did not finish, so Sanitize becomes unavailable.
  - **`parseXml` holds a tree to `XML_LIMITS.maxTreeNodes`**, 650,000 elements, attributes and text nodes. That is twice the largest part in a corpus of vendor-shipped files, at about 0.75 KiB per node at the disarm's peak. Past it, `parseXml` refuses with the new `ZipRefusedError` code `xml-nodes`. `readZip`'s validation and `scanXml` build no tree and are not bounded by it.
  - **`flattenDocument` now covers docm and pptm**, beside the disarm that handles them. Without a disarm they report `hiddenContent: 'not-removed'`, as docx and xlsm do.
- 355994d: Side failures are now visible instead of silent (#420).
  
  - **New `warning` event** (`WarningEventData`, `WarningTask`): a side task — the conversation title, the post-turn result summaries, `compactIntent`'s rewrite, the retriever's query rewrite, `withReferences`' selection — failed and the turn ran on a fallback. It is always committed, rendered metadata-only into LLM-facing serializations, and is never read by `settleTurn`, `runChain`'s stop rule or `EventView.hasErrors()`, so a side failure cannot fail a turn or make the synthesizer apologise. `compactIntent`, the retriever's rewrite and `withReferences`' selector emit it where they used to emit an `error` (the selector's carried `kind: 'llm_call'`; the call record now rides the warning). **Breaking for exhaustive consumers**: `EventType` gains `'warning'`, so a `Record<EventType, …>` or an exhaustive `switch` over it stops compiling until it handles the new member.
  - **`withReferences`**: a selector that throws no longer skips the wrapped pattern; it runs with nothing attached, as `DEFAULT_ERROR_SEVERITY` already described.
  - **`compactBulkData`**: a batch that throws falls back per item (it used to skip the fallback), and a describe failure that leaves a result unsummarized records one `warning` per turn. **Breaking for describe implementations that relied on it**: the `DescribeFn` / `DescribeBatchFn` seam now treats a throw as the failure signal. `describeToolResultOp` and `describeToolResultsBatchOp` (`@hames-ai/harness-baml`) now **throw** on a failed call instead of returning `''` / an empty map.
  - **`runFirstTurnTitleGen`** (`@hames-ai/agents`) now **rejects** when the generation failed, instead of returning the same `null` as "nothing to name". `runRegenerateTitle` keeps its null-on-failure contract. `warningBubble` joins `errorBubble` in `replay`.
  - **Data Stash**: a failed ingest records its reason on the document as `ingestError` (cleared by the next run), and `IngestStatus` gains `'not_indexed'` for a copy stored in a format with no text to index. **Breaking for `GraphStashBridge` hosts** (`@hames-ai/connectors`): `ingest()` now resolves with how the run ended (`GraphStashIngestOutcome`), and `graph_file_ingest` waits up to `INGEST_OUTCOME_WAIT_MS` for it and returns `indexStatus` (`indexed` | `pending` | `failed` | `not_indexed`) plus `indexError`. A host whose `ingest()` still resolves `undefined` (plain JS, or a cast past the type) has every successful index reported as `failed` with "the index run reported no reason" — and the tool tells the model to pass that on — so update the bridge before upgrading.

### Patch Changes

- 2bb03a4: Agents are read-only against Neo4j (#403).
  
  `@hames-ai/harness-patterns`: `listTools()` no longer returns `write_neo4j_cypher`, including under a gateway prefix (`mcp__<server>__write_neo4j_cypher`) or a server namespace prefix (`<namespace>-write_neo4j_cypher`). `Tools()` and the BAML adapters' catalogs read through it. And `simpleLoop` and `actorCritic` refuse the tool in their allowlist check even when the allowlist you pass names it, or `dynamicToolAllowlist` / `dynamicToolPattern` would admit it; the refusal says the tool is withheld from every agent. So no agent's tool list, loop allowlist or planner catalog holds it. Like the management-tool filter, it is unconditional, and `listTools()` logs one warning per process when the gateway lists the tool. `callTool()` is unchanged: the list decides what an agent may call, not what the host may call by name. If an agent of yours wrote to Neo4j through this tool, it no longer can.
  
  `simpleLoop` now filters `fewShots` by the loop's allowlist before the controller sees them (#401): a shot whose `tool` the loop would refuse is dropped, and shots of `Return` and `expandPreviousResult` always stay. A model that copied a shot of a tool outside the allowlist used to end the loop on "Tool not allowed".
  
  `@hames-ai/agents`: new export `NEO4J_READ_ONLY_CONTEXT`, the controller context `search`, `retriever` and `general` now pass to the loops that reach Neo4j. It tells the controller the graph is read-only and to answer a request to change it instead of attempting one. `NEO4J_FEW_SHOTS_DEFAULT` is unchanged; its write example now reaches only a loop whose allowlist holds the write tool.
  
  `@hames-ai/connectors`: README only.
- 6df6a8b: Remove text taken from real conversations and a real tenant from shipped source. Comments in `general.server.ts`, `sandbox.server.ts`, `json-repair.ts` and `types.baml` no longer quote a user's request, a model's status line or a captured payload; they describe the case instead. In `@hames-ai/connectors`, the `graph_mail_attachments` tool's `person` description now gives a placeholder name as its example (`e.g. "Adele"`), and two comments use placeholder names and a placeholder attachment title. No behaviour changes.
- 7876c1a: README badges: npm version, CI, CodeQL, supported Node version and licence.
- 6b47a43: README: add banner
- 321ecb7: Effective-visibility resolver for the OOXML disarm (#492): one fail-closed computation per run replaces the per-property concealment counters for the colour, fill and size family.
  
  - Each run's effective foreground colour, background (shading, highlight, cell or shape fill, gradient stops), transparency and size resolve through its format's full cascade: docx docDefaults → table, paragraph and character styles → direct, with theme, tint and shade resolved to RGB and the paragraph, cell, row, table and page shading behind the run; pptx run → paragraph `a:pPr/a:defRPr` → the shape's list style at the paragraph's level → its layout's matching placeholder → its master's placeholder and `txStyles` → the presentation's `defaultTextStyle`, with the shape's fill (or its `p:style/a:fillRef` through the theme's fill scheme), the slide, layout and master backgrounds, and the master's colour map read for resolution; xlsx base style → conditional format, with indexed, theme and tint colours resolved to RGB and the number format's colour sections resolved against the cell's fill.
  - A run counts as concealed unless its text is provably visibly distinct: the foreground must contrast with every background colour by at least 1.4 (WCAG relative luminance — grey footnotes, coloured headings and mid-grey-on-pale-fill headers stay visibly distinct; white, near-white and pale greys do not), the size must be over 1 pt after `w:w` and autofit scales, and the fill must exist. Measured against a benign corpus of 183 distinct local Office files, the fail-closed additions over-flag 1.1% (white text over picture backgrounds, the z-order geometry of the filed #488 class).
  - The predicate is fail-closed: a rendering property outside the explicit allowlist, or a colour or fill mechanism the resolver cannot resolve, counts rather than reading as visible. The counted keys collapse to the five reasons `colour-contrast`, `too-small`, `hidden-flag`, `layout`, `unknown-property`, replacing `whiteText`, `fontMatchesFill`, `tinyText`, `hiddenRows`, `hiddenColumns`, `hiddenWindows`, `hiddenNumberFormats`, `zeroRowHeights`, `zeroColumnWidths` and `offSlideShapes`.
  - pptx slide layouts, slide masters and notes masters are read for style resolution and never emitted; the part allowlist is unchanged. A slide whose layout relationship points at a missing or mis-typed part counts `unknown-property` rather than silently dropping the inheritance layer.
  - Closes #486: a `w:w` character scale composes with the resolved size.
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
