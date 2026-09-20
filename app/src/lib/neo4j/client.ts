/**
 * Neo4j Driver Client (Non-Agentic Layer)
 *
 * Direct neo4j-driver connection for operations that don't require BAML/UTCP:
 * - Schema fetching
 * - Manual Cypher queries from GraphVisualization
 *
 * ## Configuration is explicit-first (design S5, #225 PR-3)
 * `configureNeo4j({ url, user, password })` is called once at app boot
 * (middleware.ts, the barrel import path) with `getEndpoints().neo4j.bolt` and
 * the env credentials. When configured, that config is used verbatim.
 *
 * ## The env fallback is PR-C1's transitional unset path (deliberate)
 * When `configureNeo4j` has not run, the driver falls back to reading
 * `getEndpoints()` + `NEO4J_USER`/`NEO4J_PASSWORD` — exactly the behavior this
 * module had before the seam, kept so PR-C1 is byte-identical: the standalone
 * org-graph scripts (`org-graph/scripts/*.ts`) use this client outside app
 * boot, and `client.test.ts` pins the env path. PR-C2 removes the fallback
 * INSIDE the package and adds the named unset error at first use; the app then
 * keeps its env path for the org-graph scripts. Do not remove the fallback
 * app-side before that split exists.
 *
 * Note: This module runs server-side only via "use server" functions.
 */

import neo4j, { Driver } from 'neo4j-driver'
import { getEndpoints } from '../config/endpoints'

// ============================================================================
// Driver Management
// ============================================================================

/** Explicit connection config, set once at app boot (design S5). */
export interface Neo4jConfig {
  /** Bolt URI, e.g. `bolt://localhost:7687` (`getEndpoints().neo4j.bolt`). */
  url: string
  user: string
  password: string
}

let config: Neo4jConfig | null = null
let driver: Driver | null = null

/**
 * Configure the Neo4j connection explicitly (design S5, #225 PR-3).
 *
 * Called once at app boot — `middleware.ts`, beside the app-tools barrel
 * import — with `getEndpoints().neo4j.bolt` and the same env credentials the
 * fallback reads. Later calls win: the live driver is dropped so the next
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
 * Get default credentials from environment or defaults — the PR-C1
 * transitional unset path (see the module header).
 */
function getDefaultCredentials(): { user: string; password: string } {
  return {
    user: process.env.NEO4J_USER || 'neo4j',
    password: process.env.NEO4J_PASSWORD || 'password',
  }
}

/**
 * Get or create the Neo4j driver singleton
 */
export function getNeo4jDriver(): Driver {
  if (!driver) {
    const endpoints = getEndpoints()
    // Explicit boot config wins (S5); the env fallback only serves callers
    // outside app boot (org-graph scripts) in PR-C1 — see the module header.
    const creds = config ?? {
      url: endpoints.neo4j.bolt,
      ...getDefaultCredentials(),
    }
    driver = neo4j.driver(creds.url, neo4j.auth.basic(creds.user, creds.password))

    console.log('✅ Neo4j driver initialized')
    console.log(`   - URI: ${creds.url}`)
    console.log(`   - User: ${creds.user}`)
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
