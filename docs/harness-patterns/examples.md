# Harness Pattern Examples

Catalog of 7 pre-built agents demonstrating pattern compositions.

> **Full Code:** See [`app/src/lib/harness-client/agents/`](../../app/src/lib/harness-client/agents/) for complete implementations.

---

## Agent Registry

All agents are registered in `registry.server.ts` and available via `getAgentList()`.

| ID | Name | Patterns | Servers |
|----|------|----------|---------|
| `search` | Search Agent | router → compactExecution | neo4j, web_search, fetch |
| `sandbox-session` | Sandbox · Session | compactIntent → withSandbox(actorCritic) → compactExecution | none (in-VM sandbox tools) |
| `retriever` | Retriever Agent | router → { retriever \| neo4j \| web_search } → compactExecution | neo4j, web_search, fetch (+ Data Stash via Redis retriever) |
| `flavoured-sandbox` | Sandbox · Flavoured (router) | router → withSandbox(actorCritic) per flavour (base / image-processing / data) → compactExecution | none (in-VM sandbox tools per flavour) |

---

## 1. Search Agent

**File:** `search.server.ts`

> Registered id `search`; it was `default` until PR #234.

Router-based agent with Neo4j and Web Search routes. Each route is wrapped with `withReferences` so the inner pattern receives an LLM-curated set of relevant prior `tool_result` events from any earlier turn (subsumes #26 / #29 — see [`with-references.md`](with-references.md)).

```typescript
router({ neo4j: '...', web_search: '...' })
→ routes({
    neo4j:      withReferences(neo4jPattern, { scope: 'global' }),
    web_search: withReferences(webPattern,   { scope: 'global' })
  })
→ compactExecution({ mode: 'thread' })
```

- Neo4j queries (`read_neo4j_cypher`, `write_neo4j_cypher`, `get_neo4j_schema`)
- Web search via DuckDuckGo (`search`, `fetch`, `fetch_content`)
- Cross-turn data flow: `withReferences` selector attaches relevant prior refs at each route's ingress; the controller can use `expandPreviousResult` or pass `ref:<id>` in tool args to inline-expand the full data

---

## 2. Multi-Source Research — **unregistered**

**File:** `multi-source-research.server.ts`

> **NOT LIVE TESTED.** Unregistered per owner decision 2026-08-23 (PR #234) —
> the file stays as a worked `parallel` example but is not in the registry, so
> it never appears in the agent dropdown. Re-register only after a live test.

Concurrent search with quality ranking.

```
parallel([webSearch, docSearch])
judge(evaluator)  → score: content, relevance, authority
compactExecution({ mode: 'response' })
```

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

  return [myPattern, compactExecution({ mode: 'thread' })]
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
