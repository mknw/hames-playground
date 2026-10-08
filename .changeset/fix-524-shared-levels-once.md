---
"@hames-ai/connectors": patch
---

`ooxmlDisarm` no longer costs CPU quadratic in a pptx slide's run count when a text-property level its runs share is wide. The paragraph's, shape's, layout placeholder's, master placeholder's, master `txStyles` and presentation `defaultTextStyle` levels, and an inherited placeholder's `p:spPr` fill, were re-evaluated once per run; each is now evaluated once per slide part. A gradient with more than 10 stops, wherever it is read (a text fill, a shape or placeholder fill, a background), counts `unknown-property` rather than having its stops resolved and tested against every run. (#524)
