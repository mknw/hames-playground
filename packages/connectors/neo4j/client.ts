/**
 * Neo4j Driver Client (Non-Agentic Layer)
 *
 * Direct neo4j-driver connection for operations that don't require BAML/UTCP:
 * - Schema fetching
 * - Manual Cypher queries from a graph visualization
 *
 * ## Configuration is explicit-only (design S5, #225 PR-3)
 * `configureNeo4j({ url, user, password })` is called by the HOST — at app
 * boot in `middleware.ts`, or explicitly by a standalone script — before the
 * first `getNeo4jDriver()`. There is NO env fallback in the package, on
 * purpose: a client that silently guessed a connection would send a
 * deployment's data at whatever the ambient environment happened to name.
 * Unset config is a NAMED error at first use (`Neo4jNotConfiguredError`),
 * never a default — the C1-deferred work the peel disclosed.
 *
 * Note: This module runs server-side only; the ops that consume it carry the
 * `assertServerOnImport()` guard.
 */

import neo4j, { Driver } from 'neo4j-driver'

// ============================================================================
// Driver Management
// ============================================================================

/** Explicit connection config, set by the host (design S5). */
export interface Neo4jConfig {
  /** Bolt URI, e.g. `bolt://localhost:7687`. */
  url: string
  user: string
  password: string
}

/**
 * The driver was used before `configureNeo4j()` ran — a NAMED error at first
 * use rather than a default, so a misconfigured deployment fails loudly at
 * the first query instead of connecting to a guessed endpoint.
 */
export class Neo4jNotConfiguredError extends Error {
  constructor() {
    super(
      'Neo4j is not configured: call configureNeo4j({ url, user, password }) ' +
        'before the first getNeo4jDriver(). The package deliberately has no env ' +
        'fallback — the host owns the connection details.',
    )
    this.name = 'Neo4jNotConfiguredError'
  }
}

let config: Neo4jConfig | null = null
let driver: Driver | null = null

/**
 * Configure the Neo4j connection explicitly (design S5).
 *
 * Called once by the host — app boot (`middleware.ts`) or a standalone
 * script's entry — with the bolt URI and credentials the host resolved.
 * Later calls win: the live driver is dropped so the next
 * `getNeo4jDriver()` reconnects with the new config (and `resetDriver` keeps
 * its "next call reconnects" contract).
 */
export function configureNeo4j(next: Neo4jConfig): void {
  if (!next || typeof next.url !== 'string' || !next.url.trim()) {
    throw new Error('configureNeo4j: a non-empty bolt url is required')
  }
  config = next
  driver = null
}

/**
 * Get or create the Neo4j driver singleton. Throws
 * {@link Neo4jNotConfiguredError} when no explicit config was handed over.
 */
export function getNeo4jDriver(): Driver {
  if (!driver) {
    if (!config) throw new Neo4jNotConfiguredError()
    driver = neo4j.driver(config.url, neo4j.auth.basic(config.user, config.password))

    console.log('✅ Neo4j driver initialized')
    console.log(`   - URI: ${config.url}`)
    console.log(`   - User: ${config.user}`)
  }

  return driver
}

/**
 * Reset the driver connection
 * Closes the singleton so the next call reconnects
 */
export async function resetDriver(): Promise<void> {
  if (driver) {
    await driver.close()
    driver = null
    console.log('✅ Neo4j driver reset')
  }
}

/**
 * Verify driver connectivity
 */
export async function verifyConnection(): Promise<boolean> {
  try {
    const drv = getNeo4jDriver()
    await drv.verifyConnectivity()
    return true
  } catch (error) {
    console.error('Neo4j connection verification failed:', error)
    return false
  }
}
