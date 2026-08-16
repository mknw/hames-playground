/**
 * Shared Types for UI Components
 */

/**
 * Tool call information for UI display
 * Used by ToolCallDisplay and ChatMessages components
 */
export interface ToolCallInfo {
  type: 'neo4j' | 'web_search' | 'fetch' | 'code_mode'
  status: 'pending' | 'executed' | 'error'
  tool: string
  cypher?: string
  explanation?: string
  isReadOnly?: boolean
  result?: {
    nodeCount?: number
    relationshipCount?: number
    raw?: unknown
  }
  error?: string
}
