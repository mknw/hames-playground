# Harness Pattern Examples

Catalog of 7 pre-built agents demonstrating pattern compositions.

> **Full Code:** See [`ui/src/lib/harness-client/examples/`](../../ui/src/lib/harness-client/examples/) for complete implementations.

---

## Agent Registry

All agents are registered in `registry.server.ts` and available via `getAgentList()`.

| ID | Name | Patterns | Servers |
|----|------|----------|---------|
| `default` | Default Agent | router → synthesizer | neo4j, web_search, fetch |
| `code-mode` | Code Mode Agent | router → actorCritic → synthesizer | all (via code-mode factory) |
| `multi-source-research` | Multi-Source Research | parallel → judge → synthesizer | web_search, github, context7 |
| `conversational-memory` | Conversational Memory | sessionTracker → router → memoryWriter → synthesizer | memory, neo4j, web_search, redis |
| `sandbox-session` | Sandbox · Session | compactIntent → withSandbox(actorCritic) → synthesizer | none (in-VM sandbox tools) |
| `retriever` | Retriever Agent | router → { retriever \| neo4j \| web_search } → synthesizer | neo4j, web_search, fetch (+ Data Stash via Redis retriever) |
| `flavoured-sandbox` | Sandbox · Flavoured (router) | router → withSandbox(actorCritic) per flavour (base / image-processing / data) → synthesizer | none (in-VM sandbox tools per flavour) |

---

## 1. Default Agent

**File:** `default.server.ts`

Router-based agent with Neo4j and Web Search routes. Each route is wrapped with `withReferences` so the inner pattern receives an LLM-curated set of relevant prior `tool_result` events from any earlier turn (subsumes #26 / #29 — see [`with-references.md`](with-references.md)).

```typescript
router({ neo4j: '...', web_search: '...' })
→ routes({
    neo4j:      withReferences(neo4jPattern, { scope: 'global' }),
    web_search: withReferences(webPattern,   { scope: 'global' })
  })
→ synthesizer({ mode: 'thread' })
```

- Neo4j queries (`read_neo4j_cypher`, `write_neo4j_cypher`, `get_neo4j_schema`)
- Web search via DuckDuckGo (`search`, `fetch`, `fetch_content`)
- Cross-turn data flow: `withReferences` selector attaches relevant prior refs at each route's ingress; the controller can use `expandPreviousResult` or pass `ref:<id>` in tool args to inline-expand the full data

For JS-orchestration workflows that span multiple servers, see [Agent 4 — Code Mode](#4-code-mode-agent).

---

## 2. Multi-Source Research

**File:** `multi-source-research.server.ts`

Concurrent search with quality ranking.

```
parallel([webSearch, githubSearch, docSearch])
judge(evaluator)  → score: content, relevance, authority
synthesizer({ mode: 'response' })
```

---

## 3. Conversational Memory

**File:** `conversational-memory.server.ts`

Memory scratchpad with KB distillation.

```
sessionTracker → hset/expire session metadata
router(neo4j | web_search)
memoryWriter   → persist key facts
synthesizer

+ hook(distillChain, { trigger: 'session_close', background: true })
  → read memory → distill → persist to neo4j → cleanup
```

---

## 4. Code Mode Agent

**File:** `code-mode.server.ts`

Orchestrate multiple MCP tools via JavaScript snippets executed server-side by the kg-agent gateway's `code-mode` tool family. The gateway's `code-mode` tool is a **factory** — its `args_schema` is `{name, servers}` and a successful call registers a new `code-mode-<name>` tool bound to those servers. The generated tool is what actually runs JS.

```typescript
router({ code_mode: 'Compose JS across multiple MCP tools…' })
→ routes({
    code_mode: chain(
      actorCritic(
        createActorControllerAdapter({
          toolNames: ['mcp-find', 'mcp-add', 'code-mode', 'mcp-exec'],
          dynamicPattern: /^code-mode-/,
          refreshOnCall: true,        // see newly-created tools across turns
        }),
        createCriticAdapter(),
        ['mcp-find', 'mcp-add', 'code-mode', 'mcp-exec'],
        {
          patternId: 'code-mode-loop',
          dynamicToolPattern: /^code-mode-/,   // allowlist for factory output
        }
      ),
      synthesizer({
        mode: 'thread',
        patternId: 'code-mode-synth',
        viewConfig: {
          // Final response built only from actor-side events; critic_result events
          // are filtered out so the critic's reasoning doesn't leak into the prompt.
          eventTypes: ['controller_action', 'tool_call', 'tool_result'],
        },
      })
    )
  })
```

- **Direct-response branch**: when `Router` returns `needs_tool: false`, the router sets `scope.data.response` to the conversational reply and `routes()` passes through — no synthesizer needed at the top level.
- **Cross-turn tool reuse**: `refreshOnCall: true` on the actor adapter forces a fresh `mcpListTools()` per invocation so `code-mode-<name>` tools created in earlier turns of the same session are still visible to the actor. `invalidateToolDescriptions()` is called from `actorCritic.server.ts` right after a successful `code-mode` execution, so the new tool appears in the next attempt's prompt.
- **actorCritic over simpleLoop**: the find → add → factory → call-generated-tool sequence has many ways to go wrong on the first try; actorCritic's retry-with-critic-feedback semantics fit better than simpleLoop's break-on-first-error.

---

## Creating Custom Agents

```typescript
// 1. Define pattern factory
async function createPatterns(): Promise<ConfiguredPattern<SessionData>[]> {
  const tools = await Tools()

  const myPattern = simpleLoop(
    createNeo4jController(tools.neo4j ?? []),
    tools.neo4j ?? [],
    { patternId: 'my-pattern' }
  )

  return [myPattern, synthesizer({ mode: 'thread' })]
}

// 2. Register agent
export const myAgent: AgentConfig = {
  id: 'my-agent',
  name: 'My Agent',
  description: 'Does something useful',
  icon: '🤖',
  servers: ['neo4j-cypher'],
  createPatterns
}

// 3. Add to registry.server.ts
registerAgent(myAgent)
```

---

**Last Updated:** 2026-07-23
