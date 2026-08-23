# Harness Pattern Examples

Example `actions.server.ts` configurations demonstrating pattern
compositions across all available MCP servers.

## Available Servers

| Server              | Namespace          | Capabilities                                                              |
| ------------------- | ------------------ | ------------------------------------------------------------------------- |
| neo4j-cypher        | `tools.neo4j`      | Graph queries, schema introspection, Cypher write                         |
| fetch               | `tools.web`        | HTTP content retrieval                                                    |
| web_search          | `tools.web`        | DuckDuckGo search + content parsing                                       |
| context7            | `tools.context7`   | Library doc resolution + retrieval                                        |
| rust-mcp-filesystem | `tools.filesystem` | File read/write/search/edit                                               |
| memory              | `tools.memory`     | Entity/relation knowledge graph (ephemeral)                               |
| redis               | `tools.redis`      | Key/value, hashes, lists, sets, sorted sets, streams, JSON, vector search |
| database-server     | `tools.database`   | PostgreSQL/MySQL/SQLite query + schema introspection                      |

## Pattern Catalog

### Existing Patterns

| Pattern            | Signature                         | Purpose                                                                                                                                                           |
| ------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `simpleLoop`       | `(controller, tools, config?)`    | ReAct decide-execute loop; turns may batch calls (`multiToolCalls`, default `'parallel'`)                                                                         |
| `actorCritic`      | `(actor, critic, tools, config?)` | Generate-evaluate with retry; attempts may batch calls too                                                                                                        |
| `withReferences`   | `(pattern, config?)`              | LLM-curated prior-result attachment at pattern ingress (cross-pattern data flow, [#30](../../../../docs/harness-patterns/with-references.md))                     |
| `compactExecution` | `(config)`                        | Transform tool results into natural language                                                                                                                      |
| `compactIntent`    | `(config?)`                       | Rewrite the latest message into a self-contained `data.intent` for a router-less actor ([#83](https://github.com/mknw/harness-playground/issues/83))              |
| `planner`          | `(tools, config?)`                | Upfront strategic decomposition → sets `data.plan`, injected into downstream controllers' `context` ([#27](https://github.com/mknw/harness-playground/issues/27)) |
| `router`           | `(routeDescriptions, config?)`    | Intent classification → sets `data.route`                                                                                                                         |
| `routes`           | `(patternMap, config?)`           | Dispatch to matched sub-pattern; pass-through on `'user'` route                                                                                                   |
| `chain`            | `(ctx, patterns)`                 | Sequential composition                                                                                                                                            |
| `harness`          | `(...patterns)`                   | Top-level agent entry point                                                                                                                                       |
| `parallel`         | `(...patterns)`                   | Execute multiple patterns concurrently, merge events with enter/exit markers                                                                                      |
| `guardrail`        | `(pattern, config)`               | Multi-layered validation: input rails, execution rails, output rails, circuit breakers                                                                            |
| `hook`             | `(pattern, config)`               | Side-effect pattern triggered by lifecycle events; supports background fire-and-forget                                                                            |

> **Synthetic tool:** simpleLoop's `LoopController` prompt also exposes `expandPreviousResult` when prior results are present — a virtual tool that loads the full data behind a `ref:<id>` and records it as a normal turn. See [`with-references.md`](../../../../docs/harness-patterns/with-references.md) for the ingress/expansion taxonomy.

> **Who writes the final answer ([#149](https://github.com/mknw/harness-playground/issues/149)):** every `simpleLoop` here inherits `returnStyle: 'summary'` — its terminal `Return` carries a one-line completion summary, and the chain's `compactExecution` composes the user-facing answer from the full tool results. No agent overrides it: every registered chain ends in a `compactExecution`, and `'answer'` would only restore a second composition nothing renders. Affected loops: `search` (both tool routes), `general`, `microsoft-365`, `retriever-agent` (both loop routes), and the unregistered `multi-source-research` (×3).

> **Multi-call modes across agents:** every agent inherits `multiToolCalls: 'parallel'` except the two that override it — `sandbox-session` and `flavoured-sandbox` → `'sequential'` (linear effect-chains on one VM filesystem; in-order batches still save actor round-trips).

---

## Examples

### 0. Title Generator — minimum-rung example

**Servers**: none (no MCP)
**Patterns**: `compactExecution({ mode: 'message', synthesize })`
**Use case**: Generate a 3-5 word conversation title from the user's first message.

The smallest legal harness composition — one pattern, one BAML call, ~20 LoC. Demonstrates that the library is appropriate for one-shot LLM jobs, not just multi-pattern agentic workflows. Used in production by `/api/events` post-stream to title new conversations as soon as the first response lands.

```typescript
// app/src/lib/harness-client/agents/title-generator.server.ts
export const titleAgent = harness<TitleAgentData>(
  compactExecution<TitleAgentData>({
    patternId: 'title-gen',
    mode: 'message',
    synthesize: async ({ userMessage }) => {
      const raw = await b.GenerateConversationTitle(userMessage)
      return sanitizeTitle(raw) ?? ''
    },
  }),
)
```

`mode: 'message'` makes the compactExecution a thin shell around the custom `synthesize` fn — it pulls the latest `user_message` from the view and hands it to the function as `input.userMessage`. No router, no tools, no loop.

---

### 0b. General Agent — plan first, then execute (`general.server.ts`)

**Servers**: everything in `tools.all`
**Patterns**: `planner` → `simpleLoop` → `compactExecution`
**Use case**: cross-namespace questions the router-based `search` agent cannot
serve, because a route can only be one namespace.

```typescript
// app/src/lib/harness-client/agents/general.server.ts
return [
  planner<SessionData>(tools.all, { patternId: 'plan', schema }),
  simpleLoop<SessionData>(createLoopControllerAdapter(tools.all), tools.all, {
    patternId: 'execute',
    schema,
    maxTurns: 8,
  }),
  compactExecution<SessionData>({ mode: 'thread', patternId: 'response-synth' }),
]
```

The planner sees exactly the tool surface the executor will have, emits a
numbered plan, and the loop receives it as the controller's `plan_context` —
rendered beside the intent, outside the agent-static cached prefix — so the
controller stops re-deriving the approach on every turn. Registered
alongside `search` on purpose: same session shape, different strategy, so the
two can be A/B'd on the same question.

---

### 1. Multi-Source Research (parallel) — **unregistered**

> **NOT LIVE TESTED.** Unregistered per owner decision 2026-08-23 (PR #234): the
> source file stays here as a worked `parallel` example, but `registry.server.ts`
> does not import it, so it never reaches the agent dropdown. Re-register only
> after a live test.

**Servers**: web_search, context7, redis
**Patterns**: `parallel` → `judge` → `compactExecution`
**Use case**: Search two sources concurrently, cache in redis, rank results.

```
User: "What's the best way to handle auth in SvelteKit?"

parallel:
  ├─ simpleLoop(webController, tools.web)          → DuckDuckGo results
  └─ simpleLoop(context7Controller, tools.context7) → SvelteKit official docs

redis: cache each source's results as JSON with TTL
  → json_set("research:{hash}", "$", results)
  → expire("research:{hash}", 3600)

judge(b.JudgeController):
  → Scores each source on: accuracy, recency, authority
  → Returns ranked list

compactExecution({ mode: 'response' })
  → Presents top-ranked answer with source attribution
```

```typescript
function parallel<T>(...patterns: ConfiguredPattern<T>[]): ConfiguredPattern<T> {
  const resolved = resolveConfig('parallel', { patternId: 'parallel' })
  return {
    name: 'parallel',
    fn: async (scope, view) => {
      return tracer.startActiveSpan('pattern.parallel', async (span) => {
        span.setAttribute('branchCount', patterns.length)
        // Each branch gets an isolated scope with empty events
        const results = await Promise.allSettled(
          patterns.map((p) =>
            p.fn({ ...scope, id: p.name, events: [], startTime: Date.now() }, view),
          ),
        )
        // Merge fulfilled events; log rejected branches
        for (const [i, r] of results.entries()) {
          if (r.status === 'fulfilled') {
            scope.events.push(...r.value.events)
            scope.data = { ...scope.data, ...r.value.data }
          } else {
            trackEvent(
              scope,
              'error',
              {
                error: `Branch ${patterns[i].name} failed: ${r.reason}`,
              },
              true,
            )
          }
        }
        span.setStatus({ code: SpanStatusCode.OK })
        span.end()
        return scope
      })
    },
    config: resolved,
  }
}

// Cache layer: wrap each source to persist results in redis
function withCache<T>(
  pattern: ConfiguredPattern<T>,
  ttlSeconds: number = 3600,
): ConfiguredPattern<T> {
  return {
    ...pattern,
    fn: async (scope, view) => {
      const cacheKey = `research:${pattern.name}:${hashInput(scope.data.input)}`
      // Check redis cache first
      const cached = await callTool('json_get', { key: cacheKey, path: '$' })
      if (cached.success && cached.data) {
        trackEvent(
          scope,
          'tool_result',
          {
            tool: 'cache_hit',
            result: cached.data,
            success: true,
          },
          true,
        )
        return scope
      }
      const result = await pattern.fn(scope, view)
      // Store in redis with TTL
      const lastResult = result.events.filter((e) => e.type === 'tool_result').pop()
      if (lastResult) {
        await callTool('json_set', {
          key: cacheKey,
          path: '$',
          value: JSON.stringify(lastResult.data),
        })
        await callTool('expire', { key: cacheKey, seconds: ttlSeconds })
      }
      return result
    },
    config: pattern.config,
  }
}

// Usage
const researchPattern = parallel(
  withCache(
    simpleLoop(b.WebSearchController.bind(b), tools.web ?? [], { patternId: 'web-search' }),
  ),
  withCache(
    simpleLoop(b.Context7Controller.bind(b), tools.context7 ?? [], { patternId: 'doc-lookup' }),
  ),
)

const evaluator = judge(b.JudgeController.bind(b), { patternId: 'quality-judge' })

return [
  researchPattern,
  evaluator,
  compactExecution({ mode: 'response', patternId: 'research-synth' }),
]
```

---

### 2. Conversational Memory with KB Distillation (memory + neo4j + redis)

**Servers**: memory (short-term), neo4j (long-term KB), redis (session state + vector)
**Patterns**: Main loop + `hook` pattern on session close
**Use case**: Memory as conversational scratchpad; neo4j as persistent KB.
On session close, a background hook distills useful facts from memory into the KB.

#### Architecture

```
                       ┌──────────────────────────┐
  User message ──────► │  Router (normal flow)     │
                       │  → neo4j / web / code      │
                       └────────┬─────────────────┘
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
            ┌──────────────┐       ┌──────────────┐
            │ memory       │       │ redis        │
            │ (scratchpad) │       │ (session)    │
            │              │       │              │
            │ Stores:      │       │ Stores:      │
            │ • user prefs │       │ • turn count │
            │ • key facts  │       │ • embeddings │
            │ • corrections│       │ • TTL state  │
            └──────┬───────┘       └──────────────┘
                   │
                   │  on session.close
                   ▼
            ┌──────────────────────────────────────┐
            │  Distillation Hook (background)       │
            │                                       │
            │  1. read_graph() from memory           │
            │  2. BAML DistillController:             │
            │     → filter noise, extract durable     │
            │       facts, user corrections, prefs    │
            │  3. write_neo4j_cypher:                 │
            │     → MERGE nodes, relationships        │
            │     → SET properties with provenance    │
            │  4. delete transient memory entities    │
            └──────────────────────────────────────┘
```

#### Session flow

```typescript
// --- Main conversation agent ---

// Memory controller writes to memory MCP during conversation
const memoryWriter = simpleLoop(b.MemoryWriter.bind(b), tools.memory ?? [], {
  patternId: 'memory-write',
  // Runs after each router result to capture key facts
  viewConfig: { fromLast: true, eventTypes: ['tool_result'] },
})

// Redis tracks session metadata (turn count, timestamps, topic drift)
const sessionTracker: ConfiguredPattern<SessionData> = {
  name: 'session-tracker',
  fn: async (scope, _view) => {
    const sessionKey = `session:${scope.data.sessionId}`
    await callTool('hset', { key: sessionKey, field: 'lastTurn', value: Date.now().toString() })
    await callTool('hset', {
      key: sessionKey,
      field: 'turnCount',
      value: String((scope.data.turnCount ?? 0) + 1),
    })
    await callTool('expire', { key: sessionKey, seconds: 7200 }) // 2hr TTL
    scope.data = { ...scope.data, turnCount: (scope.data.turnCount ?? 0) + 1 }
    return scope
  },
  config: resolveConfig('session-tracker', { patternId: 'session-tracker' }),
}

// Router classifies intent; routes dispatches to domain patterns (neo4j, web)
const routerPattern = router(routeDescriptions)
const routesPattern = routes(domainPatterns)

// Compose: track → route → dispatch → memorize → synthesize
return [sessionTracker, routerPattern, routesPattern, memoryWriter, responseSynth]
```

#### Session close hook (distillation)

```typescript
// --- hook pattern: triggered by lifecycle events ---

interface HookConfig<T> extends PatternConfig {
  trigger: 'session_close' | 'error' | 'approval_timeout' | 'custom'
  background?: boolean // Run async, don't block response
}

function hook<T>(pattern: ConfiguredPattern<T>, config: HookConfig<T>): ConfiguredPattern<T> {
  const resolved = resolveConfig('hook', config)
  return {
    name: `hook:${config.trigger}(${pattern.name})`,
    fn: async (scope, view) => {
      // Hook runs the wrapped pattern but doesn't block the main chain
      if (config.background) {
        // Fire-and-forget: schedule for execution after response
        queueMicrotask(async () => {
          try {
            await pattern.fn(scope, view)
          } catch (e) {
            console.error(`Hook ${config.trigger} failed:`, e)
          }
        })
        return scope
      }
      return pattern.fn(scope, view)
    },
    config: resolved,
  }
}

// --- Distillation workflow ---

async function createDistillationHook(schema: string): Promise<ConfiguredPattern<SessionData>> {
  // Step 1: Read all memory entities from this session
  const readMemory = simpleLoop(b.MemoryReadController.bind(b), tools.memory ?? [], {
    patternId: 'distill-read',
    maxTurns: 2,
  })

  // Step 2: BAML distill — filter noise, extract durable facts
  const distill: ConfiguredPattern<SessionData> = {
    name: 'distill-extract',
    fn: async (scope, view) => {
      const memoryEvents = view.fromPattern('distill-read').ofType('tool_result').get()
      const distilled = await b.DistillController(
        JSON.stringify(memoryEvents.map((e) => e.data)),
        scope.data.sessionId ?? 'unknown',
      )
      scope.data = {
        ...scope.data,
        distilledFacts: distilled.facts,
        distilledRelations: distilled.relations,
      }
      return scope
    },
    config: resolveConfig('distill-extract', { patternId: 'distill-extract' }),
  }

  // Step 3: Write to neo4j KB
  const persistToKB = simpleLoop(b.Neo4jController.bind(b), tools.neo4j ?? [], {
    patternId: 'distill-persist',
    schema,
  })

  // Step 4: Cleanup transient memory
  const cleanupMemory = simpleLoop(b.MemoryCleanupController.bind(b), tools.memory ?? [], {
    patternId: 'distill-cleanup',
  })

  // Wrap in chain as a single hook
  const distillChain: ConfiguredPattern<SessionData> = {
    name: 'distill-chain',
    fn: async (scope, view) => {
      // Sequential: read → extract → persist → cleanup
      for (const p of [readMemory, distill, persistToKB, cleanupMemory]) {
        const result = await p.fn(scope, view)
        scope.events.push(...result.events)
        scope.data = { ...scope.data, ...result.data }
      }
      return scope
    },
    config: resolveConfig('distill-chain', { patternId: 'distill-chain' }),
  }

  return hook(distillChain, {
    patternId: 'session-close-hook',
    trigger: 'session_close',
    background: true,
  })
}

// --- Server action for session close ---
export async function closeSession(sessionId: string): Promise<void> {
  const session = getSession(sessionId)
  if (!session?.serializedContext) return

  const schema = await getSchema()
  const distillHook = await createDistillationHook(schema)

  // Run distillation on the final session context
  const ctx = deserializeContext(session.serializedContext)
  const scope = createScope('distill', ctx.data)
  const view = createEventView(ctx)
  await distillHook.fn(scope, view)

  deleteSession(sessionId)
}
```

---

### 3. Sandbox · Session (`withSandbox({ id })` persistent + xterm)

**Servers**: none (in-VM `sandbox_*` tools via the ALS scope, not the gateway)
**Patterns**: `[compactIntent, withSandbox({ id: sessionId, syncWorkspace: true })(actorCritic), synth]`
**Use case**: A persistent workspace shared with the **interactive Shell
terminal** in the Terminal panel. Agent writes a file → user can `cat` it in
the Shell; same VM. The `id` keys the attachment to the conversation in
`AttachmentTable`; the `PtyManager` keys on the same `sessionId`.

With `syncWorkspace: true` ([#89](https://github.com/mknw/harness-playground/issues/89))
the workspace is **durable across sessions**, not just turns: stored documents
are restored into `/work/in` on first boot and `/work/out` deliverables are
promoted to the DataStash each turn — so an uploaded spreadsheet survives idle
eviction, restart, and next-day reconnects. The layout contract + mechanism
live in [`docs/plan/sandbox.md → Durable workspaces`](../../../../docs/plan/sandbox.md#durable-workspaces-89).

Composes any actor-style pattern with id-addressable attachment. Because this
agent is **router-less**, `compactIntent` runs first ([#83](https://github.com/mknw/harness-playground/issues/83)
Part A) to rewrite bare follow-ups (_"I can't find the file"_) into a
self-contained `data.intent` the actor can act on — turn 1 passes through
unchanged. The actor also carries two `tool_args` few-shots
([#85](https://github.com/mknw/harness-playground/issues/85)) so multi-line
`sandbox_write` / quoted `sandbox_bash` calls emit valid JSON on the first try.

See `sandbox-session.server.ts`. Debugging modalities for live sandboxes:
[`docs/sandbox/README.md`](../../../../docs/sandbox/README.md).

---

## Pattern Composition Matrix

|                 | neo4j            | fetch         | web_search   | context7     | filesystem       | memory          | redis        | database         |
| --------------- | ---------------- | ------------- | ------------ | ------------ | ---------------- | --------------- | ------------ | ---------------- |
| **simpleLoop**  | Query/write      | Fetch URLs    | Search       | Resolve docs | Read/search      | Entity CRUD     | Get/set/hash | SQL query        |
| **actorCritic** | Complex queries  | -             | -            | -            | File refactoring | -               | -            | Schema migration |
| **parallel**    | Multi-query      | Multi-fetch   | Multi-search | Multi-lib    | Multi-file       | -               | -            | Multi-DB         |
| **guardrail**   | Cypher injection | URL allowlist | Topic scope  | -            | Path safety      | -               | Rate limit   | SQL injection    |
| **judge**       | -                | -             | Rank results | Rank docs    | -                | -               | Score cache  | -                |
| **hook**        | KB distill       | -             | -            | -            | Log to file      | Session cleanup | TTL mgmt     | Audit log        |

## BAML Functions Needed

| BAML Function                                           | Pattern                | Servers Used                  |
| ------------------------------------------------------- | ---------------------- | ----------------------------- |
| `Context7Controller`                                    | simpleLoop             | context7                      |
| `MemoryController` / `MemoryWriter`                     | simpleLoop             | memory                        |
| `MemoryReadController` / `MemoryCleanupController`      | simpleLoop (hook)      | memory                        |
| `MemoryExtractController`                               | simpleLoop             | memory                        |
| `DistillController`                                     | custom (hook)          | memory → neo4j                |
| `FileEditController` / `FileEditCritic`                 | actorCritic            | rust-mcp-filesystem           |
| `JudgeController`                                       | judge                  | (evaluator, no tools)         |
| `TopicClassifier`                                       | guardrail (input rail) | (classifier, no tools)        |
| `OntologyScopingController`                             | simpleLoop             | memory                        |
| `OntologyProposalController`                            | custom (proposal loop) | memory                        |
| `OntologyJudge`                                         | custom (judge in loop) | (evaluator, no tools)         |
| `Neo4jOntologyCommitController`                         | simpleLoop             | neo4j                         |
| `OntologyDocController` / `OntologyDocCritic`           | actorCritic            | rust-mcp-filesystem           |
| `OntologyAnalysisController` / `OntologyAnalysisCritic` | actorCritic            | neo4j + filesystem + database |
| `EmbedQuery`                                            | custom (cache)         | (embedding, no tools)         |
| `Neo4jController`                                       | simpleLoop             | neo4j-cypher (existing)       |
| `WebSearchController`                                   | simpleLoop             | web_search (existing)         |
