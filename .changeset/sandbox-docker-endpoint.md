---
"@hames-ai/sandbox": minor
---

Add an optional sandbox Docker endpoint shared by container operations, MCP
streams, the reaper, proxy/network lifecycle and interactive shells. Explicit
Unix endpoints override inherited Docker routing; TCP endpoints require verified
TLS with explicit CA, client certificate and key paths. With no settings, preserve
existing Docker CLI arguments and environment inheritance.
