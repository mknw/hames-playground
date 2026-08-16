# ADR-0004: `.server.ts` + `assertServerOnImport()` is the server/client boundary

**Date**: 2025-12-18 — the date the decision was taken
**Status**: accepted

The harness runs BAML calls, MCP tool execution and provider API keys, none of
which may ever reach a browser bundle; SolidStart's `"use server"` directive was
rejected for the framework layer because harness-patterns is a standalone module
that must be importable outside a route. The convention is instead a naming rule
plus a runtime assertion: a module whose name ends in `.server.ts` is server-only
and calls `assertServerOnImport()` at top level, which throws `ServerOnlyError`
the moment `typeof window !== 'undefined'`. Client-safe declarations live in
un-suffixed files (`types.ts`), and `assert.server.ts` self-enforces by calling
its own assertion at module scope.

## Considered options

- **`"use server"` directives.** Rejected: they bind the module to the framework's
  RPC transport, and the harness is deliberately a standalone library the routes
  call into rather than a set of exported server actions.
- **Convention alone, no runtime check.** Rejected: a naming convention fails
  silently. The whole value of the assertion is that a mistaken client import
  throws at import time, in development, instead of shipping a key in a bundle.
- **Bundler-level enforcement only.** Rejected as insufficient on its own — it
  covers the build but not a dev-server import path, and it would move the rule
  into config, out of sight of the file it governs.

## Consequences

- The suffix is load-bearing, not decorative: renaming a `.server.ts` file to
  drop the suffix removes a security boundary. `assertServerOnImport()` must be
  called at module top level, not inside a function, or the check never fires on
  import.
- Anything a client component needs — types, pure helpers — has to be factored
  out of the server module rather than imported from it, which is a real design
  constraint on the framework's shape.
- The rule generalises beyond harness-patterns and is now applied across
  `ui/src/lib/`; `action-runner.server.ts`, for instance, is deliberately **not**
  `"use server"` because it takes a `userId` and exposing it as a client RPC
  would let a caller run as any user.

## Sources

Back-filled. Rationale mined from commit `fc1ecaf` (2025-12-18,
`docs(harness-patterns): Add architectural plan for server-side agent harness`),
whose Design Principles §1 "Server-Only Execution" states the suffix rule, the
`assertServer` sketch and the explicit "no `"use server"` directives (standalone
module)" choice; and commit `34b7b01` (same day), which landed
`assert.server.ts`. The implementation is unchanged today at
`ui/src/lib/harness-patterns/assert.server.ts`. The standing disposition is the
"Server/client boundary" bullet in `CLAUDE.md`.
