# Harness Patterns

A functional, composable framework for building agentic tool execution pipelines.

> **Full Documentation:** See [`ui/src/lib/harness-patterns/README.md`](../../ui/src/lib/harness-patterns/README.md) for complete API documentation, type definitions, and implementation details.

## Quick Navigation

| Document | Purpose |
|----------|---------|
| [API Reference](./api.md) | Types, patterns, tools, configuration |
| [Examples](./examples.md) | 6 agent implementations |
| [Frontend Integration](./frontend.md) | SolidStart server actions, components |

---

## Architecture Overview

```
BAML Functions ──┐
                 ├──► Patterns ──► Router ──► Harness ──► Agent
MCP Tools ───────┘
```

**Key Principle:** BAML functions are passed directly to patterns. No intermediate wrappers needed.

---

## Pattern Catalog

| Pattern | Purpose | Example Use |
|---------|---------|-------------|
| `simpleLoop` | ReAct decide-execute loop | Neo4j queries, web search |
| `actorCritic` | Generate-evaluate with retry | Code generation, file editing |
| `router` | Intent-based dispatch | Multi-capability agents |
| `synthesizer` | Response generation | Human-readable output |
| `compactIntent` | Rewrite latest message → self-contained `data.intent` | Router-less multi-turn agents ([#83](https://github.com/mknw/harness-playground/issues/83)) |
| `withReferences` | LLM-curated prior-result attachment at pattern ingress | Cross-pattern data flow ([#30](with-references.md)) |
| `parallel` | Concurrent execution | Multi-source search |
| `judge` | Quality ranking | Best-of-N selection |
| `guardrail` | Multi-layer validation | Input/output safety |
| `hook` | Lifecycle events | Session cleanup |
| `chain` | Sequential composition | Multi-stage pipelines |

> **Synthetic tool:** when prior results are present, simpleLoop's `LoopController` prompt also exposes `expandPreviousResult` — a virtual tool that loads the full data behind a `ref:<id>` and records it as a normal turn so subsequent iterations see it inline. See [`with-references.md`](with-references.md) for the full ingress/expansion taxonomy.

---

## Minimal Example

```typescript
import { harness, simpleLoop, synthesizer, Tools } from '~/lib/harness-patterns'
import { b } from '~/baml_client'

const tools = await Tools()

const agent = harness(
  simpleLoop(b.Neo4jController.bind(b), tools.neo4j ?? [], {
    patternId: 'neo4j-query'
  }),
  synthesizer({ mode: 'thread', patternId: 'response-synth' })
)

const result = await agent('Show me all Person nodes', 'session-123')
```

---

## Core Concepts

### UnifiedContext

Single source of truth for session state. Contains events, data, and status.

### PatternScope

Isolated workspace for pattern execution. Events are committed on completion.

### EventView

Fluent API for querying events from context:

```typescript
view.fromLastPattern().tools().last(3).get()
```

---

## Available Agents

6 pre-built agents in the registry:

1. **Default** - Router with Neo4j, Web, Code Mode
2. **Code Mode** - JS orchestration across MCP tools
3. **Multi-Source Research** - Parallel search + Judge
4. **Conversational Memory** - Scratchpad + KB distillation
5. **KG Builder** - Research → Extract → Persist
6. **Sandbox · Session** - Persistent VM workspace + xterm

See [examples.md](./examples.md) for details.

---

**Last Updated:** 2026-06-15
