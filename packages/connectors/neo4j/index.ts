/**
 * Neo4j Module (Non-Agentic Layer)
 *
 * Exports direct Neo4j driver functionality for operations that don't require BAML/UTCP:
 * - Schema fetching
 * - Manual Cypher queries from graph visualizations
 * - Connection management
 *
 * The host's `'use server'` wrappers (which gate every export on an
 * authenticated caller before delegating here) live in the host app at the
 * paths its clients already import.
 */

// Client
export {
  getNeo4jDriver,
  resetDriver,
  verifyConnection,
  configureNeo4j,
  Neo4jNotConfiguredError,
  type Neo4jConfig,
} from './client'

// Query ops (identity-free — the host gates them)
export {
  getSchema,
  getSimplifiedSchema,
  runManualCypher,
  resetNeo4jConnection,
  testNeo4jConnection,
  type SchemaResult,
  type CypherResult,
  type ConnectionResult,
} from './queries'
