/**
 * Shared `get_neo4j_schema` fetch for the agents whose Cypher-writing patterns
 * are primed with the graph's shape.
 *
 * There were three copies of this (default, general, retriever-agent) and only
 * one of them — general's — handled the failure. The other two returned `''` on
 * a Neo4j or gateway outage and then let `getOrBuildPatterns` CACHE that build,
 * freezing a schema-blind controller into the conversation for its whole life:
 * a transient outage during the first message cost every later message too
 * (sf-M6). This is that copy, hoisted.
 *
 * Two things have to happen on failure, and neither is optional:
 *
 *  1. WARN. `simpleLoop`'s prompt uses the schema to constrain Cypher and
 *     `planner.baml` tells the model to "only plan steps the listed tools can
 *     actually perform", so a silently empty schema shows up as worse output
 *     rather than as an error. `listTools` logs on the same principle.
 *  2. REFUSE THE CACHE. `doNotCachePatterns` keeps this (working, just blind)
 *     build for the current turn and makes the next message rebuild, retrying
 *     the fetch.
 */

import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { callTool } from '@hames-ai/harness-patterns'
import type { AgentDeps } from '../types'

assertServerOnImport()

/**
 * Best-effort graph schema as a JSON string, or `''` when it cannot be read.
 *
 * @param agentLabel  Agent id used as the log prefix, so the warning names the
 *                    agent whose turn ran blind.
 * @param sessionId   The session whose pattern build must not be cached when the
 *                    fetch fails.
 */
export async function getGraphSchema(
  agentLabel: string,
  sessionId: string,
  deps: AgentDeps,
): Promise<string> {
  const result = await callTool('get_neo4j_schema', {})
  if (result.success) return JSON.stringify(result.data)

  // Two things have to happen on failure, and neither is optional (the header
  // above): WARN, and REFUSE THE CACHE. The cache refusal is the host's
  // `doNotCachePatterns`, injected through `AgentDeps` — the pattern cache is
  // app-side state (the app's session.server), not package state. When a
  // consumer supplies no refusal hook, that fact is NAMED in the same warning
  // instead of the degradation going silent: a consumer that ignores it keeps
  // a schema-blind controller frozen for the conversation's whole life.
  console.warn(
    `[${agentLabel}] graph schema unavailable (${result.error ?? 'unknown error'}) — the ` +
      'controller runs without it this turn; patterns will be rebuilt on the next message.' +
      (deps.doNotCachePatterns
        ? ''
        : ' No doNotCachePatterns supplied via AgentDeps: without the refusal hook ' +
          'this degraded build may be CACHED schema-blind (sf-M6).'),
  )
  deps.doNotCachePatterns?.(sessionId)
  return ''
}
