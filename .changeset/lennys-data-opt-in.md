---
"@hames-ai/connectors": minor
"@hames-ai/agents": minor
"@hames-ai/harness-baml": patch
---

Opt-in support for a hosted third-party knowledge-archive MCP server (Lenny's Data, #986).

- `@hames-ai/connectors`: the MCP catalog maps the `lennys_` tool-name prefix to a new `lennys` namespace (`LENNYS_NAMESPACE`, `LENNYS_TOOL_PREFIX`). The host's transport discovers the names and pins them; the namespace is a fixed point of `inferServer`, so a guard can declare it.
- `@hames-ai/agents`: `general-next` offers `lennys` tools on its info route only when the host's catalog holds them. The info guard and the egress gate's address sources then declare the namespace, and the tools get web search's default egress detector pair, because each call carries free-text query text to a third party.
- `@hames-ai/harness-baml`: the adapters' process-wide tool-description cache re-reads, throttled, when a caller's allowlist holds a tool that a process transport owns but the cache lacks. A cache filled in another request's scope, or during that transport's outage, no longer hides the tool's description from the caller who holds it for the life of the process.
