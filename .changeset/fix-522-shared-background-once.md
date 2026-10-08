---
"@hames-ai/connectors": patch
---

`ooxmlDisarm` no longer costs CPU quadratic in a pptx slide's run count when its layout's or master's `p:bg` is wide. The layout's and master's backgrounds are shared by every run on the slide and were re-evaluated once per run; they are now resolved once per slide part. A gradient background with more than 10 stops (any level: shape, table, slide, layout, master, or a docx text box) counts `unknown-property` rather than being tested against every run. (#522)
