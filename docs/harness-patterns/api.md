# Harness patterns API: moved to SPEC.md

This page used to be the API reference for the harness-patterns framework, from
before the framework moved into [`packages/harness-patterns/`](../../packages/harness-patterns/)
and was published as `@hames-ai/harness-patterns`. The reference now lives in the
package, next to the code it describes:
[`packages/harness-patterns/SPEC.md`](../../packages/harness-patterns/SPEC.md).

Where each part of this page went:

| This page's section                           | Now                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Types (`UnifiedContext`, `ContextEvent`, …)   | [SPEC.md: Core Types](../../packages/harness-patterns/SPEC.md#core-types) and [BAML Types](../../packages/harness-patterns/SPEC.md#baml-types)                                                                                                                                                                                                                                        |
| `simpleLoop`, `actorCritic`                   | [SPEC.md: simpleLoop](../../packages/harness-patterns/SPEC.md#simpleloopcontroller-tools-config), [actorCritic](../../packages/harness-patterns/SPEC.md#actorcriticactor-critic-tools-config)                                                                                                                                                                                         |
| `withReferences`                              | [SPEC.md: withReferences](../../packages/harness-patterns/SPEC.md#withreferencespattern-config); the design record is [`with-references.md`](./with-references.md)                                                                                                                                                                                                                    |
| `compactExecution`, `compactIntent`           | [SPEC.md: compactExecution](../../packages/harness-patterns/SPEC.md#compactexecutionconfig), [compactIntent](../../packages/harness-patterns/SPEC.md#compactintentconfig)                                                                                                                                                                                                             |
| `router`, `parallel`, `judge`, `chain`        | [router](../../packages/harness-patterns/SPEC.md#routerroutedescriptions-config), [routes](../../packages/harness-patterns/SPEC.md#routespatternmap-config), [parallel](../../packages/harness-patterns/SPEC.md#parallelpatterns), [judge](../../packages/harness-patterns/SPEC.md#judgeevaluator-config), [chain](../../packages/harness-patterns/SPEC.md#chainctx-patterns-onevent) |
| `configurePattern`, writing your own          | [GUIDE.md §2: Writing a pattern](../../packages/harness-patterns/GUIDE.md#2-writing-a-pattern)                                                                                                                                                                                                                                                                                        |
| `harness`, `resumeHarness`, `continueSession` | [harness](../../packages/harness-patterns/SPEC.md#harnesspatterns), [resumeHarness](../../packages/harness-patterns/SPEC.md#resumeharnessserialized-patterns-approved), [continueSession](../../packages/harness-patterns/SPEC.md#continuesessionserialized-patterns-newinput)                                                                                                        |
| `Tools`, `callTool`, `listTools`              | [SPEC.md: Tools()](../../packages/harness-patterns/SPEC.md#tools); transports in [GUIDE.md §3](../../packages/harness-patterns/GUIDE.md#3-tool-transports)                                                                                                                                                                                                                            |
| BAML adapters                                 | [`packages/harness-baml/README.md`](../../packages/harness-baml/README.md)                                                                                                                                                                                                                                                                                                            |
| EventView API                                 | [SPEC.md: EventView Query API](../../packages/harness-patterns/SPEC.md#eventview-query-api)                                                                                                                                                                                                                                                                                           |
| Configuration, pattern defaults               | [SPEC.md: Configuration System](../../packages/harness-patterns/SPEC.md#configuration-system)                                                                                                                                                                                                                                                                                         |
| Constants, loop round budgets                 | [SPEC.md: simpleLoop](../../packages/harness-patterns/SPEC.md#simpleloopcontroller-tools-config), "Round budgets"                                                                                                                                                                                                                                                                     |

## What changed since this page was written

If you learned the API from this page, four things work differently now:

- **`Tools()` needs a namespace map.** It takes `{ namespaces }`, a function from a
  tool name to its namespace (`web`, `neo4j`, …), and the argument is required, so
  a missing map fails to compile instead of silently leaving `tools.web` empty. The
  map for the MCP servers this repository runs ships as `mcpNamespace` in
  `@hames-ai/connectors/mcp-catalog`.
- **Controllers come from adapter factories, not from BAML functions.** A pattern
  takes a controller built by `createLoopControllerAdapter()`,
  `createActorControllerAdapter()` or `createCriticAdapter()` from
  `@hames-ai/harness-baml`. Passing a generated BAML function bound with
  `.bind(b)` does not type-check, because the generated functions take positional
  arguments. The seven per-domain factories this page listed
  (`createNeo4jController` and its siblings) no longer exist; the loop's tool list
  is its own second argument, and the adapter reads it from there.
- **Model-backed steps take their implementation as required config.**
  `compactExecution` needs `synthesize`, `router` needs `route`, and
  `withReferences` needs `selector`. The core package ships none of them;
  `bamlPatterns()` in `@hames-ai/harness-baml` returns the model-backed set.
- **Loop round budgets are runtime configuration.** The default for `maxTurns` is
  the runtime setting `maxToolTurns` (8), clamped to a bound, and a pattern's own
  `maxTurns` wins over it; the settings live in
  `@hames-ai/harness-patterns/runtime-config`.
