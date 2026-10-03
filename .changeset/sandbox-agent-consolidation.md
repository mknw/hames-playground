---
"@hames-ai/agents": minor
---

One sandbox agent instead of two. `sandboxAgent` (id `sandbox`, `agents/sandbox.server.ts`) replaces `sandboxSessionAgent` (`sandbox-session`) and `flavouredSandboxAgent` (`flavoured-sandbox`); both modules and both exports are removed. It keeps the flavoured agent's router, now over three routes: `basic`, the plain persistent box `sandbox-session` ran, keyed on the bare session id so it is the container a host's interactive shell attaches to; `data`; and `office`. The `image-processing` route is gone; the rootfs flavour itself is unchanged in `@hames-ai/sandbox`. A host that stored the old ids should map them to `sandbox`, as the reference app does.

`AgentDefinition` gains an optional `usesSandbox` flag, which `sandboxAgent` sets, so a host can tell which agents run in a sandbox without building them.
