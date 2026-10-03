---
"@hames-ai/harness-patterns": patch
---

`listTools()` no longer returns the Docker MCP gateway's own management tools: `mcp-find`, `mcp-add`, `mcp-remove`, `mcp-exec`, `mcp-config-set`, `code-mode`, `code-mode-<name>` and the other tools of its `dynamic-tools` feature. `Tools()` and the BAML adapters' catalogs read through it, so no agent is offered them.

The filter is unconditional and cannot be turned off. It exists because the gateway's own default is dynamic tools ON: a gateway whose Docker CLI config does not set `features."dynamic-tools"` to `"disabled"` lists these tools. If you call `code-mode` or `mcp-find` through this package today, you lose them with this release. When the gateway lists them anyway, `listTools()` logs one warning per process.
