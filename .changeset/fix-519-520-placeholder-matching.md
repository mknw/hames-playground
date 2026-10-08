---
"@hames-ai/connectors": patch
---

`ooxmlDisarm` no longer reports hidden pptx placeholder text as removed when it is inherited through a route the resolver did not read. A slide placeholder now matches its layout placeholder by exact type and idx first, with ECMA-376's defaults (`type` obj, `idx` 0) and unsignedInt idx spellings; a level the matched placeholder lacks goes up to the master rather than to a sibling; the master placeholder is found through the layout placeholder's type family; and a match renderers disagree on is counted `unknown-property`. A placeholder with no fill or autofit of its own now inherits both from its layout and master placeholder, and a slide's, notes slide's or layout's `p:clrMapOvr` replaces the master's colour map. (#519, #520)
