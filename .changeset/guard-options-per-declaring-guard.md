---
"@hames-ai/harness-patterns": minor
"@hames-ai/agents": minor
---

**Breaking (pre-1.0, so a minor bump): nested `withInjectionGuard`s no longer merge their options.** A tool is now sanitized with the options of the innermost guard that declares it, and a guard that does not declare a tool hands it to the enclosing guard, which applies its own. Coverage still unions: an inner guard can never un-guard a namespace or tool an outer guard declared.

- Removed: the `strictestSpotlight` export, and the merge of `disableRules` (was an intersection), `rules` (was a union), `spotlight` (was the strictest), `screen` (was inherited) and `screenDespiteFindings` (was an OR) across nested guards.
- `ActiveInjectionGuard.options` is replaced by `optionsFor(tool)`, the options that govern that tool. A hand-built `ActiveInjectionGuard` needs the new member.
- Migration: an option you relied on an enclosing guard to supply (a `screen`, `spotlight: 'always'`, an extra rule) is now declared on each guard whose tools should have it. An inner `disableRules` or weaker `spotlight` no longer reaches the outer guard's tools, so nothing needs removing for that direction.
- `general-next` declares its route guards' options itself: `spotlight: 'always'` on all three, the screen (with `screenDespiteFindings`) on the office and info guards, none on the documents guard. The orchestrator guard keeps the fence and loses its screen, so a retriever hit and a route-output record are no longer model-screened; every other guarded tool result is screened as before.
