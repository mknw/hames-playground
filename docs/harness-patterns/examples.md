# Example agents: moved to the agents package

This page used to catalog the example agents and show how to create one, from
before the agents moved into [`packages/agents/`](../../packages/agents/) and were
published as `@hames-ai/agents`. The catalog, the definition an agent exports and
how a host registers it are now in the package's README:
[`packages/agents/README.md`](../../packages/agents/README.md).

## Which agent to read for which pattern

Each agent is one source file, and each is a working composition of the patterns in
`@hames-ai/harness-patterns`. To see a pattern used in context, open the agent that
uses it:

| To see                                                        | Read                                                                                                                 |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `router` and `routes`, `withReferences`, `withInjectionGuard` | [`search.server.ts`](../../packages/agents/agents/search.server.ts), agent `search`                                  |
| `retriever` routed beside tool loops                          | [`retriever-agent.server.ts`](../../packages/agents/agents/retriever-agent.server.ts), agent `retriever`             |
| `planner` ahead of a loop over every tool                     | [`general.server.ts`](../../packages/agents/agents/general.server.ts), agent `general`                               |
| A loop over an explicit tool list, fully guarded              | [`microsoft-365.server.ts`](../../packages/agents/agents/microsoft-365.server.ts), agent `microsoft-365`             |
| `compactIntent` and `actorCritic` inside a sandbox            | [`sandbox-session.server.ts`](../../packages/agents/agents/sandbox-session.server.ts), agent `sandbox-session`       |
| `router` choosing between sandbox flavours                    | [`flavoured-sandbox.server.ts`](../../packages/agents/agents/flavoured-sandbox.server.ts), agent `flavoured-sandbox` |

Every one of them ends with `compactExecution`, the pattern that writes the answer
the user sees. None composes `parallel` or `judge`; [`parallel.md`](./parallel.md)
shows those two together.

Two things this page taught have changed. A new agent exports an `AgentDefinition`
(id, name, description, welcome text, servers and a `createPatterns(sessionId, deps)`
factory), with no icon: presentation is added by the host when it registers the
agent. And a loop's controller comes from `createLoopControllerAdapter()` in
`@hames-ai/harness-baml`; the per-domain factories this page used, such as
`createNeo4jController`, no longer exist.
