/**
 * Retriever Agent
 *
 * Router-based agent that adds a fast, low-latency **retriever** route alongside
 * the Neo4j and Web Search loops of the default agent. The retriever does ONE
 * embedding + KNN over the session's ingested Data Stash uploads — seconds, not
 * the 30s+ a Neo4j `simpleLoop` can take — and hands matches-with-references to
 * the compactExecution.
 *
 * Harness-aware Data Stash: because this agent composes a `retriever` wired to
 * the **redis** (local-vector) backend, uploads to its sessions auto-ingest into
 * the local vector store (see `routes/api/stash/upload.ts` →
 * `harnessHasRedisRetriever`). An agent WITHOUT a redis retriever never triggers
 * ingest — the upload is just stored.
 *
 * Composition:
 *   router({ retriever | neo4j | web_search })
 *     → routes({
 *         retriever:  retriever({ backends:[redis], generateQuery: true }),
 *         neo4j:      simpleLoop(neo4j),
 *         web_search: simpleLoop(web),
 *       })
 *     → compactExecution('thread')
 *
 * The retriever searches with the user's **raw message** by default — the user's
 * own words embed better than a paraphrase. `generateQuery: true` rewrites the
 * query with a cheap `RetrieveQuery` call ONLY when the turn has history (to
 * resolve "more on that" / "those sections"); turn-1 messages search verbatim.
 *
 * The Supabase backend (company pgvector via the Supabase MCP) is a deferred
 * stub; add `createSupabaseBackend()` to `backends` once IT provides access.
 */
// @unocss-include — the icon class literal lives in the app's registry overlay
// (see the host's harness-client/registry.server.ts), not here: `icon`/`accent`
// are UI fields and stay app-side (the #225 composition-root decision).
import {
  router,
  routes,
  simpleLoop,
  retriever,
  compactExecution,
  withReferences,
  withInjectionGuard,
  Tools,
  type ConfiguredPattern,
} from '@hames/harness-patterns'
import { bamlPatterns, createLoopControllerAdapter } from '@hames/harness-baml'
import type { AgentData, AgentDefinition, AgentDeps } from '../types'

import { getGraphSchema } from './graph-schema.server'
import { NEO4J_FEW_SHOTS_DEFAULT } from './neo4j-fewshots.server'

import { assertServerOnImport } from '@hames/harness-patterns/assert.server'

// The 'use server' directive this file carried before the move was the only
// thing keeping its exports off the client; this is the real guard, and the
// reason stripping the directive removes nothing load-bearing.
assertServerOnImport()

async function createPatterns(
  sessionId: string,
  deps: AgentDeps,
): Promise<ConfiguredPattern<AgentData>[]> {
  const tools = await Tools({ namespaces: deps.toolNamespaces })
  const schema = await getGraphSchema('retriever-agent', sessionId, deps)
  const baml = bamlPatterns()

  // ── retriever route: vector search over this session's uploaded docs ──
  // Raw user message by default; rewritten to a search query only when the turn
  // has history (generateQuery).
  //
  // The backend factory is injected app-side wiring (the Data Stash). Its
  // absence is not a degraded composition — it is a misconfigured one — so
  // it fails loudly instead of silently building a retriever with nowhere to
  // search.
  if (!deps.createRedisBackend) {
    throw new Error(
      'retriever-agent requires deps.createRedisBackend — the composition root must supply it (AgentDeps)',
    )
  }
  const redisBackend = deps.createRedisBackend(sessionId)
  const retrieverPattern = retriever<AgentData>({
    patternId: 'retriever',
    backends: [redisBackend],
    k: 5,
    generateQuery: true,
    // Lane A6: the query rewrite is REQUIRED injected config now — the
    // describe-tier implementation comes from `harness-baml`.
    rewrite: baml.retrieveQuery,
    liveEvents: true,
  })

  // ── neo4j + web routes: identical to the default agent ──
  const webTools = tools.web ?? []

  // L14 (#225 Lane B3): each list appears exactly once, at the loop — it is
  // the allowlist AND what the controller advertises, via the seam.
  const neo4jPattern = simpleLoop<AgentData>(createLoopControllerAdapter(), tools.neo4j ?? [], {
    patternId: 'neo4j-query',
    schema,
    liveEvents: true,
    rememberPriorTurns: false,
    fewShots: NEO4J_FEW_SHOTS_DEFAULT,
    onToolResult: deps.enrichNeo4jResult,
  })

  const webPattern = simpleLoop<AgentData>(createLoopControllerAdapter(), webTools, {
    patternId: 'web-search',
    liveEvents: true,
    rememberPriorTurns: false,
  })

  const routerPattern = router<AgentData>(
    {
      retriever:
        "Answer from the user's uploaded documents (the Data Stash) — fast semantic search over ingested files",
      neo4j: 'Database queries and graph operations',
      web_search: 'Web lookups and information retrieval',
    },
    // The routing implementation is REQUIRED config, wired from `harness-baml`
    // at the composition root (BAML-companion seam lane) — core hosts no
    // default import.
    { liveEvents: true, route: baml.router },
  )

  // Two untrusted routes, guarded together. `web` is the obvious one; `retriever`
  // is the one that is easy to miss — Data Stash chunks come from INGESTED
  // DOCUMENTS (uploads, and ms-graph files via `graph_file_ingest`), so a
  // poisoned .docx reaches the response as a retrieved chunk. Retriever hits
  // never pass through `callTool`, so the retriever pattern sanitizes its own
  // hits at write-time through this same guard (see `sanitizeHits` in
  // retriever.server.ts). `neo4j` stays unguarded — our own graph.
  const routesPattern = withInjectionGuard({
    namespaces: ['web', 'retriever'],
    catalog: tools.all,
  })(
    routes<AgentData>(
      {
        // The retriever does its own context-scoped search, so it isn't wrapped
        // in `withReferences` (which injects prior tool_results) — unlike the
        // neo4j / web loops, which benefit from cross-turn reference curation.
        retriever: retrieverPattern,
        neo4j: withReferences<AgentData>(neo4jPattern, {
          scope: 'global',
          liveEvents: true,
          selector: baml.selector,
        }),
        web_search: withReferences<AgentData>(webPattern, {
          scope: 'global',
          liveEvents: true,
          selector: baml.selector,
        }),
      },
      { liveEvents: true },
    ),
  )

  const responseSynth = compactExecution<AgentData>({
    mode: 'thread',
    patternId: 'response-synth',
    liveEvents: true,
    synthesize: baml.synthesize,
  })

  return [routerPattern, routesPattern, responseSynth]
}

export const retrieverAgent: AgentDefinition = {
  id: 'retriever',
  name: 'Retriever Agent',
  description:
    'Fast semantic retrieval over uploaded documents (Data Stash), with Neo4j and Web Search routes',
  welcome:
    'Upload documents in the Data tab and I answer from them, with a citation ' +
    'back to the passage I used. I can also go to the knowledge graph or the web ' +
    'when the answer is not in your files.',
  servers: ['neo4j-cypher', 'web_search', 'fetch'],
  createPatterns,
}
