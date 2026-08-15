/**
 * Neo4j Module (Non-Agentic Layer)
 *
 * Exports direct Neo4j driver functionality for operations that don't require BAML/UTCP:
 * - Schema fetching
 * - Manual Cypher queries from GraphVisualization
 * - Connection management
 */

// Client
export { getNeo4jDriver, resetDriver, verifyConnection, type Neo4jCredentials } from './client'

// Server functions
export {
  getSchema,
  getSimplifiedSchema,
  runManualCypher,
  executeWriteCypher,
  resetNeo4jConnection,
  testNeo4jConnection,
  type SchemaResult,
  type CypherResult,
  type ConnectionResult,
} from './queries'
