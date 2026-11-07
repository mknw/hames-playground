---
"@hames-ai/harness-patterns": minor
---

Context Manager compaction extended to every pattern (#1025): `groupControllerRuns` is replaced by the general `groupPatternRuns`, and the new `familyOf` / `sectionSummary` exports drive one collapsible section per pattern run in the observability timeline — the critic's evaluations, the summariser's batches, the router/decision steps, planner output, the guards' consecutive records, memory steps and the retriever's consecutive results each fold behind one collapsed header with a one-line summary and an error flag. A controller run still qualifies exactly as #1007 defined it, a lone event of any other family stays a timeline row, a guard's events never fold into the run they interrupted (they carry the wrapped pattern's id), and a marked `error` row always stays visible. Grouping is display-only: exports and the detail drill-down keep reading the raw events.
