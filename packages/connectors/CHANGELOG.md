# @hames-ai/connectors

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
