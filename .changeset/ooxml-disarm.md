---
"@hames-ai/connectors": minor
"@hames-ai/harness-patterns": minor
---

An OOXML disarm for untrusted office files (#433 S6), and the two core changes it needs.

- **New `@hames-ai/connectors/document/ooxml-disarm.server`**: `ooxmlDisarm`, a `DocumentDisarm` for `flattenDocument`. It rebuilds a docx, docm, xlsx, xlsm, pptx or pptm as a fresh package, on core's bounded ZIP reader and writer, with no new dependency.
  - **Parts:** only those reached from the main part through an allowlisted relationship, and carrying that relationship's content type, are written: styles, numbering, footnotes and endnotes, shared strings, visible worksheets, visible slides and their notes, the theme. Everything else is dropped, including macros, ActiveX, OLE and embeddings, comments, customXml, customUI, the glossary, data connections, query tables, pivot caches, embedded fonts, external links, document properties, headers and footers. Every external relationship is dropped. The content types and every relationships part are written fresh.
  - **Inside the kept parts**, matched by namespace URI and applied inside `mc:Choice` and `mc:Fallback`: runs whose effective `vanish`, `specVanish` or `webHidden` is on (through direct formatting, character, paragraph and table styles, `basedOn` and docDefaults); shapes marked hidden; alt text; deletions and moves (insertions are kept); property revisions; field codes and `w:fldSimple` instructions; cell formulas and defined names; OLE and ActiveX elements; comment markers; references to dropped parts; footnotes and endnotes no kept reference points at. A hiding rule in one `mc:AlternateContent` branch drops the whole element.
  - **Counted, not dropped:** hidden rows and columns, zero heights and widths, the `;;;` number format, a font colour equal to its fill, white text, text of 1 pt or less, and shapes off the slide. Anything counted makes `flattenDocument` report `hiddenContent: 'not-removed'`.
  - It throws a `DocumentRefusedError` (`unsupported-type`, `content-type`, `no-main-part`) or a `ZipRefusedError` rather than return a package it did not finish, so Sanitize becomes unavailable.
- **`parseXml` holds a tree to `XML_LIMITS.maxTreeNodes` (1,000,000 elements, attributes and text nodes)**, refusing past it with the new `ZipRefusedError` code `xml-nodes`. `readZip`'s validation and `scanXml` build no tree and are not bounded by it.
- **`flattenDocument` now covers docm and pptm**, beside the disarm that handles them. Without a disarm they report `hiddenContent: 'not-removed'`, as docx and xlsm do.
