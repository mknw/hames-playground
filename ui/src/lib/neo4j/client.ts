/**
 * Neo4j Driver Client (Non-Agentic Layer)
 *
 * Direct neo4j-driver connection for operations that don't require BAML/UTCP:
 * - Schema fetching
 * - Manual Cypher queries from GraphVisualization
 *
 * Credential fallback: passed params → process.env → defaults
 *
 * Note: This module runs server-side only via "use server" functions.
 * Client-side localStorage credentials must be passed as parameters.
 */

import neo4j, { Driver } from 'neo4j-driver'
import { getEndpoints } from '../config/endpoints'

// ============================================================================
// Types
// ============================================================================

export interface Neo4jCredentials {
  user?: string
  password?: string
}

// ============================================================================
// Driver Management
// ============================================================================

let driver: Driver | null = null
let currentCredentials: { user: string; password: string } | null = null

/**
 * Get default credentials from environment or defaults
 */
function getDefaultCredentials(): { user: string; password: string } {
  return {
    user: process.env.NEO4J_USER || 'neo4j',
    password: process.env.NEO4J_PASSWORD || 'password',
  }
}

/**
 * Get or create the Neo4j driver singleton
 *
 * @param credentials - Optional credentials override (from client-side EnvVarManager)
 */
export function getNeo4jDriver(credentials?: Neo4jCredentials): Driver {
  const creds = {
    user: credentials?.user || getDefaultCredentials().user,
    password: credentials?.password || getDefaultCredentials().password,
  }

  // Check if we need to recreate the driver (credentials changed)
  const credentialsChanged =
    currentCredentials &&
    (currentCredentials.user !== creds.user || currentCredentials.password !== creds.password)

  if (credentialsChanged && driver) {
    // Close existing driver and recreate
    driver.close().catch(console.error)
    driver = null
  }

  if (!driver) {
    const endpoints = getEndpoints()
    driver = neo4j.driver(endpoints.neo4j.bolt, neo4j.auth.basic(creds.user, creds.password))
    currentCredentials = creds

    console.log('✅ Neo4j driver initialized')
    console.log(`   - URI: ${endpoints.neo4j.bolt}`)
    console.log(`   - User: ${creds.user}`)
  }

  return driver
}

/**
 * Reset the driver connection
 * Call this when credentials change to force reconnection
 */
export async function resetDriver(): Promise<void> {
  if (driver) {
    await driver.close()
    driver = null
    currentCredentials = null
    console.log('✅ Neo4j driver reset')
  }
}

/**
 * Verify driver connectivity
 */
export async function verifyConnection(credentials?: Neo4jCredentials): Promise<boolean> {
  try {
    const drv = getNeo4jDriver(credentials)
    await drv.verifyConnectivity()
    return true
  } catch (error) {
    console.error('Neo4j connection verification failed:', error)
    return false
  }
}
