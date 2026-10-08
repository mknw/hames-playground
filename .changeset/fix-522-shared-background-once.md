---
"@hames-ai/connectors": patch
---

`ooxmlDisarm` no longer costs CPU quadratic in a pptx slide's run count when its layout or master carries a wide background. The layout's and master's backgrounds are shared by every run on the slide and were re-evaluated once per run; they are now resolved once per slide part. A layout or master gradient background with more than 10 stops counts `unknown-property` rather than being tested against every run. (#522)
