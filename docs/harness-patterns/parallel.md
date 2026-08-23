# Parallel Execution Patterns

Options for concurrent pattern execution in the harness framework.

---

## Current Implementation: Promise.allSettled

The `parallel` pattern uses `Promise.allSettled` for independent concurrent execution:

```typescript
parallel([pattern1, pattern2, pattern3], { patternId: 'concurrent-search' })
```

**Behavior:**
- Each pattern gets an isolated scope with empty events
- Results merged on completion (both fulfilled and rejected)
- Data from all branches merged into parent scope
- Errors logged but don't fail the overall pattern

**Use cases:**
- Multi-source search (web + docs + graph)
- Parallel data fetching
- Fan-out queries

---

## Future Options

### Streaming (Progressive Results)

```typescript
parallelStream(patterns, onChunk)
// Patterns emit via ctx.emit(), results streamed as available
```

**Use case:** UI updates, first-result optimization

### Event-Driven Coordination

```typescript
parallel(
  { searcher, critic, compactExecution },
  {
    on: {
      'searcher:RESULT': (d) => emit('critic:EVALUATE', d),
      'critic:APPROVED': (d) => emit('compactExecution:PRIME', d),
      'compactExecution:SUFFICIENT': () => controller.abort()
    }
  }
)
```

**Use case:** Multi-agent negotiation, conditional early exit

---

## Combining with Judge

Common pattern: parallel search + quality ranking

```typescript
const sources = parallel([
  simpleLoop(webController, tools.web, { patternId: 'web' }),
  simpleLoop(neo4jController, tools.neo4j, { patternId: 'graph' }),
  simpleLoop(docsController, tools.context7, { patternId: 'docs' })
])

const evaluator = judge(qualityEvaluator, { patternId: 'judge' })

return [sources, evaluator, compactExecution({ mode: 'response' })]
```

See [examples.md](./examples.md) for full implementations.

---

**Last Updated:** 2026-02-05
