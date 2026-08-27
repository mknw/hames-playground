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
'use server'

// @unocss-include — the icon class literal below must be extracted (see uno.config content.filesystem)
import {
  router,
  routes,
  simpleLoop,
  retriever,
  compactExecution,
  withReferences,
  withInjectionGuard,
  Tools,
  createNeo4jController,
  createWebSearchController,
  type ConfiguredPattern,
} from '../../harness-patterns'
import type { SessionData } from '../session.server'
import type { AgentConfig } from '../registry.server'
import { getGraphSchema } from './graph-schema.server'
import { NEO4J_FEW_SHOTS_DEFAULT } from './neo4j-fewshots.server'
import { enrichNeo4jResult } from '../neo4j-enricher.server'
import { createRedisBackend } from '../../retriever'

async function createPatterns(sessionId: string): Promise<ConfiguredPattern<SessionData>[]> {
  const tools = await Tools()
  const schema = await getGraphSchema('retriever-agent', sessionId)

  // ── retriever route: vector search over this session's uploaded docs ──
  // Raw user message by default; rewritten to a search query only when the turn
  // has history (generateQuery).
  const redisBackend = createRedisBackend(sessionId)
  const retrieverPattern = retriever<SessionData>({
    patternId: 'retriever',
    backends: [redisBackend],
    k: 5,
    generateQuery: true,
    liveEvents: true,
  })

  // ── neo4j + web routes: identical to the default agent ──
  const neo4jController = createNeo4jController(tools.neo4j ?? [])
  const webTools = tools.web ?? []
  const webController = createWebSearchController(webTools)

  const neo4jPattern = simpleLoop<SessionData>(neo4jController, tools.neo4j ?? [], {
    patternId: 'neo4j-query',
    schema,
    liveEvents: true,
    rememberPriorTurns: false,
    fewShots: NEO4J_FEW_SHOTS_DEFAULT,
    onToolResult: enrichNeo4jResult,
  })

  const webPattern = simpleLoop<SessionData>(webController, webTools, {
    patternId: 'web-search',
    liveEvents: true,
    rememberPriorTurns: false,
  })

  const routerPattern = router<SessionData>(
    {
      retriever:
        "Answer from the user's uploaded documents (the Data Stash) — fast semantic search over ingested files",
      neo4j: 'Database queries and graph operations',
      web_search: 'Web lookups and information retrieval',
    },
    { liveEvents: true },
  )

  // Two untrusted routes, guarded together. `web` is the obvious one; `retriever`
  // is the one that is easy to miss — Data Stash chunks come from INGESTED
  // DOCUMENTS (uploads, and ms-graph files via `graph_file_ingest`), so a
  // poisoned .docx reaches the response as a retrieved chunk. Retriever hits
  // never pass through `callTool`, so the retriever pattern sanitizes its own
  // hits at write-time through this same guard (see `sanitizeHits` in
  // retriever.server.ts). `neo4j` stays unguarded — our own graph.
  const routesPattern = withInjectionGuard({ namespaces: ['web', 'retriever'] })(
    routes<SessionData>(
      {
        // The retriever does its own context-scoped search, so it isn't wrapped
        // in `withReferences` (which injects prior tool_results) — unlike the
        // neo4j / web loops, which benefit from cross-turn reference curation.
        retriever: retrieverPattern,
        neo4j: withReferences<SessionData>(neo4jPattern, { scope: 'global', liveEvents: true }),
        web_search: withReferences<SessionData>(webPattern, { scope: 'global', liveEvents: true }),
      },
      { liveEvents: true },
    ),
  )

  const responseSynth = compactExecution<SessionData>({
    mode: 'thread',
    patternId: 'response-synth',
    liveEvents: true,
  })

  return [routerPattern, routesPattern, responseSynth]
}

export const retrieverAgent: AgentConfig = {
  id: 'retriever',
  name: 'Retriever Agent',
  description:
    'Fast semantic retrieval over uploaded documents (Data Stash), with Neo4j and Web Search routes',
  welcome:
    'Upload documents in the Data tab and I answer from them, with a citation ' +
    'back to the passage I used. I can also go to the knowledge graph or the web ' +
    'when the answer is not in your files.',
  icon: 'i-material-symbols-document-search-outline',
  accent: 'violet',
  servers: ['neo4j-cypher', 'web_search', 'fetch'],
  createPatterns,
}
