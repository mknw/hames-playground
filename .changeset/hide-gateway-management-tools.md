---
"@hames-ai/harness-patterns": patch
---

`listTools()` no longer returns the Docker MCP gateway's own management tools: `mcp-find`, `mcp-add`, `mcp-remove`, `mcp-exec`, `mcp-config-set`, `code-mode` and the other tools of its `dynamic-tools` feature. `Tools()` and the BAML adapters' catalogs read through it, so no agent is offered them. If the gateway lists them anyway, `listTools()` logs one warning per process.
