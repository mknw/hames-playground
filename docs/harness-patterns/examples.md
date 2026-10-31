# Example agents: moved to the agents package

This page used to catalog the example agents and show how to create one, from
before the agents moved into [`packages/agents/`](../../packages/agents/) and were
published as `@hames-ai/agents`. The catalog, the definition an agent exports and
how a host registers it are now in the package's README:
[`packages/agents/README.md`](../../packages/agents/README.md).

## Which source to read

`general-next` is the sole shipped agent definition. Its
[`general-next.server.ts`](../../packages/agents/agents/general-next.server.ts)
composition shows a decision loop, office `actorCritic`, Neo4j and web loops,
document retrieval, planning, route guards and final `compactExecution`.
For standalone `parallel` and `judge` examples, see [`parallel.md`](./parallel.md).

Two things this page taught have changed. A new agent exports an `AgentDefinition`
(id, name, description, welcome text, servers and a `createPatterns(sessionId, deps)`
factory), with no icon: presentation is added by the host when it registers the
agent. And a loop's controller comes from `createLoopControllerAdapter()` in
`@hames-ai/harness-baml`; the per-domain factories this page used, such as
`createNeo4jController`, no longer exist.
