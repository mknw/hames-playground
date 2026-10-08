---
"@hames-ai/connectors": patch
---

`ooxmlDisarm`'s pptx placeholder resolver (#517).

- **Linear lookup.** A run's layout and master placeholder used to be found by scanning every placeholder the part declares, so a slide of n runs over a layout of m distinct placeholders cost O(n·m) CPU: about 17 s for a 599 KB file at n = m = 32,000. Each style part is now indexed once when it is read, and each run is one lookup.
- **Concealment coverage.** A placeholder whose type is written in camelCase — `ctrTitle`, `subTitle`, `sldNum`, `clipArt`, `sldImg` — never matched its layout, master or notes-master placeholder by type, so text hidden through that inheritance (white at 1 pt, for example) was not counted and the document reported `hiddenContent: 'removed'`. Types now match whatever their case, and such text counts as `colour-contrast` and `too-small`. In the same class, a placeholder written with no `type` — ECMA-376's default `obj`, the stock content placeholder — now takes its master's `bodyStyle` rather than `otherStyle`, so text that `bodyStyle` hides counts too.
