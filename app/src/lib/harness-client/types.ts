/**
 * Harness Client - Types
 *
 * Shared types for harness client and UI components.
 */

import type { ElementDefinition } from 'cytoscape'

/**
 * Graph element with source tracking for tab filtering.
 */
export interface GraphElement extends ElementDefinition {
  /** Source of this graph element (for filtering by tab) */
  source?: 'neo4j' | 'memory' | 'unknown'
}
