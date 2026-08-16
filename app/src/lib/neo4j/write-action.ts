/**
 * Neo4j Write Action
 *
 * Server action for executing parameterized Cypher write queries
 * from the graph visualization UI (node edits, relation creation).
 */

"use server"

import { getNeo4jDriver } from './client'

/**
 * Execute a parameterized Cypher write query.
 *
 * @param cypher - Cypher query with $param placeholders
 * @param params - Parameter values
 */
export async function executeCypherWrite(
  cypher: string,
  params?: Record<string, unknown>
): Promise<void> {
  const session = getNeo4jDriver().session()
  try {
    await session.run(cypher, params ?? {})
  } finally {
    await session.close()
  }
}
