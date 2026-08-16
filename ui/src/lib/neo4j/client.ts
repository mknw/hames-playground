/**
 * Neo4j Driver Client (Non-Agentic Layer)
 *
 * Direct neo4j-driver connection for operations that don't require BAML/UTCP:
 * - Schema fetching
 * - Manual Cypher queries from GraphVisualization
 *
 * Credentials come from the environment: process.env → defaults.
 *
 * Note: This module runs server-side only via "use server" functions.
 */

import neo4j, { Driver } from 'neo4j-driver'
import { getEndpoints } from '../config/endpoints'

// ============================================================================
// Driver Management
// ============================================================================

let driver: Driver | null = null

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
 */
export function getNeo4jDriver(): Driver {
  if (!driver) {
    const creds = getDefaultCredentials()
    const endpoints = getEndpoints()
    driver = neo4j.driver(endpoints.neo4j.bolt, neo4j.auth.basic(creds.user, creds.password))

    console.log('✅ Neo4j driver initialized')
    console.log(`   - URI: ${endpoints.neo4j.bolt}`)
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
